import { test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { MemoryStore } from "../src/memory-store";
import type { ProjectStore } from "../src/project-store";

const tmpDir = import.meta.dir + ".tmp-memory-" + Math.random().toString(36).slice(2);
const hermesDir = join(tmpDir, "pi-hermes-memory");
const projectsMemoryDir = join(tmpDir, "projects-memory");

// mock ProjectStore：getProjectCwd 返回固定值
function mockProjectStore(cwd: string): ProjectStore {
  return {
    async load() {
      return {
        projects: [{ id: "p1", name: "test", cwd, createdAt: "" }],
        sessions: [],
      };
    },
  } as unknown as ProjectStore;
}

beforeEach(async () => {
  await mkdir(hermesDir, { recursive: true });
  await mkdir(projectsMemoryDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

test("list 解析全局 MEMORY.md 的 § 分隔条目，category=memory scope=global", async () => {
  await writeFile(join(hermesDir, "MEMORY.md"), "项目用 pnpm\n§\nCI 需要 frozen-lockfile", "utf8");
  const store = new MemoryStore({ hiagentDir: tmpDir, projectStore: mockProjectStore("/fake") });
  const { memories } = await store.list();

  expect(memories).toHaveLength(2);
  expect(memories[0].text).toBe("项目用 pnpm");
  expect(memories[0].category).toBe("memory");
  expect(memories[0].scope).toBe("global");
  expect(memories[0].rawIndex).toBe(0);
  expect(memories[1].text).toBe("CI 需要 frozen-lockfile");
  expect(memories[1].rawIndex).toBe(1);
});

test("list 解析 USER.md category=user, failures.md category=failure", async () => {
  await writeFile(join(hermesDir, "USER.md"), "偏好简洁回答\n§\n用中文", "utf8");
  await writeFile(join(hermesDir, "failures.md"), "localStorage 存 token 有 XSS 风险", "utf8");
  const store = new MemoryStore({ hiagentDir: tmpDir, projectStore: mockProjectStore("/fake") });
  const { memories } = await store.list();

  const userEntries = memories.filter(m => m.category === "user");
  const failureEntries = memories.filter(m => m.category === "failure");
  expect(userEntries).toHaveLength(2);
  expect(userEntries[0].id).toContain("USER.md");
  expect(failureEntries).toHaveLength(1);
  expect(failureEntries[0].text).toContain("XSS");
});

test("list 包含项目级记忆，scope=project", async () => {
  await writeFile(join(hermesDir, "MEMORY.md"), "全局记忆", "utf8");
  // 项目目录名取 basename("/my-project") = "my-project"
  const projectDir = join(projectsMemoryDir, "my-project");
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, "MEMORY.md"), "项目记忆\n§\nCI 用 pnpm", "utf8");
  const store = new MemoryStore({ hiagentDir: tmpDir, projectStore: mockProjectStore("/my-project") });
  const { memories } = await store.list();

  const projectEntries = memories.filter(m => m.scope === "project");
  expect(projectEntries).toHaveLength(2);
  expect(projectEntries[0].text).toBe("项目记忆");
  expect(projectEntries[0].scope).toBe("project");
});

test("list 文件不存在时返回空数组不报错", async () => {
  const store = new MemoryStore({ hiagentDir: tmpDir, projectStore: mockProjectStore("/fake") });
  const { memories, archived } = await store.list();
  expect(memories).toEqual([]);
  expect(archived).toEqual([]);
});
