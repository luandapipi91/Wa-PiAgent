import { test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { MemoryStore } from "../src/memory-store";
import { getGlobalMemoryStore } from "../src/amaster-memory";
import type { ProjectStore } from "../src/project-store";

const tmpDir = import.meta.dir + ".tmp-memory-" + Math.random().toString(36).slice(2);

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
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ===== list：作用域与分类 =====

test("list 解析全局 memory 条目，category=memory scope=global", async () => {
  const store = new MemoryStore({ waPiDir: tmpDir, projectStore: mockProjectStore("/fake") });
  await store.add("global", "项目用 pnpm");
  await store.add("global", "CI 需要 frozen-lockfile");

  const { memories } = await store.list();
  const globalMemory = memories.filter(m => m.scope === "global" && m.category === "memory");
  expect(globalMemory).toHaveLength(2);
  expect(globalMemory[0].text).toBe("项目用 pnpm");
  expect(globalMemory[0].rawIndex).toBe(0);
  expect(globalMemory[1].text).toBe("CI 需要 frozen-lockfile");
  expect(globalMemory[1].rawIndex).toBe(1);
});

test("list 解析 USER.md category=user", async () => {
  // USER target 需经 amaster store 直接写入（wa-pi.add 只写 memory target）
  const amasterGlobal = getGlobalMemoryStore(tmpDir);
  await amasterGlobal.add("user", "偏好简洁回答");
  await amasterGlobal.add("user", "用中文");

  const store = new MemoryStore({ waPiDir: tmpDir, projectStore: mockProjectStore("/fake") });
  const { memories } = await store.list();

  const userEntries = memories.filter(m => m.category === "user");
  expect(userEntries).toHaveLength(2);
  expect(userEntries[0].id).toContain("USER.md");
  expect(userEntries[0].scope).toBe("global");
});

test("list 包含项目级记忆，scope=project", async () => {
  const store = new MemoryStore({ waPiDir: tmpDir, projectStore: mockProjectStore("/my-project") });
  await store.add("global", "全局记忆");
  await store.add("project", "项目记忆", "p1");
  await store.add("project", "CI 用 pnpm", "p1");

  const { memories } = await store.list("p1");
  const projectEntries = memories.filter(m => m.scope === "project");
  expect(projectEntries).toHaveLength(2);
  expect(projectEntries[0].text).toBe("项目记忆");
  expect(projectEntries[0].scope).toBe("project");
});

test("list 不传 projectId 时只返回全局记忆", async () => {
  const store = new MemoryStore({ waPiDir: tmpDir, projectStore: mockProjectStore("/my-project") });
  await store.add("global", "全局A");
  await store.add("project", "项目A", "p1");

  const { memories } = await store.list();
  expect(memories.every(m => m.scope === "global")).toBe(true);
  expect(memories.find(m => m.text === "项目A")).toBeUndefined();
});

test("list 文件不存在时返回空数组不报错", async () => {
  const store = new MemoryStore({ waPiDir: tmpDir, projectStore: mockProjectStore("/fake") });
  const { memories, archived } = await store.list();
  expect(memories).toEqual([]);
  expect(archived).toEqual([]);
});

// ===== add =====

test("add 全局记忆后 list 能读到", async () => {
  const store = new MemoryStore({ waPiDir: tmpDir, projectStore: mockProjectStore("/fake") });
  await store.add("global", "新全局记忆");
  const { memories } = await store.list();
  expect(memories.find(m => m.text === "新全局记忆" && m.scope === "global")).toBeTruthy();
});

test("add 项目记忆需要 projectId 并落到项目目录", async () => {
  const store = new MemoryStore({ waPiDir: tmpDir, projectStore: mockProjectStore("/my-project") });
  await store.add("project", "新项目记忆", "p1");
  const { memories } = await store.list("p1");
  const found = memories.find(m => m.text === "新项目记忆" && m.scope === "project");
  expect(found).toBeTruthy();

  // 全局读不到
  const { memories: globalOnly } = await store.list();
  expect(globalOnly.find(m => m.text === "新项目记忆")).toBeUndefined();
});

test("add 项目记忆缺少 projectId 抛错", async () => {
  const store = new MemoryStore({ waPiDir: tmpDir, projectStore: mockProjectStore("/my-project") });
  await expect(store.add("project", "无项目")).rejects.toThrow();
});

test("list 项目 cwd 为盘根等非法 basename 时不抛错，正常返回全局记忆", async () => {
  const store = new MemoryStore({ waPiDir: tmpDir, projectStore: mockProjectStore("H:") });
  await store.add("global", "全局A");
  // 盘根 cwd 经净化为合法目录名 H，不应抛 ENOENT
  const { memories } = await store.list("p1");
  expect(memories.find(m => m.text === "全局A" && m.scope === "global")).toBeTruthy();
});

// ===== update / archive / restore / purge =====

test("update 按 id 定位条目并替换文本", async () => {
  const store = new MemoryStore({ waPiDir: tmpDir, projectStore: mockProjectStore("/fake") });
  await store.add("global", "旧内容1");
  await store.add("global", "旧内容2");
  const { memories } = await store.list();
  const target = memories.find(m => m.text === "旧内容2")!;

  await store.update(target.id, "新内容2");

  const { memories: after } = await store.list();
  expect(after.find(m => m.text === "新内容2")).toBeTruthy();
  expect(after.find(m => m.text === "旧内容2")).toBeUndefined();
  expect(after.find(m => m.text === "旧内容1")).toBeTruthy();
});

test("update 不存在的 id 抛错", async () => {
  const store = new MemoryStore({ waPiDir: tmpDir, projectStore: mockProjectStore("/fake") });
  await expect(store.update("memories/global/MEMORY.md:99", "x")).rejects.toThrow();
});

test("archive 从 store 移除条目并写入 sidecar", async () => {
  const store = new MemoryStore({ waPiDir: tmpDir, projectStore: mockProjectStore("/fake") });
  await store.add("global", "条目A");
  await store.add("global", "条目B");
  const { memories } = await store.list();
  const target = memories.find(m => m.text === "条目A")!;

  await store.archive(target.id);

  const { memories: after, archived } = await store.list();
  expect(after.find(m => m.text === "条目A")).toBeUndefined();
  expect(after.find(m => m.text === "条目B")).toBeTruthy();
  expect(archived).toHaveLength(1);
  expect(archived[0].text).toBe("条目A");
  expect(archived[0].archivedAt).toBeTruthy();
});

test("restore 从 sidecar 移除并追加回 store", async () => {
  const store = new MemoryStore({ waPiDir: tmpDir, projectStore: mockProjectStore("/fake") });
  await store.add("global", "条目A");
  const { memories } = await store.list();
  const target = memories[0];
  await store.archive(target.id);

  await store.restore(target.id);

  const { memories: after, archived } = await store.list();
  expect(after.find(m => m.text === "条目A")).toBeTruthy();
  expect(archived).toEqual([]);
});

test("purge 从 sidecar 彻底删除，不写回 store", async () => {
  const store = new MemoryStore({ waPiDir: tmpDir, projectStore: mockProjectStore("/fake") });
  await store.add("global", "条目A");
  const { memories } = await store.list();
  const target = memories[0];
  await store.archive(target.id);

  await store.purge(target.id);

  const { archived } = await store.list();
  expect(archived).toEqual([]);
});

// ===== listInstructions：AGENTS.md / CLAUDE.md =====

test("listInstructions 扫描全局 + 项目级 AGENTS.md", async () => {
  await writeFile(join(tmpDir, "AGENTS.md"), "全局指令内容", "utf8");
  const projectCwd = join(tmpDir, "fake-project");
  await mkdir(projectCwd, { recursive: true });
  await writeFile(join(projectCwd, "AGENTS.md"), "项目指令内容", "utf8");

  const store = new MemoryStore({ waPiDir: tmpDir, projectStore: mockProjectStore(projectCwd) });
  const instructions = await store.listInstructions("p1");

  // 只看 tmpDir 范围内的文件（祖先遍历可能发现真实文件系统上游的 AGENTS.md）
  const ours = instructions.filter(i => i.path.startsWith(tmpDir));
  const globalInst = ours.find(i => i.scope === "global");
  const projectInst = ours.find(i => i.scope === "project");
  expect(globalInst).toBeTruthy();
  expect(globalInst!.name).toBe("AGENTS.md");
  expect(globalInst!.content).toBe("全局指令内容");
  expect(projectInst).toBeTruthy();
  expect(projectInst!.content).toBe("项目指令内容");
});

test("listInstructions CLAUDE.md 作为备选指令文件", async () => {
  await writeFile(join(tmpDir, "CLAUDE.md"), "全局 CLAUDE", "utf8");
  const projectCwd = join(tmpDir, "fake-project");
  await mkdir(projectCwd, { recursive: true });
  await writeFile(join(projectCwd, "CLAUDE.md"), "项目 CLAUDE", "utf8");

  const store = new MemoryStore({ waPiDir: tmpDir, projectStore: mockProjectStore(projectCwd) });
  const instructions = await store.listInstructions("p1");
  // 全局和项目两个文件都应命中 CLAUDE.md（祖先遍历可能有额外文件）
  const ours = instructions.filter(i =>
    i.path.startsWith(tmpDir) && i.name === "CLAUDE.md"
  );
  expect(ours.length).toBeGreaterThanOrEqual(2);
});

test("listInstructions AGENTS.md 优先于 CLAUDE.md", async () => {
  await writeFile(join(tmpDir, "AGENTS.md"), "全局 AGENTS", "utf8");
  await writeFile(join(tmpDir, "CLAUDE.md"), "全局 CLAUDE", "utf8");

  const store = new MemoryStore({ waPiDir: tmpDir, projectStore: mockProjectStore("/fake") });
  const instructions = await store.listInstructions("p1");
  // tmpDir 下 AGENTS.md 命中（优先级高），CLAUDE.md 不应出现在结果中
  const globalInst = instructions.find(i => i.scope === "global" && i.path.startsWith(tmpDir));
  expect(globalInst!.name).toBe("AGENTS.md");
  expect(globalInst!.content).toBe("全局 AGENTS");
  // CLAUDE.md 不应出现
  const claudeInTmp = instructions.find(i => i.path.startsWith(tmpDir) && i.name === "CLAUDE.md");
  expect(claudeInTmp).toBeUndefined();
});

test("listInstructions 文件不存在时返回空数组", async () => {
  const store = new MemoryStore({ waPiDir: tmpDir, projectStore: mockProjectStore("/fake") });
  const instructions = await store.listInstructions("p1");
  expect(instructions).toEqual([]);
});

test("listInstructions projectId 不存在时只返回全局", async () => {
  await writeFile(join(tmpDir, "AGENTS.md"), "全局指令", "utf8");
  const store = new MemoryStore({ waPiDir: tmpDir, projectStore: mockProjectStore("/fake") });
  const instructions = await store.listInstructions("nonexistent-id");
  // 至少有一个全局指令文件（祖先遍历可能带额外文件）
  expect(instructions.filter(i => i.scope === "global").length).toBeGreaterThanOrEqual(1);
  // 不应有项目级文件（因为 projectId 无效）
  expect(instructions.filter(i => i.scope === "project").length).toBe(0);
});

// ===== getConfig / setConfig =====

const HERMES_CONFIG_FILE = "hermes-memory-config.json";

test("getConfig 文件不存在时返回默认值", async () => {
  const store = new MemoryStore({ waPiDir: tmpDir, projectStore: mockProjectStore("/fake") });
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
  const store = new MemoryStore({ waPiDir: tmpDir, projectStore: mockProjectStore("/fake") });
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
  const store = new MemoryStore({ waPiDir: tmpDir, projectStore: mockProjectStore("/fake") });
  const config = await store.getConfig();
  expect(config.reviewEnabled).toBe(false);
  expect(config.memoryPolicyStyle).toBe("full");
});

test("setConfig 写入后 getConfig 读回新值", async () => {
  const store = new MemoryStore({ waPiDir: tmpDir, projectStore: mockProjectStore("/fake") });
  await store.setConfig({ reviewEnabled: false, memoryPolicyStyle: "none" });
  const config = await store.getConfig();
  expect(config.reviewEnabled).toBe(false);
  expect(config.memoryPolicyStyle).toBe("none");
});

test("setConfig 保留已有配置项不覆盖", async () => {
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

  const store = new MemoryStore({ waPiDir: tmpDir, projectStore: mockProjectStore("/fake") });
  await store.setConfig({ reviewEnabled: false });

  const raw = JSON.parse(await readFile(join(tmpDir, HERMES_CONFIG_FILE), "utf8"));
  expect(raw.reviewEnabled).toBe(false);
  expect(raw.nudgeInterval).toBe(5);
  expect(raw.autoConsolidate).toBe(true);
});

// ===== listInstructions 一致性：对齐 pi 框架的 context file 加载行为 =====
// pi 框架 resource-loader.js loadProjectContextFiles 的规则：
// 1. 候选文件名：AGENTS.md, AGENTS.MD, CLAUDE.md, CLAUDE.MD（取第一个命中）
// 2. 扫描范围：agentDir + cwd + 所有祖先目录（向上走到根）
// 3. 去重：同一文件路径不重复

// —— 不一致1：应支持 AGENTS.MD / CLAUDE.MD 大写变体（macOS 大小写不敏感，首候选 AGENTS.md 始终命中） ——
test("listInstructions 候选列表包含大写变体（pi 兼容行为）", async () => {
  await writeFile(join(tmpDir, "AGENTS.MD"), "大写变体内容", "utf8");
  const store = new MemoryStore({ waPiDir: tmpDir, projectStore: mockProjectStore("/fake") });
  const instructions = await store.listInstructions("p1");
  expect(instructions).toHaveLength(1);
  // macOS 大小写不敏感 → existsSync("AGENTS.md") 命中同一文件 → name="AGENTS.md"
  // Linux 大小写敏感 → existsSync("AGENTS.MD") 命中 → name="AGENTS.MD"
  // 两者都是正确的，取决于文件系统。验证实际文件名是否为候选列表中的值即可。
  const validNames = ["AGENTS.md", "AGENTS.MD"];
  expect(validNames).toContain(instructions[0].name);
  expect(instructions[0].content).toBe("大写变体内容");
  expect(instructions[0].scope).toBe("global");
});

// —— 不一致2：应遍历祖先目录（从 cwd 向上到根） ——
test("listInstructions 遍历祖先目录发现指令文件", async () => {
  // 项目 cwd 在深层目录
  const projectCwd = join(tmpDir, "a", "b", "c");
  await mkdir(projectCwd, { recursive: true });
  // 在祖先目录放指令文件
  await writeFile(join(tmpDir, "a", "AGENTS.md"), "祖先 a 指令", "utf8");

  const store = new MemoryStore({ waPiDir: tmpDir, projectStore: mockProjectStore(projectCwd) });
  const instructions = await store.listInstructions("p1");

  // 应发现祖先目录的指令文件（scope=project，因为来自 cwd 祖先链）
  const ancestorInst = instructions.find(i => i.path === join(tmpDir, "a", "AGENTS.md"));
  expect(ancestorInst).toBeTruthy();
  expect(ancestorInst!.content).toBe("祖先 a 指令");
  expect(ancestorInst!.scope).toBe("project");
});

// —— 不一致3：祖先 + cwd + 全局可同时存在多个文件 ——
test("listInstructions 全局和祖先目录可同时返回多个指令文件", async () => {
  await writeFile(join(tmpDir, "AGENTS.md"), "全局指令", "utf8");
  const projectCwd = join(tmpDir, "proj");
  await mkdir(projectCwd, { recursive: true });
  await writeFile(join(tmpDir, "AGENTS.md"), "这也是全局（agentDir == tmpDir）", "utf8");
  // 上面覆盖了 tmpDir/AGENTS.md，会同时作为全局和祖先被扫描，
  // 但 seenPaths 去重后只保留一份。所以这里只在 cwd 下放另一个文件。
  await writeFile(join(projectCwd, "CLAUDE.md"), "项目 CLAUDE", "utf8");

  const store = new MemoryStore({ waPiDir: tmpDir, projectStore: mockProjectStore(projectCwd) });
  const instructions = await store.listInstructions("p1");

  // 全局文件 + 祖先文件（tmpDir == agentDir == cwd 祖先根，去重只算一次）+ 项目文件
  // tmpDir/AGENTS.md 被 agentDir 命中（scope=global），cwd/CLAUDE.md 被祖先遍历命中
  expect(instructions.length).toBeGreaterThanOrEqual(2);
  const globalInst = instructions.find(i => i.scope === "global");
  const projectInst = instructions.find(i => i.scope === "project");
  expect(globalInst).toBeTruthy();
  expect(projectInst).toBeTruthy();
});

// —— 去重：agentDir 与 cwd 或祖先目录重叠时，同一路径不重复 ——
test("listInstructions agentDir 与祖先目录重叠时去重", async () => {
  // agentDir == cwd (同一个目录) → global 和项目应指向同一文件但去重
  const projectCwd = tmpDir; // cwd = agentDir
  await writeFile(join(tmpDir, "AGENTS.md"), "既是全局也是项目 cwd", "utf8");

  const store = new MemoryStore({ waPiDir: tmpDir, projectStore: mockProjectStore(projectCwd) });
  const instructions = await store.listInstructions("p1");

  // 在 tmpDir 范围内的结果：同一文件只出现一次（作为 global，因为 agentDir 优先）
  const ours = instructions.filter(i => i.path.startsWith(tmpDir));
  expect(ours).toHaveLength(1);
  expect(ours[0].scope).toBe("global");
  expect(ours[0].content).toBe("既是全局也是项目 cwd");
});
