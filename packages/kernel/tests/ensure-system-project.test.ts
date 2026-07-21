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
