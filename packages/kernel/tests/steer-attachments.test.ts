// steer-attachments.test.ts — 引导消息（steer）链路附件透传验证
//
// 背景 bug：Ctrl+Enter 发引导消息（运行中无活跃引导时）只传纯文本，
// 输入框附件全链路丢失。pi 引擎 steer(message, images) 原生支持 images，
// wa-pi 接线（前端 → 路由 → ws → steerMessage → steerList → client.steer）未透传。
//
// 用例覆盖 kernel 侧 steerMessage 的四个分支 + 队列转发契约：
// - busy 直投：附件经 buildPromptContent 转 images，随 client.steer 发出
// - busy 已有引导：第二条转 followUpList，entry 带 images，settled drain 时随 prompt 发出
// - 空闲直发：随 _sendPromptNow → client.prompt 发出
// - 排队消息提升为引导：images 从 followUpList entry 继承，不丢失
// - queue_update 转发给前端的 steering 仍为 string[]（前端契约不变）
import { test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentManager } from "../src/agent-manager";
import { ProjectStore } from "../src/project-store";
import {
  type FakeSessionClient,
  fakeClientFactory,
} from "./fixtures/fake-session-client";
import { NOOP_BROWSER_MANAGER } from "./helpers/fake-browser-manager";
import { askRegistry } from "../src/ask-registry";
import { WA_PI_DIR } from "@wa-pi/shared";

const MODEL = "anthropic/test-model";

const tmpFiles: string[] = [];
const tmpDirs: string[] = [];
const managers: AgentManager[] = [];

beforeEach(() => {
  askRegistry.reset();
});

afterEach(async () => {
  for (const am of managers.splice(0)) await am.disposeAll().catch(() => {});
  for (const f of tmpFiles.splice(0)) {
    try {
      rmSync(f, { force: true });
    } catch {
      /* 清理失败不阻断 */
    }
  }
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 清理失败不阻断 */
    }
  }
});

type CapturedEvent = { sessionId: string; e: any };

async function setup(events?: CapturedEvent[]) {
  const tmpFile = `/tmp/wa-pi-steer-att-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.json`;
  tmpFiles.push(tmpFile);
  const projectStore = new ProjectStore(tmpFile);
  const project = await projectStore.createProject({
    name: "测试",
    cwd: "/tmp",
  });
  const session = await projectStore.createSession({
    projectId: project.id,
    primaryAgent: "dev",
    title: "测试",
  });
  tmpFiles.push(join(WA_PI_DIR, "tmp", "sysprompts", `${session.id}.md`));

  const fakes: FakeSessionClient[] = [];
  const am = new AgentManager({
    projectStore,
    configStore: null,
    onEvent: (sid, _pid, _name, e) => events?.push({ sessionId: sid, e }),
    createClientFn: fakeClientFactory(fakes),
    browserManager: NOOP_BROWSER_MANAGER,
  });
  managers.push(am);
  await am.ensureStarted(project.id, "dev", session.id);
  return { project, session, am, fake: fakes[0] };
}

const flushDrain = () => new Promise((r) => setTimeout(r, 0));

/** 造一个真实存在的临时图片文件（内容为最小 PNG 头，readImageContent 只要求文件可读） */
function makeTmpPng(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "wa-pi-steer-img-"));
  tmpDirs.push(dir);
  const path = join(dir, "shot.png");
  // 最小 PNG 签名头（不必是合法图片，readImageContent 仅 stat + readFile）
  writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return { path, cleanup: () => {} };
}

test("busy 直投：steerMessage 带附件 → client.steer 收到 path: 引用文本 + images", async () => {
  const { session, am, fake } = await setup();
  fake.autoSettle = false;
  await am.prompt(session.id, "进行中", { model: MODEL }); // busy
  fake.steered = [];
  fake.steerImages = [];

  const img = makeTmpPng();
  await am.steerMessage(session.id, "看这张图", {
    attachments: [
      { kind: "image", name: "shot.png", path: img.path, size: 8 },
      { kind: "snippet", name: "note", content: "附加说明" },
    ],
  });

  expect(fake.steered.length).toBe(1);
  // 文本含附件引用与片段内联
  expect(fake.steered[0]).toContain("看这张图");
  expect(fake.steered[0]).toContain(`path:${img.path.replace(/\\/g, "/")}`);
  expect(fake.steered[0]).toContain("[片段: note]");
  // 图片随 steer 作为多模态 images 发出
  expect(fake.steerImages[0].length).toBe(1);
  expect(fake.steerImages[0][0].type).toBe("image");
});

test("busy 已有引导：第二条带附件转 followUpList，settled drain 时随 prompt 发出", async () => {
  const { session, am, fake } = await setup();
  fake.autoSettle = false;
  await am.prompt(session.id, "进行中", { model: MODEL }); // busy
  await am.steerMessage(session.id, "引导1"); // 占住引导位

  const img = makeTmpPng();
  await am.steerMessage(session.id, "引导2", {
    attachments: [{ kind: "image", name: "shot.png", path: img.path, size: 8 }],
  });
  await flushDrain();
  // 一次只允许一条引导：直调 steer 的仍只有引导1，引导2 不得再直调
  expect(fake.steered.length).toBe(1);
  expect(fake.steered[0]).toContain("引导1");

  // settled → drain steerList（引导1），再下一次 settled → drain followUpList（引导2+图）
  fake.emit({ type: "agent_settled" });
  await flushDrain();
  expect(fake.prompted.length).toBe(2); // 「进行中」+ 引导1
  fake.emit({ type: "agent_settled" });
  await flushDrain();
  expect(fake.prompted.length).toBe(3);
  // 引导2 的文本带 path: 引用，images 随 prompt 发出
  expect(fake.prompted[2]).toContain("引导2");
  expect(fake.promptImages[2].length).toBe(1);
});

test("空闲直发：steerMessage 带附件 → 走 prompt，images 随请求发出", async () => {
  const { session, am, fake } = await setup();
  fake.autoSettle = false;

  const img = makeTmpPng();
  await am.steerMessage(session.id, "空闲引导", {
    attachments: [{ kind: "image", name: "shot.png", path: img.path, size: 8 }],
  });

  expect(fake.prompted.length).toBe(1);
  expect(fake.prompted[0]).toContain("空闲引导");
  expect(fake.promptImages[0].length).toBe(1);
  expect(fake.steered.length).toBe(0);
});

test("排队消息提升为引导：images 从 followUpList entry 继承", async () => {
  const events: CapturedEvent[] = [];
  const { session, am, fake } = await setup(events);
  fake.autoSettle = false;
  const img = makeTmpPng();
  // busy 时带图 prompt → 入 followUpList（不入 client）
  await am.prompt(session.id, "进行中", { model: MODEL });
  await am.prompt(session.id, "排队消息", {
    model: MODEL,
    attachments: [{ kind: "image", name: "shot.png", path: img.path, size: 8 }],
  });
  expect(fake.prompted).toEqual(["进行中"]);

  // 前端从 queue_update 拿到的排队文本是 kernel 处理后的 finalText（含 path: 引用），
  // 提升时回传该文本（前端队列里只有文本，无附件数据）
  const lastQueue = [...events]
    .reverse()
    .find((x) => x.e.type === "queue_update");
  const queuedText = (lastQueue!.e as any).followUp[0] as string;
  expect(queuedText).toContain("排队消息");

  await am.steerMessage(session.id, queuedText);
  await flushDrain();

  // 直投 steer，images 继承自排队 entry
  expect(fake.steered.length).toBe(1);
  expect(fake.steerImages[0].length).toBe(1);

  // settled 后：fake 不模拟 pi 消费 steer（不发 queue_update 清 steerList），
  // 触发 steerList 兕底 drain 重发为 prompt —— 验证兕底路径同样不丢附件
  fake.emit({ type: "agent_settled" });
  await flushDrain();
  expect(fake.prompted.length).toBe(2);
  expect(fake.prompted[1]).toContain("排队消息");
  expect(fake.promptImages[1].length).toBe(1);
});

test("queue_update 契约：转发给前端的 steering 仍为 string[]（带图引导不破坏前端类型）", async () => {
  const events: CapturedEvent[] = [];
  const { session, am, fake } = await setup(events);
  fake.autoSettle = false;
  await am.prompt(session.id, "进行中", { model: MODEL }); // busy

  const img = makeTmpPng();
  await am.steerMessage(session.id, "带图引导", {
    attachments: [{ kind: "image", name: "shot.png", path: img.path, size: 8 }],
  });
  await flushDrain();

  const lastQueue = [...events]
    .reverse()
    .find((x) => x.e.type === "queue_update");
  expect(lastQueue).toBeDefined();
  const steering = (lastQueue!.e as any).steering;
  expect(Array.isArray(steering)).toBe(true);
  expect(steering.every((s: unknown) => typeof s === "string")).toBe(true);
  expect(steering).toHaveLength(1);
  expect(steering[0]).toContain("带图引导");
});
