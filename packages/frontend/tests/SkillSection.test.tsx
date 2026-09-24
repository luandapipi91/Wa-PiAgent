import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { SYSTEM_PROJECT_ID, SYSTEM_PROJECT_NAME } from "@wa-pi/shared";
import { SkillSection } from "../src/components/settings/SkillSection";
import { useSkillsStore } from "../src/store/skills";
import { useProjectsStore } from "../src/store/projects";
import type { SkillInfo } from "@wa-pi/shared";

// 组件挂载与开关交互会触发 api（真实 fetch），happy-dom 在 about:blank 下对相对 URL
// 抛 NotSupportedError，这里 mock 掉 api-client。
mock.module("../src/api-client", () => ({
  api: {
    get: () => Promise.resolve(null),
    post: () => Promise.resolve({}),
    put: () => Promise.resolve({}),
    del: () => Promise.resolve({}),
  },
}));

// 捕获 store 原始 action 方法，避免测试间 mock 泄漏
const originalActions = {
  toggleSkill: useSkillsStore.getState().toggleSkill,
  load: useSkillsStore.getState().load,
};
const originalProjects = useProjectsStore.getState().projects;

const SYSTEM_DIR = "/Users/co/.pi/agent/workdir/.pi/skills";
const GLOBAL_DIR = "/Users/co/.pi/agent/skills";
const HLK_CWD = "/Users/co/Documents/work/hlk";

beforeEach(() => {
  // 项目列表与记忆页同源：技能页的项目分组与选择器依赖 useProjectsStore
  useProjectsStore.setState({
    projects: [
      {
        id: SYSTEM_PROJECT_ID,
        name: SYSTEM_PROJECT_NAME,
        cwd: "/Users/co/.pi/agent/workdir",
        createdAt: 0,
      },
      { id: "p1", name: "Wa-Pi", cwd: "/tmp/Wa-Pi", createdAt: 0 },
    ],
  });
  useSkillsStore.setState({
    skills: [],
    allSkills: [],
    dirs: [],
    disabledSkills: [],
    builtinDir: GLOBAL_DIR,
    loading: false,
    selectedProjectId: SYSTEM_PROJECT_ID,
    toggleSkill: originalActions.toggleSkill,
    load: originalActions.load,
  });
});

afterEach(() => {
  useProjectsStore.setState({ projects: originalProjects });
});

// ===== 目录区（只读）=====

test("技能目录默认折叠，且折叠态只显示所选项目自己的技能目录路径", () => {
  useSkillsStore.setState({
    dirs: [
      {
        path: SYSTEM_DIR,
        type: "project",
        projectId: SYSTEM_PROJECT_ID,
        projectName: SYSTEM_PROJECT_NAME,
      },
      { path: GLOBAL_DIR, type: "builtin" },
    ],
    builtinDir: GLOBAL_DIR,
    allSkills: [],
  });
  render(<SkillSection />);
  const toggleBtn = screen.getByTestId("skill-dir-toggle");
  expect(toggleBtn.textContent).toContain("技能目录");
  // 折叠态显示所选项目自己的目录路径，而非内置目录
  expect(toggleBtn.textContent).toContain(SYSTEM_DIR);
  expect(toggleBtn.textContent).not.toContain(GLOBAL_DIR);
  // 默认折叠：目录列表未渲染
  expect(screen.queryByTestId(`skill-dir-open-${GLOBAL_DIR}`)).toBeNull();
});

test("展开技能目录后，标题不再显示目录路径", () => {
  useSkillsStore.setState({
    dirs: [{ path: GLOBAL_DIR, type: "builtin" }],
    builtinDir: GLOBAL_DIR,
    allSkills: [],
  });
  render(<SkillSection />);
  fireEvent.click(screen.getByTestId("skill-dir-toggle"));
  const toggleBtn = screen.getByTestId("skill-dir-toggle");
  expect(toggleBtn.textContent).toContain("技能目录");
  expect(toggleBtn.textContent).not.toContain(GLOBAL_DIR);
});

test("技能页不再有添加目录按钮", () => {
  useSkillsStore.setState({ dirs: [], builtinDir: GLOBAL_DIR, allSkills: [] });
  render(<SkillSection />);
  expect(screen.queryByTestId("skill-add-dir-btn")).toBeNull();
});

test("技能页不再有任何目录删除按钮", () => {
  useSkillsStore.setState({
    builtinDir: GLOBAL_DIR,
    dirs: [
      { path: GLOBAL_DIR, type: "builtin" },
      {
        path: "/Users/co/work/Wa-Pi/.pi/skills",
        type: "project",
        projectId: "p1",
        projectName: "Wa-Pi",
      },
    ],
    allSkills: [],
  });
  render(<SkillSection />);
  expect(screen.queryByTestId(`skill-dir-remove-${GLOBAL_DIR}`)).toBeNull();
  expect(document.querySelector('[data-testid^="skill-dir-remove-"]')).toBeNull();
});

test("点击刷新技能按钮重新加载技能目录", () => {
  const loadMock = mock();
  useSkillsStore.setState({ load: loadMock, allSkills: [] });
  render(<SkillSection />);
  const refreshBtn = screen.getByTestId("skill-refresh-btn");
  expect(refreshBtn.getAttribute("aria-label")).toBe("刷新技能");
  fireEvent.click(refreshBtn);
  expect(loadMock).toHaveBeenCalledTimes(1);
});

test("刷新按钮为 icon 按钮，与技能目录标题同行且右对齐", () => {
  useSkillsStore.setState({ allSkills: [] });
  render(<SkillSection />);
  const toggleBtn = screen.getByTestId("skill-dir-toggle");
  const refreshBtn = screen.getByTestId("skill-refresh-btn");
  // 按钮不含文字，使用 svg icon
  expect(refreshBtn.textContent).toBe("");
  expect(refreshBtn.querySelector("svg")).toBeTruthy();
  // 与标题同一行容器，且容器为 justify-between（右对齐）
  const headerRow = toggleBtn.parentElement!;
  expect(headerRow.className).toContain("justify-between");
  expect(headerRow.contains(refreshBtn)).toBe(true);
});

test("展开后按 该项目 / 全局 / 插件 顺序显示目录，且不含其它项目目录", () => {
  useSkillsStore.setState({
    selectedProjectId: "hlk",
    dirs: [
      {
        path: `${HLK_CWD}/.pi/skills`,
        type: "project",
        projectId: "hlk",
        projectName: "hlk",
      },
      {
        path: "/tmp/other/.pi/skills",
        type: "project",
        projectId: "other",
        projectName: "其它项目",
      },
      { path: GLOBAL_DIR, type: "builtin" },
      {
        path: "/Users/co/.pi/agent/npm/node_modules/superpowers-zh/skills",
        type: "extension",
        name: "superpowers-zh",
      },
    ],
    allSkills: [],
  });
  render(<SkillSection />);
  fireEvent.click(screen.getByTestId("skill-dir-toggle"));
  // 顺序：该项目目录 → 全局目录 → 插件目录
  const order = Array.from(
    document.querySelectorAll('[data-testid^="skill-dir-open-"]'),
  ).map((el) => el.getAttribute("data-testid"));
  expect(order).toEqual([
    `skill-dir-open-${HLK_CWD}/.pi/skills`,
    `skill-dir-open-${GLOBAL_DIR}`,
    "skill-dir-open-/Users/co/.pi/agent/npm/node_modules/superpowers-zh/skills",
  ]);
  // 其它项目的目录被过滤掉
  expect(screen.queryByText("/tmp/other/.pi/skills")).toBeNull();
});

test("切换到某项目后，折叠态显示该项目的技能目录路径", () => {
  useProjectsStore.setState({
    projects: [
      {
        id: SYSTEM_PROJECT_ID,
        name: SYSTEM_PROJECT_NAME,
        cwd: "/Users/co/.pi/agent/workdir",
        createdAt: 0,
      },
      { id: "hlk", name: "hlk", cwd: HLK_CWD, createdAt: 0 },
    ],
  });
  useSkillsStore.setState({
    selectedProjectId: SYSTEM_PROJECT_ID,
    dirs: [
      {
        path: SYSTEM_DIR,
        type: "project",
        projectId: SYSTEM_PROJECT_ID,
        projectName: SYSTEM_PROJECT_NAME,
      },
      {
        path: `${HLK_CWD}/.pi/skills`,
        type: "project",
        projectId: "hlk",
        projectName: "hlk",
      },
      { path: GLOBAL_DIR, type: "builtin" },
    ],
    allSkills: [],
  });
  render(<SkillSection />);
  expect(screen.getByTestId("skill-dir-toggle").textContent).toContain(SYSTEM_DIR);

  fireEvent.click(screen.getByTestId("skill-scope-select"));
  fireEvent.click(screen.getByTestId("skill-scope-option-project-hlk"));

  expect(useSkillsStore.getState().selectedProjectId).toBe("hlk");
  expect(screen.getByTestId("skill-dir-toggle").textContent).toContain(
    `${HLK_CWD}/.pi/skills`,
  );
});

// ===== 搜索过滤测试 =====

test("搜索框输入即实时过滤技能（按名称，大小写不敏感）", () => {
  useSkillsStore.setState({
    allSkills: [
      {
        name: "brave-search",
        description: "web 搜索",
        path: "/skills/brave-search",
      },
      { name: "pdf-tools", description: "PDF 处理", path: "/skills/pdf-tools" },
    ],
  });
  render(<SkillSection />);
  const input = screen.getByTestId("skill-search-input");
  fireEvent.change(input, { target: { value: "BRAVE" } });
  expect(screen.getByText("brave-search")).toBeTruthy();
  expect(screen.queryByText("pdf-tools")).toBeNull();
});

test("清空搜索后恢复完整技能列表", () => {
  useSkillsStore.setState({
    allSkills: [
      {
        name: "brave-search",
        description: "web 搜索",
        path: "/skills/brave-search",
      },
      { name: "pdf-tools", description: "PDF 处理", path: "/skills/pdf-tools" },
    ],
  });
  render(<SkillSection />);
  const input = screen.getByTestId("skill-search-input");
  fireEvent.change(input, { target: { value: "brave" } });
  expect(screen.queryByText("pdf-tools")).toBeNull();
  fireEvent.change(input, { target: { value: "" } });
  expect(screen.getByText("brave-search")).toBeTruthy();
  expect(screen.getByText("pdf-tools")).toBeTruthy();
});

test("搜索无匹配时显示提示", () => {
  useSkillsStore.setState({
    allSkills: [
      {
        name: "brave-search",
        description: "web 搜索",
        path: "/skills/brave-search",
      },
    ],
  });
  render(<SkillSection />);
  fireEvent.change(screen.getByTestId("skill-search-input"), {
    target: { value: "不存在" },
  });
  expect(screen.getByText("无匹配的技能")).toBeTruthy();
});

test("无任何技能时显示空态", () => {
  useSkillsStore.setState({ allSkills: [] });
  render(<SkillSection />);
  expect(screen.getByText("暂无技能")).toBeTruthy();
});

// ===== 选中项目（选择器 + 技能列表）=====

test("选择器只列默认工作区与各项目，不含「全部」和「全局技能」", () => {
  useSkillsStore.setState({ allSkills: [] });
  render(<SkillSection />);
  // 触发按钮显示当前选中项（默认工作区）
  expect(screen.getByTestId("skill-scope-select").textContent).toContain(
    `📁 ${SYSTEM_PROJECT_NAME}`,
  );

  fireEvent.click(screen.getByTestId("skill-scope-select"));
  const menu = screen.getByTestId("skill-scope-menu");
  // 只有「默认工作区 + 各项目」两项，且默认工作区排在最前
  const order = Array.from(
    menu.querySelectorAll('[data-testid^="skill-scope-option-project-"]'),
  ).map((el) => el.getAttribute("data-testid"));
  expect(order).toEqual([
    `skill-scope-option-project-${SYSTEM_PROJECT_ID}`,
    "skill-scope-option-project-p1",
  ]);
  expect(menu.textContent).not.toContain("全部");
  expect(menu.textContent).not.toContain("全局技能");
  // 旧选项不再存在
  expect(screen.queryByTestId("skill-scope-option-all")).toBeNull();
  expect(screen.queryByTestId("skill-scope-option-global")).toBeNull();
});

test("选中默认工作区时列出全局与 Plugin 技能，排除其它项目的项目技能", () => {
  useSkillsStore.setState({
    selectedProjectId: SYSTEM_PROJECT_ID,
    allSkills: [
      { name: "g-skill", description: "", path: "/b/g", source: { type: "builtin" } },
      {
        name: "e-skill",
        description: "",
        path: "/x/e",
        source: { type: "extension", name: "pack" },
      },
      {
        name: "sys-skill",
        description: "",
        path: "/s/s",
        source: {
          type: "project",
          projectId: SYSTEM_PROJECT_ID,
          projectName: SYSTEM_PROJECT_NAME,
        },
      },
      {
        name: "other-skill",
        description: "",
        path: "/o/o",
        source: { type: "project", projectId: "p1", projectName: "Wa-Pi" },
      },
    ],
  });
  render(<SkillSection />);
  expect(screen.getByTestId("skill-row-g-skill")).toBeTruthy();
  expect(screen.getByTestId("skill-row-e-skill")).toBeTruthy();
  expect(screen.getByTestId("skill-row-sys-skill")).toBeTruthy();
  expect(screen.queryByTestId("skill-row-other-skill")).toBeNull();
  expect(screen.getByText("全局技能 1 项")).toBeTruthy();
  expect(screen.getByText("Plugin 技能 1 项")).toBeTruthy();
});

test("切到某项目后展示该项目技能，同时带出全局与 Plugin 技能（他项目技能不出现）", () => {
  useSkillsStore.setState({
    allSkills: [
      { name: "g-skill", description: "", path: "/b/g", source: { type: "builtin" } },
      {
        name: "p-skill",
        description: "",
        path: "/p/p",
        source: { type: "project", projectId: "p1", projectName: "Wa-Pi" },
      },
      {
        name: "other-skill",
        description: "",
        path: "/o/o",
        source: { type: "project", projectId: "p2", projectName: "其它项目" },
      },
    ],
  });
  render(<SkillSection />);
  fireEvent.click(screen.getByTestId("skill-scope-select"));
  fireEvent.click(screen.getByTestId("skill-scope-option-project-p1"));

  expect(useSkillsStore.getState().selectedProjectId).toBe("p1");
  expect(screen.getByText("p-skill")).toBeTruthy();
  expect(screen.getByText("项目 skill（Wa-Pi）")).toBeTruthy();
  expect(screen.getByText("项目技能 · Wa-Pi 1 项")).toBeTruthy();
  // 全局技能带出，他项目技能不出现
  expect(screen.getByText("g-skill")).toBeTruthy();
  expect(screen.queryByText("other-skill")).toBeNull();
});

test("范围选择器位于技能目录行内，且 DOM 顺序早于刷新按钮", () => {
  useSkillsStore.setState({ allSkills: [] });
  render(<SkillSection />);
  const header = screen.getByTestId("skill-dir-header");
  const scope = screen.getByTestId("skill-scope-select");
  const refresh = screen.getByTestId("skill-refresh-btn");
  expect(header.contains(scope)).toBe(true);
  expect(header.contains(refresh)).toBe(true);
  const order = Array.from(
    header.querySelectorAll(
      '[data-testid="skill-scope-select"],[data-testid="skill-refresh-btn"]',
    ),
  ).map((el) => el.getAttribute("data-testid"));
  expect(order).toEqual(["skill-scope-select", "skill-refresh-btn"]);
});

test("范围下拉菜单经 portal 挂到页面最外层，选中选项后从 document 移除", () => {
  useSkillsStore.setState({ allSkills: [] });
  const { container } = render(<SkillSection />);
  const trigger = screen.getByTestId("skill-scope-select");
  // 触发按钮标记展开态
  expect(trigger.getAttribute("aria-expanded")).toBe("false");

  fireEvent.click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");

  // 菜单与遮罩都不在 render 容器内（说明已 portal 到页面最外层），但存在于 document
  expect(container.querySelector('[data-testid="skill-scope-menu"]')).toBeNull();
  expect(container.querySelector('[data-testid="skill-scope-backdrop"]')).toBeNull();
  expect(document.querySelector('[data-testid="skill-scope-menu"]')).toBeTruthy();
  expect(document.querySelector('[data-testid="skill-scope-backdrop"]')).toBeTruthy();

  // 选中一个选项后菜单从 document 移除
  fireEvent.click(screen.getByTestId(`skill-scope-option-project-p1`));
  expect(document.querySelector('[data-testid="skill-scope-menu"]')).toBeNull();
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});

test("按 Escape 关闭范围下拉菜单", () => {
  useSkillsStore.setState({ allSkills: [] });
  render(<SkillSection />);
  fireEvent.click(screen.getByTestId("skill-scope-select"));
  expect(document.querySelector('[data-testid="skill-scope-menu"]')).toBeTruthy();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(document.querySelector('[data-testid="skill-scope-menu"]')).toBeNull();
});

test("扩展来源标签为 Plugin skill（包名）", () => {
  useSkillsStore.setState({
    allSkills: [
      { name: "e-skill", description: "", path: "/e/x", source: { type: "extension", name: "superpowers-zh" } },
    ],
  });
  render(<SkillSection />);
  expect(screen.getByText("Plugin skill（superpowers-zh）")).toBeTruthy();
});

test("被禁用的技能仍显示并标注「禁用」", () => {
  useSkillsStore.setState({
    allSkills: [
      { name: "g-skill", description: "", path: "/b/g", source: { type: "builtin" } },
    ],
    disabledSkills: ["g-skill"],
  });
  render(<SkillSection />);
  expect(screen.getByText("g-skill")).toBeTruthy();
  expect(screen.getByText("禁用")).toBeTruthy();
  expect(screen.getByTestId("skill-switch-g-skill").getAttribute("data-on")).toBe("false");
});

test("同名被遮蔽的内置条目只显示所选项目的版本", () => {
  useSkillsStore.setState({
    selectedProjectId: "p1",
    allSkills: [
      { name: "dup", description: "项目版", path: "/p/dup", source: { type: "project", projectId: "p1", projectName: "Wa-Pi" } },
      { name: "dup", description: "内置版", path: "/b/dup", source: { type: "builtin" }, shadowed: true },
    ],
  });
  render(<SkillSection />);
  const rows = screen.getAllByTestId("skill-row-dup");
  expect(rows.length).toBe(1);
  expect(rows[0].textContent).toContain("项目 skill（Wa-Pi）");
  expect(screen.queryByText("全局 skill")).toBeNull();
});

// ===== 技能行交互 =====

test("技能列表渲染 + switch 开关在右侧", () => {
  const toggleMock = mock();
  useSkillsStore.setState({
    allSkills: [
      {
        name: "brave-search",
        description: "web 搜索",
        path: "/skills/brave-search",
      },
      { name: "pdf-tools", description: "PDF 处理", path: "/skills/pdf-tools" },
    ],
    disabledSkills: ["pdf-tools"],
    toggleSkill: toggleMock,
  });
  render(<SkillSection />);
  expect(screen.getByText("brave-search")).toBeTruthy();
  expect(screen.getByText("pdf-tools")).toBeTruthy();

  // switch 开关替代了旧的 checkbox，放在每行最右侧
  const pdfSwitch = screen.getByTestId("skill-switch-pdf-tools");
  expect(pdfSwitch).toBeTruthy();
  // pdf-tools 被禁用，toggle 应显示为 off 状态
  expect(pdfSwitch.getAttribute("data-on")).toBe("false");

  // 点击开关切换
  fireEvent.click(pdfSwitch);
  expect(toggleMock).toHaveBeenCalledWith("pdf-tools");

  // brave-search 是启用状态
  const braveSwitch = screen.getByTestId("skill-switch-brave-search");
  expect(braveSwitch.getAttribute("data-on")).toBe("true");
});

test("开关点击立即乐观更新 UI，不等待服务端响应", () => {
  // 使用真实的 toggleSkill（会发起 HTTP 但在 happy-dom 中静默失败）
  useSkillsStore.setState({
    allSkills: [{ name: "skill-a", description: "A", path: "/a" }],
    disabledSkills: [],
    toggleSkill: originalActions.toggleSkill,
  });
  render(<SkillSection />);

  const getSwitch = () => screen.getByTestId("skill-switch-skill-a");
  expect(getSwitch().getAttribute("data-on")).toBe("true");

  // 点击关闭 → 立即变为 OFF（乐观更新，不等 SSE）
  fireEvent.click(getSwitch());
  expect(getSwitch().getAttribute("data-on")).toBe("false");

  // 再次点击 → 立即变为 ON
  fireEvent.click(getSwitch());
  expect(getSwitch().getAttribute("data-on")).toBe("true");
});

// ===== 分组测试 =====

test("无 source 的技能归入全局技能分组", () => {
  useSkillsStore.setState({
    allSkills: [
      {
        name: "brainstorming",
        description: "创意工作前使用",
        path: "/skills/brainstorming",
      },
    ],
  });
  render(<SkillSection />);
  expect(screen.getByText("全局技能 1 项")).toBeTruthy();
  expect(screen.getByText("brainstorming")).toBeTruthy();
});

test("builtin 类型技能显示「全局 skill」标签", () => {
  useSkillsStore.setState({
    allSkills: [
      {
        name: "brainstorming",
        description: "desc",
        path: "/p",
        source: { type: "builtin" },
      },
    ],
  });
  render(<SkillSection />);
  expect(screen.getByText("全局技能 1 项")).toBeTruthy();
  expect(screen.getByText("全局 skill")).toBeTruthy();
});

test("extension 类型技能单独分组并显示插件名标签", () => {
  useSkillsStore.setState({
    allSkills: [
      {
        name: "pdf",
        description: "PDF 处理",
        path: "/ext/pdf",
        source: { type: "extension", name: "zcode-guide" },
      },
    ],
  });
  render(<SkillSection />);
  expect(screen.getByText("Plugin 技能 1 项")).toBeTruthy();
  expect(screen.getByText("Plugin skill（zcode-guide）")).toBeTruthy();
});

test("project 类型技能按项目分组并显示项目名标签", () => {
  useSkillsStore.setState({
    selectedProjectId: "p1",
    allSkills: [
      {
        name: "p-skill",
        description: "",
        path: "/p/p",
        source: { type: "project", projectId: "p1", projectName: "Wa-Pi" },
      },
    ],
  });
  render(<SkillSection />);
  expect(screen.getByText("项目技能 · Wa-Pi 1 项")).toBeTruthy();
  expect(screen.getByText("项目 skill（Wa-Pi）")).toBeTruthy();
});

test("多个 source 类型混合分组正确", () => {
  const skills: SkillInfo[] = [
    {
      name: "builtin-a",
      description: "",
      path: "/b/a",
      source: { type: "builtin" },
    },
    {
      name: "builtin-b",
      description: "",
      path: "/b/b",
      source: { type: "builtin" },
    },
    {
      name: "plugin-x",
      description: "",
      path: "/p/x",
      source: { type: "extension", name: "pkg-a" },
    },
    {
      name: "plugin-y",
      description: "",
      path: "/p/y",
      source: { type: "extension", name: "pkg-a" },
    },
    {
      name: "project-1",
      description: "",
      path: "/l/1",
      source: { type: "project", projectId: "p1", projectName: "Wa-Pi" },
    },
  ];
  useSkillsStore.setState({ selectedProjectId: "p1", allSkills: skills });
  render(<SkillSection />);
  expect(screen.getByText("全局技能 2 项")).toBeTruthy();
  expect(screen.getByText("Plugin 技能 2 项")).toBeTruthy();
  expect(screen.getByText("项目技能 · Wa-Pi 1 项")).toBeTruthy();
});

test("空分组不显示标题", () => {
  useSkillsStore.setState({
    allSkills: [
      {
        name: "only-plugin",
        description: "",
        path: "/p",
        source: { type: "extension", name: "pkg" },
      },
    ],
  });
  render(<SkillSection />);
  // 全局技能与项目技能分组为空，不应显示
  expect(screen.queryByText(/全局技能/)).toBeNull();
  expect(screen.queryByText(/项目技能/)).toBeNull();
  expect(screen.getByText("Plugin 技能 1 项")).toBeTruthy();
});
