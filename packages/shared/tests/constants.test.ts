import { test, expect } from "bun:test";
import {
  DEFAULT_AGENT_TOOLS,
  EXTENSION_TOOL_MAP,
  resolveAgentTools,
  SYSTEM_PROJECT_ID,
  SYSTEM_PROJECT_NAME,
  SYSTEM_PROJECT_CWD,
  WORKDIR_TTL_DAYS,
  PROMPTS_FILE,
  SUBAGENT_OVERRIDES_FILE,
  SUBAGENT_TYPES,
  isSubagentType,
  normalizeSubagentType,
} from "../src/constants";

// pi-lens 已彻底移除：这些工具名不应再出现在默认 allowlist 或扩展映射里
const REMOVED_LENS_TOOLS = [
  "ast_grep_search",
  "ast_grep_replace",
  "ast_grep_outline",
  "module_report",
  "read_symbol",
  "read_enclosing",
];

test("DEFAULT_AGENT_TOOLS 含 Pi 内置文件工具、网络工具与 amaster memory 记忆工具", () => {
  expect(DEFAULT_AGENT_TOOLS).toContain("read");
  expect(DEFAULT_AGENT_TOOLS).toContain("bash");
  expect(DEFAULT_AGENT_TOOLS).toContain("edit");
  expect(DEFAULT_AGENT_TOOLS).toContain("write");
  expect(DEFAULT_AGENT_TOOLS).toContain("grep");
  expect(DEFAULT_AGENT_TOOLS).toContain("find");
  expect(DEFAULT_AGENT_TOOLS).toContain("ls");
  expect(DEFAULT_AGENT_TOOLS).toContain("web_search");
  expect(DEFAULT_AGENT_TOOLS).toContain("fetch_content");
  expect(DEFAULT_AGENT_TOOLS).toContain("get_search_content");
  // amaster host-controlled 记忆工具（须在 allowlist 显式放行，否则被 SDK 过滤）
  expect(DEFAULT_AGENT_TOOLS).toContain("memory_add");
  expect(DEFAULT_AGENT_TOOLS).toContain("memory_replace");
  expect(DEFAULT_AGENT_TOOLS).toContain("memory_remove");
  expect(DEFAULT_AGENT_TOOLS).toContain("memory_read");
  expect(DEFAULT_AGENT_TOOLS).toContain("session_search");
  expect(DEFAULT_AGENT_TOOLS).toContain("ask_user_question");
});

test("DEFAULT_AGENT_TOOLS 不再包含 pi-lens 专属工具", () => {
  for (const tool of REMOVED_LENS_TOOLS) {
    expect(DEFAULT_AGENT_TOOLS).not.toContain(tool);
  }
});

test("EXTENSION_TOOL_MAP 不再包含 pi-lens 键", () => {
  expect(EXTENSION_TOOL_MAP).not.toHaveProperty("pi-lens");
});

// ---- resolveAgentTools：按已启用扩展「注入」工具（替代旧的从默认集过滤）----
// 第 4 个参数 toolMap 可注入伪注册表，便于测试，默认用 EXTENSION_TOOL_MAP

test("resolveAgentTools: 注入已启用扩展的工具（保留 base 顺序）", () => {
  const fakeMap = { "demo-ext": ["demo_tool_a", "demo_tool_b"] };
  const result = resolveAgentTools(["read", "edit"], new Set(["demo-ext"]), undefined, fakeMap);
  expect(result).toEqual(["read", "edit", "demo_tool_a", "demo_tool_b"]);
});

test("resolveAgentTools: 未启用的扩展工具不被注入", () => {
  const fakeMap = { "demo-ext": ["demo_tool_a"] };
  const result = resolveAgentTools(["read"], new Set(), undefined, fakeMap);
  expect(result).toEqual(["read"]);
});

test("resolveAgentTools: 已注入工具与 base 重复时去重", () => {
  const fakeMap = { "demo-ext": ["read", "demo_tool_a"] };
  const result = resolveAgentTools(["read", "edit"], new Set(["demo-ext"]), undefined, fakeMap);
  expect(result).toEqual(["read", "edit", "demo_tool_a"]);
});

test("resolveAgentTools: 不修改原数组（不可变）", () => {
  const base = ["read", "edit"];
  const snapshot = [...base];
  resolveAgentTools(base, new Set(), undefined, {});
  expect(base).toEqual(snapshot);
});

// ---- 动态工具发现（option B）：第 5 个参数 harvestedTools 注入 loader.reload() 后
// 从 runtime.tools 枚举出的工具名。替代手动维护 EXTENSION_TOOL_MAP 的静态登记。

test("resolveAgentTools: 注入运行时发现的扩展工具名（harvested）", () => {
  const result = resolveAgentTools(["read"], new Set(), undefined, {}, ["hypa_shell", "hypa_read"]);
  expect(result).toEqual(["read", "hypa_shell", "hypa_read"]);
});

test("resolveAgentTools: harvested 与 base / toolMap 去重", () => {
  const result = resolveAgentTools(
    ["read", "bash"],
    new Set(["e"]),
    undefined,
    { e: ["hypa_shell"] },
    ["read", "hypa_shell", "hypa_ls"],
  );
  // read(base) + bash(base) + hypa_shell(toolMap) + hypa_ls(harvested，去重 hypa_shell 已存在)
  expect(result).toEqual(["read", "bash", "hypa_shell", "hypa_ls"]);
});

test("resolveAgentTools: harvested 默认空（向后兼容 4 参调用）", () => {
  const result = resolveAgentTools(["read"], new Set(["e"]), undefined, { e: ["demo_tool_a"] });
  expect(result).toEqual(["read", "demo_tool_a"]);
});

test("resolveAgentTools: 扩展原生 subagent 工具被剔除；delegate 放行", () => {
  const out = resolveAgentTools(DEFAULT_AGENT_TOOLS, new Set(), "dev", {}, ["subagent", "some_ext_tool"]);
  expect(out).not.toContain("subagent");
  expect(out).toContain("delegate");
  expect(out).toContain("some_ext_tool");
});

// ---- 默认工作区（虚拟系统项目）常量 ----

test("SYSTEM_PROJECT_* 常量定义", () => {
  expect(SYSTEM_PROJECT_ID).toBe("__system__");
  expect(SYSTEM_PROJECT_NAME).toBe("默认工作区");
  expect(SYSTEM_PROJECT_CWD.endsWith("workdir")).toBe(true);
  expect(SYSTEM_PROJECT_CWD.includes("hiagent")).toBe(true);
  expect(WORKDIR_TTL_DAYS).toBe(7);
});

test("PROMPTS_FILE 指向 ~/.hiagent/prompts.json", () => {
  expect(PROMPTS_FILE.endsWith("prompts.json")).toBe(true);
  expect(PROMPTS_FILE.includes("hiagent")).toBe(true);
});

// ---- 内置 subagent 类型 ----

test("SUBAGENT_TYPES 含 general-purpose 与 Explore", () => {
  const names = SUBAGENT_TYPES.map(t => t.name);
  expect(names).toContain("general-purpose");
  expect(names).toContain("Explore");
});

test("SUBAGENT_TYPES 每项有完整的元信息", () => {
  for (const t of SUBAGENT_TYPES) {
    expect(t.name.length).toBeGreaterThan(0);
    expect(t.displayName.length).toBeGreaterThan(0);
    expect(t.description.length).toBeGreaterThan(0);
    expect(t.emoji.length).toBeGreaterThan(0);
    expect(t.gradient.length).toBe(2);
    expect(typeof t.readOnly).toBe("boolean");
  }
});

test("isSubagentType 识别内置类型名（大小写敏感）", () => {
  expect(isSubagentType("general-purpose")).toBe(true);
  expect(isSubagentType("Explore")).toBe(true);
  // 中文 displayName 也识别（用户在输入框打 @[通用子智能体] 时被认作内置类型）
  expect(isSubagentType("通用子智能体")).toBe(true);
  expect(isSubagentType("探索子智能体")).toBe(true);
  // 大小写敏感（pi-subagents registry 用大小写敏感查 type）
  expect(isSubagentType("explore")).toBe(false);
  expect(isSubagentType("general_purpose")).toBe(false);
  expect(isSubagentType("代码审查")).toBe(false);
  expect(isSubagentType("")).toBe(false);
});

test("normalizeSubagentType 把中文别名归一化为英文 name", () => {
  // 中英文互转
  expect(normalizeSubagentType("通用子智能体")).toBe("general-purpose");
  expect(normalizeSubagentType("探索子智能体")).toBe("Explore");
  // 已是英文 name 原样返回
  expect(normalizeSubagentType("general-purpose")).toBe("general-purpose");
  expect(normalizeSubagentType("Explore")).toBe("Explore");
  // 非内置类型原样透传（普通智能体实名）
  expect(normalizeSubagentType("代码审查")).toBe("代码审查");
  expect(normalizeSubagentType("")).toBe("");
});

// ---- 内置 subagent 类型：Plan（第 3 个内置类型，只读规划）----

test("SUBAGENT_TYPES 含 Plan（第 3 个内置类型）", () => {
  const names = SUBAGENT_TYPES.map(t => t.name);
  expect(names).toContain("Plan");
  const plan = SUBAGENT_TYPES.find(t => t.name === "Plan");
  expect(plan).toBeDefined();
  expect(plan!.displayName).toBe("规划子智能体");
  expect(plan!.readOnly).toBe(true);
  expect(plan!.emoji).toBeTruthy();
  expect(plan!.gradient.length).toBe(2);
});

test("isSubagentType / normalizeSubagentType 识别 Plan", () => {
  expect(isSubagentType("Plan")).toBe(true);
  expect(isSubagentType("规划子智能体")).toBe(true);
  expect(normalizeSubagentType("规划子智能体")).toBe("Plan");
  expect(normalizeSubagentType("Plan")).toBe("Plan");
});

// ---- SUBAGENT_OVERRIDES_FILE：内置 subagent 的 model/thinking 覆盖文件路径 ----

test("SUBAGENT_OVERRIDES_FILE 指向 ~/.hiagent/subagent-overrides.json", () => {
  expect(SUBAGENT_OVERRIDES_FILE.endsWith("subagent-overrides.json")).toBe(true);
  expect(SUBAGENT_OVERRIDES_FILE.includes("hiagent")).toBe(true);
});
