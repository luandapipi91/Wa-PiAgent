import { test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
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

test("update 按定位 § 段落替换文本", async () => {
  await writeFile(join(hermesDir, "MEMORY.md"), "旧内容1\n§\n旧内容2", "utf8");
  const store = new MemoryStore({ hiagentDir: tmpDir, projectStore: mockProjectStore("/fake") });
  const { memories } = await store.list();
  const targetId = memories[1].id; // "pi-hermes-memory/MEMORY.md:1"

  await store.update(targetId, "新内容2");

  const raw = await readFile(join(hermesDir, "MEMORY.md"), "utf8");
  expect(raw).toContain("新内容2");
  expect(raw).toContain("旧内容1");
  expect(raw).not.toContain("旧内容2");
});

test("archive 从文件移除条目并写入 sidecar", async () => {
  await writeFile(join(hermesDir, "MEMORY.md"), "条目A\n§\n条目B", "utf8");
  const store = new MemoryStore({ hiagentDir: tmpDir, projectStore: mockProjectStore("/fake") });
  const { memories } = await store.list();
  const targetId = memories[0].id;

  await store.archive(targetId);

  // 文件里应该只剩条目B
  const raw = await readFile(join(hermesDir, "MEMORY.md"), "utf8");
  expect(raw).not.toContain("条目A");
  expect(raw).toContain("条目B");

  // sidecar 里有归档记录
  const { archived } = await store.list();
  expect(archived).toHaveLength(1);
  expect(archived[0].text).toBe("条目A");
  expect(archived[0].archivedAt).toBeTruthy();
});

test("restore 从 sidecar 移除并追加回源文件", async () => {
  await writeFile(join(hermesDir, "MEMORY.md"), "条目A", "utf8");
  const store = new MemoryStore({ hiagentDir: tmpDir, projectStore: mockProjectStore("/fake") });
  const { memories } = await store.list();
  const targetId = memories[0].id;
  await store.archive(targetId); // 先归档

  await store.restore(targetId); // 再恢复

  // 文件里应该有恢复的条目
  const raw = await readFile(join(hermesDir, "MEMORY.md"), "utf8");
  expect(raw).toContain("条目A");

  // sidecar 应该为空
  const { archived } = await store.list();
  expect(archived).toEqual([]);
});

test("purge 从 sidecar 彻底删除，不写回文件", async () => {
  await writeFile(join(hermesDir, "MEMORY.md"), "条目A", "utf8");
  const store = new MemoryStore({ hiagentDir: tmpDir, projectStore: mockProjectStore("/fake") });
  const { memories } = await store.list();
  const targetId = memories[0].id;
  await store.archive(targetId);

  await store.purge(targetId);

  const { archived } = await store.list();
  expect(archived).toEqual([]);
});

// ===== Task 4: listInstructions =====

test("listInstructions 扫描全局 + 项目级 AGENTS.md", async () => {
  // 全局：hiagentDir 下的 AGENTS.md
  await writeFile(join(tmpDir, "AGENTS.md"), "全局指令内容", "utf8");
  // 项目级：项目 cwd 下的 AGENTS.md
  const projectCwd = join(tmpDir, "fake-project");
  await mkdir(projectCwd, { recursive: true });
  await writeFile(join(projectCwd, "AGENTS.md"), "项目指令内容", "utf8");

  const store = new MemoryStore({ hiagentDir: tmpDir, projectStore: mockProjectStore(projectCwd) });
  const instructions = await store.listInstructions("p1");

  expect(instructions).toHaveLength(2);
  const globalInst = instructions.find(i => i.scope === "global");
  const projectInst = instructions.find(i => i.scope === "project");
  expect(globalInst).toBeTruthy();
  expect(globalInst!.name).toBe("AGENTS.md");
  expect(projectInst).toBeTruthy();
  expect(projectInst!.content).toBe("项目指令内容");
});

test("listInstructions CLAUDE.md 作为备选指令文件", async () => {
  // 只有 CLAUDE.md 没有 AGENTS.md
  await writeFile(join(tmpDir, "CLAUDE.md"), "全局 CLAUDE", "utf8");
  const projectCwd = join(tmpDir, "fake-project");
  await mkdir(projectCwd, { recursive: true });
  await writeFile(join(projectCwd, "CLAUDE.md"), "项目 CLAUDE", "utf8");

  const store = new MemoryStore({ hiagentDir: tmpDir, projectStore: mockProjectStore(projectCwd) });
  const instructions = await store.listInstructions("p1");

  expect(instructions).toHaveLength(2);
  expect(instructions.every(i => i.name === "CLAUDE.md")).toBe(true);
});

test("listInstructions AGENTS.md 优先于 CLAUDE.md", async () => {
  // 两个都存在，只取 AGENTS.md
  await writeFile(join(tmpDir, "AGENTS.md"), "全局 AGENTS", "utf8");
  await writeFile(join(tmpDir, "CLAUDE.md"), "全局 CLAUDE", "utf8");

  const store = new MemoryStore({ hiagentDir: tmpDir, projectStore: mockProjectStore("/fake") });
  const instructions = await store.listInstructions("p1");

  const globalInst = instructions.find(i => i.scope === "global");
  expect(globalInst!.name).toBe("AGENTS.md");
  expect(globalInst!.content).toBe("全局 AGENTS");
});

test("listInstructions 文件不存在时返回空数组", async () => {
  const store = new MemoryStore({ hiagentDir: tmpDir, projectStore: mockProjectStore("/fake") });
  const instructions = await store.listInstructions("p1");
  expect(instructions).toEqual([]);
});

test("listInstructions projectId 不存在时只返回全局", async () => {
  await writeFile(join(tmpDir, "AGENTS.md"), "全局指令", "utf8");
  const store = new MemoryStore({ hiagentDir: tmpDir, projectStore: mockProjectStore("/fake") });
  const instructions = await store.listInstructions("nonexistent-id");
  expect(instructions).toHaveLength(1);
  expect(instructions[0].scope).toBe("global");
});

// ===== Task 4: getConfig / setConfig =====

const HERMES_CONFIG_FILE = "hermes-memory-config.json";

test("getConfig 文件不存在时返回默认值", async () => {
  const store = new MemoryStore({ hiagentDir: tmpDir, projectStore: mockProjectStore("/fake") });
  const config = await store.getConfig();
  expect(config.reviewEnabled).toBe(true);
  expect(config.memoryPolicyStyle).toBe("full");
});

test("getConfig 读取已有配置文件", async () => {
  await writeFile(
    join(tmpDir, HERMES_CONFIG_FILE),
    JSON.stringify({ reviewEnabled: false, memoryPolicyStyle: "compact" }),
    "utf8",
  );
  const store = new MemoryStore({ hiagentDir: tmpDir, projectStore: mockProjectStore("/fake") });
  const config = await store.getConfig();
  expect(config.reviewEnabled).toBe(false);
  expect(config.memoryPolicyStyle).toBe("compact");
});

test("getConfig 配置文件缺失字段时用默认值补齐", async () => {
  await writeFile(
    join(tmpDir, HERMES_CONFIG_FILE),
    JSON.stringify({ reviewEnabled: false }),
    "utf8",
  );
  const store = new MemoryStore({ hiagentDir: tmpDir, projectStore: mockProjectStore("/fake") });
  const config = await store.getConfig();
  expect(config.reviewEnabled).toBe(false);
  expect(config.memoryPolicyStyle).toBe("full"); // 缺失字段用默认值
});

test("setConfig 写入后 getConfig 读回新值", async () => {
  const store = new MemoryStore({ hiagentDir: tmpDir, projectStore: mockProjectStore("/fake") });
  await store.setConfig({ reviewEnabled: false, memoryPolicyStyle: "none" });
  const config = await store.getConfig();
  expect(config.reviewEnabled).toBe(false);
  expect(config.memoryPolicyStyle).toBe("none");
});

test("setConfig 保留已有配置项不覆盖", async () => {
  // 先写入一个有其他字段的配置
  await writeFile(
    join(tmpDir, HERMES_CONFIG_FILE),
    JSON.stringify({
      reviewEnabled: true,
      memoryPolicyStyle: "full",
      nudgeInterval: 5,
      autoConsolidate: true,
    }),
    "utf8",
  );

  const store = new MemoryStore({ hiagentDir: tmpDir, projectStore: mockProjectStore("/fake") });
  await store.setConfig({ reviewEnabled: false });

  const raw = JSON.parse(await readFile(join(tmpDir, HERMES_CONFIG_FILE), "utf8"));
  expect(raw.reviewEnabled).toBe(false);
  expect(raw.nudgeInterval).toBe(5); // 其他字段保留
  expect(raw.autoConsolidate).toBe(true);
});
