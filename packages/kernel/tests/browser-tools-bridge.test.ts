// browser-tools-bridge.test.ts —— AgentManager 接线 browser_* 工具的测试：
// 验证 bridgeCtx.handleTool 的 browser_* 分派、_teardownSession 与 disposeAll 的生命周期接线。
//
// 构造模式仿 agent-manager-subagent-overrides.test.ts（projectStore + configStore +
// onEvent + createClientFn: fakeClientFactory），并注入 fake BrowserManager 捕获调用轨迹。
import { test, expect, afterEach } from "bun:test";
import { AgentManager } from "../src/agent-manager";
import { ProjectStore } from "../src/project-store";
import { FakeSessionClient, fakeClientFactory } from "./fixtures/fake-session-client";
import { getBridgeSession } from "../src/bridge-registry";
import type { BrowserManager, BrowserViewState, WebViewLike } from "../src/browser-manager";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { WA_PI_DIR } from "@wa-pi/shared";

/** fake WebView：记录 navigate 调用（仿 browser-manager.test.ts 的 makeFakeView） */
function makeFakeView(navigatedUrls: string[]): WebViewLike {
  return {
    url: "about:blank",
    title: "",
    loading: false,
    async navigate(url: string) {
      navigatedUrls.push(url);
      (this as { url: string }).url = url;
    },
    async evaluate() { return undefined; },
    async click() {},
    async type() {},
    async press() {},
    async scroll() {},
    async scrollTo() {},
    async screenshot() { return new Blob(["png"]); },
    close() {},
  };
}

interface FakeBrowserManager {
  getOrCreateSessions: string[];
  navigatedUrls: string[];
  closedSessions: string[];
  disposeCount: number;
  manager: BrowserManager;
}

/** 构造记录调用轨迹的 fake BrowserManager（鸭子类型 + double cast，同 fakeClientFactory 惯例）。
 *  注意：disposeCount 用 getter 实时读闭包 state——若展开时值拷贝，调用方读到的是初始快照
 *  （测试 3 的 disposeCount 就因此一度断言失败）。数组本身是引用，直接共享。 */
function makeFakeBrowserManager(): FakeBrowserManager {
  const state = {
    getOrCreateSessions: [] as string[],
    navigatedUrls: [] as string[],
    closedSessions: [] as string[],
    disposeCount: 0,
  };
  const manager = {
    getScreenshotDir: () => "/tmp",
    get: () => undefined,
    async getOrCreate(sessionId: string): Promise<BrowserViewState> {
      state.getOrCreateSessions.push(sessionId);
      return { view: makeFakeView(state.navigatedUrls), sessionId, createdAt: 0, lastUsedAt: 0 };
    },
    closeSession(sessionId: string) { state.closedSessions.push(sessionId); },
    sweepIdle() {},
    dispose() { state.disposeCount++; },
  } as unknown as BrowserManager;
  return {
    get getOrCreateSessions() { return state.getOrCreateSessions; },
    get navigatedUrls() { return state.navigatedUrls; },
    get closedSessions() { return state.closedSessions; },
    get disposeCount() { return state.disposeCount; },
    manager,
  };
}

const tmpFiles: string[] = [];
const managers: AgentManager[] = [];

afterEach(async () => {
  for (const am of managers.splice(0)) await am.disposeAll().catch(() => {});
  for (const f of tmpFiles.splice(0)) {
    try { rmSync(f, { force: true }); } catch {}
  }
});

function newProjectStore() {
  const tmpFile = `/tmp/wa-pi-browser-bridge-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
  tmpFiles.push(tmpFile);
  return new ProjectStore(tmpFile);
}

/** 构造已 ensureStarted 的 AgentManager（注入 fake browserManager），返回 am 与会话 */
async function newStartedManager(fake: FakeBrowserManager) {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  const configStore = {
    getAgent: async () => ({ displayName: "dev", partners: { askTo: [] } }),
  } as any;

  const fakes: FakeSessionClient[] = [];
  const am = new AgentManager({
    projectStore, configStore, onEvent: () => {},
    createClientFn: fakeClientFactory(fakes),
    browserManager: fake.manager,
  });
  managers.push(am);
  await am.ensureStarted(project.id, "dev", session.id);
  return { am, session };
}

test("handleTool 分派 browser_navigate 到注入的 fake browserManager", async () => {
  const fake = makeFakeBrowserManager();
  const { session } = await newStartedManager(fake);

  const ctx = getBridgeSession(session.id);
  expect(ctx).toBeDefined();
  const result = await ctx!.handleTool(
    "browser_navigate", "tc-1", { url: "about:blank" }, new AbortController().signal,
  );

  // 结果由 browser-tools 的 navigate 路径产出（经 fake 视图）
  expect(result.content[0].text).toContain('"ok":true');
  // fake manager.getOrCreate 收到的是本会话 sessionId（分派正确）
  expect(fake.getOrCreateSessions).toEqual([session.id]);
  // fake 视图的 navigate 收到 url
  expect(fake.navigatedUrls).toEqual(["about:blank"]);
  // 生命周期方法未被误触发
  expect(fake.closedSessions).toEqual([]);
  expect(fake.disposeCount).toBe(0);

  try { rmSync(join(WA_PI_DIR, "tmp", "sysprompts", `${session.id}.md`), { force: true }); } catch {}
});

test("_teardownSession 随会话销毁调用 closeSession(sessionId)", async () => {
  const fake = makeFakeBrowserManager();
  const { am, session } = await newStartedManager(fake);

  await am.disposeSession(session.id);

  // 会话销毁时以该 sessionId 关闭浏览器视图
  expect(fake.closedSessions).toEqual([session.id]);
  // 未到 disposeAll，dispose 不应被触发
  expect(fake.disposeCount).toBe(0);
});

test("disposeAll 末尾调用 browserManager.dispose()", async () => {
  const fake = makeFakeBrowserManager();
  const { am, session } = await newStartedManager(fake);

  await am.disposeAll();

  // 会话销毁也走了 closeSession
  expect(fake.closedSessions).toEqual([session.id]);
  // 全部会话销毁后停掉浏览器视图池
  expect(fake.disposeCount).toBe(1);
});
