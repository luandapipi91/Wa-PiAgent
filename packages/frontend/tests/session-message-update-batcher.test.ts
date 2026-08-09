// message_update 经 StreamingBatcher rAF 合帧的存储级测试（阶段二·卡顿修复 3.1）。
// 接线前：每个 delta 同步 set()；接线后：同帧 delta 合并为一帧提交（取最新），
// message_end 定稿不受挂起帧影响（event.message 权威）。
import { test, expect, beforeEach } from "bun:test";
import { useSessionStore } from "../src/store/session";

// batcher 用 requestAnimationFrame 合帧（happy-dom 下 rAF 为宏任务），嵌套两帧确保冲刷
const flushFrames = () =>
  new Promise<void>((resolve) => {
    const raf: (fn: () => void) => void =
      globalThis.requestAnimationFrame ?? ((fn) => setTimeout(fn, 16) as any);
    raf(() => raf(() => resolve()));
  });

const startEnv = {
  event: {
    type: "message_start",
    message: { role: "assistant", content: [], model: "m", timestamp: 1 },
  },
  agentName: "dev",
} as any;

const updateEnv = (delta: string) =>
  ({
    event: {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
    },
    agentName: "dev",
  }) as any;

beforeEach(() => {
  useSessionStore.setState({
    messagesBySession: {},
    streamingBySession: {},
    statusBySession: {},
  });
});

test("同帧多个 text_delta 不逐条同步提交，帧末一次性提交且全部累积", async () => {
  const h = useSessionStore.getState().handleSDKEvent;
  h("s1", startEnv);
  // message_start 首帧仍同步可见
  expect(useSessionStore.getState().streamingBySession["s1"]).toBeTruthy();
  h("s1", updateEnv("你"));
  h("s1", updateEnv("好"));
  h("s1", updateEnv("啊"));
  // 合帧中：store 仍是 message_start 的骨架（content 空）
  const pending = useSessionStore.getState().streamingBySession["s1"]!.message as any;
  expect(pending.content).toHaveLength(0);
  await flushFrames();
  const committed = useSessionStore.getState().streamingBySession["s1"]!.message as any;
  expect(committed.content[0]).toEqual({ type: "text", text: "你好啊" });
});

test("message_end 定稿丢弃挂起帧：权威消息进 messages，旧 partial 不复活", async () => {
  const h = useSessionStore.getState().handleSDKEvent;
  h("s1", startEnv);
  h("s1", updateEnv("旧增量"));
  h("s1", {
    event: {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "权威定稿" }],
        model: "m",
        stopReason: "end_turn",
        timestamp: 2,
      },
    },
    agentName: "dev",
  } as any);
  await flushFrames();
  const s = useSessionStore.getState();
  expect(s.streamingBySession["s1"]).toBeNull();
  const msgs = s.messagesBySession["s1"];
  const text = (msgs[msgs.length - 1].message as any).content[0].text;
  expect(text).toBe("权威定稿"); // 不含 "旧增量"
});

test("setActiveStatus(false) 复位丢弃挂起帧：streaming 保持 null，旧 partial 不复活", async () => {
  const h = useSessionStore.getState().handleSDKEvent;
  h("s1", startEnv);
  h("s1", updateEnv("旧增量")); // delta 挂起，rAF 已调度
  // 同帧内 setActiveStatus(false) 复位（SSE 断线对齐路径）
  useSessionStore.getState().setActiveStatus("s1", false);
  expect(useSessionStore.getState().streamingBySession["s1"]).toBeNull();
  // 下一帧 flush 不得把挂起的旧 partial 提交回来
  await flushFrames();
  expect(useSessionStore.getState().streamingBySession["s1"]).toBeNull();
});
