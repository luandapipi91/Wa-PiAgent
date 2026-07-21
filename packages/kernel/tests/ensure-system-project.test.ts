import { test, expect } from "bun:test";
import { rmSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore } from "../src/project-store";
import { ensureSystemProject } from "../src/ensure-system-project";
import {
  SYSTEM_PROJECT_ID, SYSTEM_PROJECT_NAME, SYSTEM_PROJECT_CWD,
} from "@hiagent/shared";

function tempFile() {
  return join(import.meta.dir, ".tmp-ensure-" + Math.random().toString(36).slice(2) + ".json");
}

test("ensureSystemProject 首次调用写入系统项目", async () => {
  const f = tempFile();
  const store = new ProjectStore(f);
  await ensureSystemProject(store);
  const { projects } = await store.load();
  const sys = projects.find(p => p.id === SYSTEM_PROJECT_ID);
  expect(sys).toBeDefined();
  expect(sys!.name).toBe(SYSTEM_PROJECT_NAME);
  expect(sys!.cwd).toBe(SYSTEM_PROJECT_CWD);
  rmSync(f, { force: true });
});

test("ensureSystemProject 二次调用幂等", async () => {
  const f = tempFile();
  const store = new ProjectStore(f);
  await ensureSystemProject(store);
  await ensureSystemProject(store);
  const { projects } = await store.load();
  expect(projects.filter(p => p.id === SYSTEM_PROJECT_ID)).toHaveLength(1);
  rmSync(f, { force: true });
});

test("ensureSystemProject 创建 workdir 根目录", async () => {
  const f = tempFile();
  const store = new ProjectStore(f);
  await ensureSystemProject(store);
  // SYSTEM_PROJECT_CWD 目录必须存在（实际 ~/.hiagent/workdir）
  expect(existsSync(SYSTEM_PROJECT_CWD)).toBe(true);
  expect(statSync(SYSTEM_PROJECT_CWD).isDirectory()).toBe(true);
  rmSync(f, { force: true });
});

test("ensureSystemProject 内部异常时不抛错（不阻塞 kernel 启动）", async () => {
  // 构造一个 createSystemProject 必抛错的 store：projects.json 路径指向一个已存在目录
  // （writeFile 写不进目录），让 save() 抛错
  const dir = join(import.meta.dir, ".tmp-ensure-err-" + Math.random().toString(36).slice(2));
  await import("node:fs/promises").then(m => m.mkdir(dir, { recursive: true }));
  // projects.json 路径设为目录内一个"同名目录" → writeFile 必抛 EISDIR
  const badPath = join(dir, "projects.json");
  await import("node:fs/promises").then(m => m.mkdir(badPath, { recursive: true }));
  const store = new ProjectStore(badPath);
  // 不应抛错（被 catch 吞掉，仅 console.warn）
  const warnSpy = jest_like_spy_console_warn();
  await expect(ensureSystemProject(store)).resolves.toBeUndefined();
  warnSpy.restore();
  rmSync(dir, { recursive: true, force: true });
});

// 简易 console.warn spy（避免引入额外依赖）
function jest_like_spy_console_warn() {
  const original = console.warn;
  const calls: string[] = [];
  console.warn = (...args: unknown[]) => { calls.push(args.join(" ")); };
  return {
    get calls() { return calls; },
    restore() { console.warn = original; },
  };
}
