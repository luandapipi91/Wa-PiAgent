/**
 * 插件注册面冲突的 API 层验证：
 *   POST /api/extensions/install → callApi({type:"extension:install"}) → ws-server case
 *   → ExtensionManager.install 抛 ext.commandConflict → SSE 广播 extension:error（带 code/params）
 *
 * 与 extension-conflicts.test.ts（service 层单测）互补：这里走真实 HTTP + SSE，
 * 确认真实链路上用户能拿到可渲染的结构化错误（前端按 code 查 i18n 字典）。
 */
import { test, expect, setDefaultTimeout, beforeAll, afterAll } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WA_PI_DIR } from "@wa-pi/shared";

// 冲突校验实现为「现起一个 pi 进程问它的注册表」（单次约 2s），一次安装加上 SSE 等待
// 会超过 bun 默认的 5s。
setDefaultTimeout(60_000);
import { ConfigStore } from "../src/config-store";
import { ExtensionManager } from "../src/extension-manager";
import { ProjectStore } from "../src/project-store";
import { SkillManager } from "../src/skill-manager";
import { WSServer } from "../src/ws-server";

// 临时目录放系统 temp（而非仓库内 tests/.tmp-*）：点号开头的目录会被 pi 的路径忽略规则跳过，
// 导致探测起的那次 pi 根本加载不到被测插件（“探测不到”而静默放行）。
function tmp(s: string) {
  return join(
    tmpdir(),
    "wa-pi-ec-" + s + "-" + Math.random().toString(36).slice(2),
  );
}

/** 造一个最小 pi 扩展包（注册给定命令） */
function makePkg(root: string, name: string, cmd: string): string {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify(
      { name, version: "1.0.0", pi: { extensions: ["./index.ts"] } },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(
    join(root, "index.ts"),
    `export default function (pi) {\n  pi.registerCommand("${cmd}", { description: "d", handler: async () => {} });\n}\n`,
    "utf8",
  );
  return root;
}

async function connectSse(
  base: string,
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const res = await fetch(`${base}/api/events`);
  if (!res.ok || !res.body) throw new Error(`SSE 连接失败: ${res.status}`);
  const reader = res.body.getReader();
  await reader.read(); // 首读触发 stream.start → bus.add(write)
  return reader;
}

const sseBuffers = new WeakMap<
  ReadableStreamDefaultReader<Uint8Array>,
  string
>();

async function readSseFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<{ type: string } & Record<string, unknown>> {
  const dec = new TextDecoder();
  let buffer = sseBuffers.get(reader) ?? "";
  for (;;) {
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (raw.trim().startsWith(":")) continue;
      const line = raw.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      sseBuffers.set(reader, buffer);
      return JSON.parse(line.slice(5).trim());
    }
    sseBuffers.set(reader, buffer);
    const { value, done } = await reader.read();
    if (done) throw new Error("SSE 流已关闭");
    buffer += dec.decode(value, { stream: true });
  }
}

async function waitForSseEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  type: string,
  timeoutMs = 3000,
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = await Promise.race([
      readSseFrame(reader),
      new Promise<null>((r) =>
        setTimeout(() => r(null), Math.max(0, deadline - Date.now())),
      ),
    ]);
    if (!frame) return null;
    if (frame.type === type) return frame;
  }
  return null;
}

// WA_PI_DIR 是 kernel 测试共享的隔离 agentDir。本文件的安装会往它的 settings.json 写 packages
// （冲突探测起的 pi 读的就是这份 settings），跑完必须还原，免得污染同批的其他测试文件。
const SETTINGS_FILE = join(WA_PI_DIR, "settings.json");
let settingsBackup: string | undefined;
beforeAll(() => {
  try {
    settingsBackup = readFileSync(SETTINGS_FILE, "utf8");
  } catch {}
});
afterAll(() => {
  if (settingsBackup !== undefined)
    writeFileSync(SETTINGS_FILE, settingsBackup, "utf8");
  else rmSync(SETTINGS_FILE, { force: true });
});

async function setup() {
  const cfgDir = tmp("cfg");
  const projFile = tmp("proj.json");

  // 待装插件必须落在「探测进程会去读的那个 agentDir」：探测起的 pi 读 WA_PI_DIR/settings.json
  // 的 packages；manager 若写在别的目录，pi 永远看不到被测包 → 静默放行（测试假失败）。
  const extensionManager = new ExtensionManager(WA_PI_DIR);
  const configStore = new ConfigStore(cfgDir);
  const projectStore = new ProjectStore(projFile);
  const skillManager = new SkillManager(join(projFile, "..", "skills"));

  const server = new WSServer({
    configStore,
    projectStore,
    providerStore: {
      save: async () => {},
      load: async () => ({ providers: [] }),
    } as any,
    skillManager,
    extensionManager,
    memoryStore: null as any,
    mcpStore: null as any,
    channelManager: null,
    agentManager: {
      markAllDirty: () => {},
      disposeAll: async () => {},
    } as any,
    port: 0,
  });
  await server.start();
  const base = `http://127.0.0.1:${server.actualPort}`;
  const reader = await connectSse(base);

  return {
    base,
    reader,
    cleanup: async () => {
      await server.stop();
      rmSync(cfgDir, { recursive: true, force: true });
      rmSync(projFile, { force: true });
    },
  };
}

test("HTTP 安装两个注册同名命令的插件：第二个经 SSE 回 ext.commandConflict（带 name/other/names）", async () => {
  const ctx = await setup();
  const alpha = makePkg(tmp("a"), "goal-alpha", "goal");
  const beta = makePkg(tmp("b"), "goal-beta", "goal");
  try {
    const first = await fetch(`${ctx.base}/api/extensions/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: alpha }),
    });
    expect(first.ok).toBe(true);
    expect(
      await waitForSseEvent(ctx.reader, "extension:install:done", 30_000),
    ).not.toBeNull();

    const second = await fetch(`${ctx.base}/api/extensions/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: beta }),
    });
    expect(second.ok).toBe(true); // fire-and-forget：业务错误走 SSE

    const err = await waitForSseEvent(ctx.reader, "extension:error", 30_000);
    expect(err?.code).toBe("ext.commandConflict");
    const params = err?.params as Record<string, string> | undefined;
    expect(params?.name).toBe("goal-beta");
    expect(params?.other).toBe("goal-alpha");
    expect(params?.names).toBe("/goal");
  } finally {
    rmSync(alpha, { recursive: true, force: true });
    rmSync(beta, { recursive: true, force: true });
    await ctx.cleanup();
  }
});

test("HTTP 安装注册面不重叠的插件不报冲突", async () => {
  const ctx = await setup();
  const alpha = makePkg(tmp("a"), "goal-alpha", "goal");
  const beta = makePkg(tmp("b"), "other-beta", "other-cmd");
  try {
    for (const name of [alpha, beta]) {
      const res = await fetch(`${ctx.base}/api/extensions/install`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      expect(res.ok).toBe(true);
      expect(
        await waitForSseEvent(ctx.reader, "extension:install:done", 30_000),
      ).not.toBeNull();
    }
  } finally {
    rmSync(alpha, { recursive: true, force: true });
    rmSync(beta, { recursive: true, force: true });
    await ctx.cleanup();
  }
});
