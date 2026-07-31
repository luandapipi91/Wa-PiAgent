// packages/kernel/tests/session-history.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readSessionHistory } from "../src/session-history";

let dir: string;
beforeEach(() => {
  dir = join(import.meta.dir, ".tmp-sh-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function msg(id: string, parentId: string | null, role: string, text: string, ts: number): string {
  return JSON.stringify({
    type: "message", id, parentId, timestamp: new Date(ts).toISOString(),
    message: { role, content: [{ type: "text", text }], timestamp: ts },
  });
}

test("线性历史：按序返回当前分支全部消息", async () => {
  const file = join(dir, "s.jsonl");
  writeFileSync(file, [
    JSON.stringify({ type: "session", version: 3, id: "uuid-1", timestamp: "2026-01-01T00:00:00Z" }),
    JSON.stringify({ type: "model_change", id: "mc1", parentId: null, timestamp: "2026-01-01T00:00:01Z" }),
    msg("m1", "mc1", "user", "问题一", 1),
    msg("m2", "m1", "assistant", "回答一", 2),
    msg("m3", "m2", "user", "问题二", 3),
    msg("m4", "m3", "assistant", "回答二", 4),
    JSON.stringify({ type: "session_info", id: "si1", parentId: "m4", timestamp: "2026-01-01T00:00:05Z" }),
  ].join("\n") + "\n");

  const history = (await readSessionHistory(file)) as any[];
  expect(history.map(m => m.content[0].text)).toEqual(["问题一", "回答一", "问题二", "回答二"]);
});

test("分支历史：只返回当前分支（末尾叶子所在链），不含被 retry 替换的旧分支", async () => {
  const file = join(dir, "s.jsonl");
  writeFileSync(file, [
    JSON.stringify({ type: "session", version: 3, id: "uuid-1" }),
    msg("m1", null, "user", "问题", 1),
    msg("m2", "m1", "assistant", "旧回答", 2),   // 旧分支
    msg("m3", "m1", "assistant", "新回答", 3),   // retry 产生的新分支（文件末尾=当前分支）
  ].join("\n"));

  const history = (await readSessionHistory(file)) as any[];
  expect(history.map(m => m.content[0].text)).toEqual(["问题", "新回答"]);
});

test("坏行容错：非法 JSON 行跳过，不影响其余消息", async () => {
  const file = join(dir, "s.jsonl");
  writeFileSync(file, [
    msg("m1", null, "user", "问题", 1),
    '{"type":"message","id":"broken"',  // 截断坏行
    msg("m2", "m1", "assistant", "回答", 2),
  ].join("\n"));

  const history = (await readSessionHistory(file)) as any[];
  expect(history).toHaveLength(2);
});

test("文件不存在：抛错（调用方回退进程路径）", async () => {
  await expect(readSessionHistory(join(dir, "nope.jsonl"))).rejects.toThrow();
});

test("空文件/无有效行：抛错", async () => {
  const file = join(dir, "empty.jsonl");
  writeFileSync(file, "\n\n  \n");
  await expect(readSessionHistory(file)).rejects.toThrow(/无有效行/);
});

test("无消息的合法文件：返回空数组（新会话）", async () => {
  const file = join(dir, "fresh.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "uuid-1" }) + "\n");
  expect(await readSessionHistory(file)).toEqual([]);
});

test("悬挂 ask：无 toolResult 的 ask_user_question 注入 cancelled 对账", async () => {
  const file = join(dir, "s.jsonl");
  writeFileSync(file, [
    msg("m1", null, "user", "问题", 1),
    JSON.stringify({
      type: "message", id: "m2", parentId: "m1", timestamp: "2026-01-01T00:00:02Z",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "ask-1", name: "ask_user_question", arguments: {} }],
        timestamp: 2,
      },
    }),
  ].join("\n"));

  const history = (await readSessionHistory(file)) as any[];
  const cancelled = history.find(m => m.role === "toolResult" && m.toolCallId === "ask-1");
  expect(cancelled).toBeTruthy();
  expect(cancelled.toolName).toBe("ask_user_question");
});

// 网络类错误消息过滤：transient error（Connection error / timeout）在历史回读时被剔除，
// 不再进对话流；fatal error（鉴权失败 / 配额耗尽）保留，需提示用户改配置。
function errMsg(id: string, parentId: string | null, errorMessage: string, ts: number): string {
  return JSON.stringify({
    type: "message", id, parentId, timestamp: new Date(ts).toISOString(),
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage,
      timestamp: ts,
    },
  });
}

test("历史过滤：transient error（Connection error.）被剔除，不进对话流", async () => {
  const file = join(dir, "s.jsonl");
  writeFileSync(file, [
    msg("m1", null, "user", "问题", 1),
    errMsg("m2", "m1", "Connection error.", 2),
  ].join("\n"));

  const history = (await readSessionHistory(file)) as any[];
  // transient error 应被过滤掉，只剩用户消息
  expect(history).toHaveLength(1);
  expect(history[0].role).toBe("user");
});

test("历史过滤：transient error（Request timed out.）被剔除", async () => {
  const file = join(dir, "s.jsonl");
  writeFileSync(file, [
    msg("m1", null, "user", "问题", 1),
    errMsg("m2", "m1", "Request timed out.", 2),
  ].join("\n"));

  const history = (await readSessionHistory(file)) as any[];
  expect(history).toHaveLength(1);
  expect(history[0].role).toBe("user");
});

test("历史保留：fatal error（401 Unauthorized）不被剔除，需提示用户", async () => {
  const file = join(dir, "s.jsonl");
  writeFileSync(file, [
    msg("m1", null, "user", "问题", 1),
    errMsg("m2", "m1", "401 Unauthorized", 2),
  ].join("\n"));

  const history = (await readSessionHistory(file)) as any[];
  expect(history).toHaveLength(2);
  expect(history[1].stopReason).toBe("error");
  expect(history[1].errorMessage).toBe("401 Unauthorized");
});

test("历史保留：fatal error（insufficient_quota）不被剔除", async () => {
  const file = join(dir, "s.jsonl");
  writeFileSync(file, [
    msg("m1", null, "user", "问题", 1),
    errMsg("m2", "m1", "insufficient_quota", 2),
  ].join("\n"));

  const history = (await readSessionHistory(file)) as any[];
  expect(history).toHaveLength(2);
});

test("历史混合：transient 被剔除，fatal 保留，正常消息不受影响", async () => {
  const file = join(dir, "s.jsonl");
  writeFileSync(file, [
    msg("m1", null, "user", "问题一", 1),
    errMsg("m2", "m1", "Connection error.", 2),       // transient → 剔除
    msg("m3", "m2", "user", "问题二", 3),
    errMsg("m4", "m3", "401 Unauthorized", 4),         // fatal → 保留
    msg("m5", "m4", "assistant", "回答", 5),
  ].join("\n"));

  const history = (await readSessionHistory(file)) as any[];
  // 应为：问题一 / 问题二 / 401错误 / 回答（transient 的 m2 被剔除）
  expect(history).toHaveLength(4);
  expect(history.find(m => m.errorMessage === "Connection error.")).toBeUndefined();
  expect(history.find(m => m.errorMessage === "401 Unauthorized")).toBeTruthy();
});

// ========== 失败回合去重（重发场景）==========
//
// 根因：重发失败消息时 pi 每次都 append 进 jsonl，刷新后出现多条相同的 user
// 发送记录。dedupeConsecutiveFailedTurns 把连续的失败对折叠到只剩最后一组，
// 既消除重发堆积，又保留最后一组的 fatal error 提示。

test("重发去重：连续3次失败回合，只保留最后一组 user+error", async () => {
  const file = join(dir, "s.jsonl");
  writeFileSync(file, [
    msg("m1", null, "user", "123", 1),
    errMsg("m2", "m1", "404 Not Found", 2),
    msg("m3", "m2", "user", "123", 3),    // 重发
    errMsg("m4", "m3", "404 Not Found", 4),
    msg("m5", "m4", "user", "123", 5),    // 再次重发
    errMsg("m6", "m5", "404 Not Found", 6),
  ].join("\n"));

  const history = (await readSessionHistory(file)) as any[];
  // 3 组失败回合 → 去重后只剩最后 1 组（user + error）
  expect(history).toHaveLength(2);
  expect(history[0].role).toBe("user");
  expect(history[0].content[0].text).toBe("123");
  expect(history[1].stopReason).toBe("error");
});

test("重发去重：连续失败后最终成功，只保留成功回合", async () => {
  const file = join(dir, "s.jsonl");
  writeFileSync(file, [
    msg("m1", null, "user", "hi", 1),
    errMsg("m2", "m1", "404 Not Found", 2),   // 失败
    msg("m3", "m2", "user", "hi", 3),          // 重发
    errMsg("m4", "m3", "404 Not Found", 4),   // 又失败（连续 → 折叠前一组）
    msg("m5", "m4", "user", "hi", 5),          // 再次重发
    msg("m6", "m5", "assistant", "成功了", 6), // 这次成功
  ].join("\n"));

  const history = (await readSessionHistory(file)) as any[];
  // 前两组失败回合被折叠，只剩最后一次成功的 user + assistant
  expect(history).toHaveLength(2);
  expect(history[0].content[0].text).toBe("hi");
  expect(history[1].content[0].text).toBe("成功了");
});

test("非连续失败回合不去重：中间隔着成功对话的失败各自保留", async () => {
  const file = join(dir, "s.jsonl");
  writeFileSync(file, [
    msg("m1", null, "user", "问题一", 1),
    errMsg("m2", "m1", "401 Unauthorized", 2),  // 失败回合 A
    msg("m3", "m2", "user", "问题二", 3),
    msg("m4", "m3", "assistant", "回答二", 4),   // 成功对话（隔断）
    msg("m5", "m4", "user", "问题三", 5),
    errMsg("m6", "m5", "403 Forbidden", 6),     // 失败回合 B（非连续，保留）
  ].join("\n"));

  const history = (await readSessionHistory(file)) as any[];
  // 两组失败回合中间有成功对话，不连续 → 都保留
  expect(history).toHaveLength(6);
});

test("单次失败回合不去重：保留 fatal error 提示用户", async () => {
  const file = join(dir, "s.jsonl");
  writeFileSync(file, [
    msg("m1", null, "user", "问题", 1),
    errMsg("m2", "m1", "404 Not Found", 2),
  ].join("\n"));

  const history = (await readSessionHistory(file)) as any[];
  // 只有一组失败回合，无后续重发 → 保留（fatal error 需提示用户）
  expect(history).toHaveLength(2);
  expect(history[1].stopReason).toBe("error");
});
