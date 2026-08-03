import "./mock-composer-db";
import { test, describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, fireEvent, waitFor, act, cleanup } from "@testing-library/react";
import type { ComponentProps } from "react";
import { composerDbDefaults, composerDbSessions } from "./mock-composer-db";
import { emitEventForTesting, disconnectEvents } from "../src/events";
import { useProvidersStore } from "../src/store/providers";
import { useProjectsStore } from "../src/store/projects";
import { useSkillsStore } from "../src/store/skills";
import { useCommandsStore } from "../src/store/commands";
import { useAgentsStore } from "../src/store/agents";

const apiCalls: { method: string; path: string; body?: any }[] = [];

mock.module("../src/api-client", () => ({
  api: {
    get: (path: string) => { apiCalls.push({ method: "get", path }); return Promise.resolve({}); },
    post: (path: string, body?: any) => { apiCalls.push({ method: "post", path, body }); return Promise.resolve({}); },
    put: (path: string, body?: any) => { apiCalls.push({ method: "put", path, body }); return Promise.resolve({}); },
    del: (path: string) => { apiCalls.push({ method: "del", path }); return Promise.resolve({}); },
  },
  ApiError: class extends Error { status: number; constructor(m: string, s: number) { super(m); this.status = s; this.name = "ApiError"; } },
}));

import { ComposerInput } from "../src/components/ui/ComposerInput";

interface FetchCall {
  url: string;
  fileName?: string;
}

const fetchCalls: FetchCall[] = [];
const originalFetch = globalThis.fetch;
const fetchMock = mock((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : (input as any).href ?? String(input);
  const form = init?.body as FormData | undefined;
  const file = form && typeof form.get === "function" ? (form.get("file") as File | undefined) : undefined;
  fetchCalls.push({ url, fileName: file?.name });
  const projectId = new URL(url, "http://localhost").searchParams.get("projectId") ?? "p1";
  const path = `/project/${projectId}/.wa-pi/uploads/${file?.name ?? "upload"}`;
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ path }) });
}) as any;

beforeEach(() => {
  composerDbDefaults.model = null;
  composerDbDefaults.thinking = "disabled";
  for (const k of Object.keys(composerDbSessions)) delete composerDbSessions[k];

  disconnectEvents();
  apiCalls.length = 0;
  fetchCalls.length = 0;
  fetchMock.mock.calls.length = 0;
  globalThis.fetch = fetchMock;

  useProvidersStore.setState({
    providers: [
      { id: "p1", name: "openai", api: "openai-completions", baseUrl: "", apiKey: "", models: [{ id: "gpt-4o", contextWindow: 128000, maxTokens: 4096 }] },
    ],
  });
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "p1", cwd: "/proj/p1", createdAt: 0 }],
    sessions: [],
    currentProjectId: "p1",
    currentSessionId: null,
    dirPickerOpen: false,
  });
  useSkillsStore.setState({
    skills: [], allSkills: [], dirs: [], disabledSkills: [], builtinDir: "", loading: false,
    load: mock(), setAll: mock(), toggleSkill: mock(), addDir: mock(), removeDir: mock(),
  });
  useAgentsStore.setState({ list: [], configs: {} });
  useCommandsStore.setState({ commands: [], loading: false });
});

// beforeEach 用 mock 整体替换了 skills store 的 action，zustand store 是进程级单例，
// 不还原会泄漏给后面跑的测试文件（如 store-skills.test.ts）——恢复初始 state（含原始 action）
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  useSkillsStore.setState(useSkillsStore.getInitialState(), true);
  useCommandsStore.setState(useCommandsStore.getInitialState(), true);
});

function renderComposer(props?: Partial<ComponentProps<typeof ComposerInput>>) {
  return render(
    <ComposerInput
      text="hello"
      setText={mock()}
      model="openai/gpt-4o"
      setModel={mock()}
      thinking="disabled"
      setThinking={mock()}
      attachments={[]}
      setAttachments={mock() as any}
      projectId="p1"
      sessionId="s1"
      onSend={mock()}
      placeholder="输入..."
      {...props}
    />
  );
}

function completeLatestUpload(_expectedPath: string) {
  const call = fetchCalls.at(-1);
  expect(call).toBeTruthy();
  const url = new URL(call!.url, "http://localhost");
  const projectId = url.searchParams.get("projectId");
  const name = call!.fileName!;
  return { projectId, name };
}

test("calls onSend with text when clicking send", () => {
  const onSend = mock();
  renderComposer({ onSend });
  fireEvent.click(screen.getByTestId("composer-send"));
  expect(onSend).toHaveBeenCalled();
});

test("disables send and shows placeholder when no model is selected", () => {
  useProvidersStore.setState({
    providers: [
      { id: "p1", name: "openai", api: "openai-completions", baseUrl: "", apiKey: "", models: [{ id: "gpt-4o", contextWindow: 128000, maxTokens: 4096 }] },
    ],
  });
  renderComposer({ model: null });
  const select = screen.getByTestId("model-selector") as HTMLSelectElement;
  expect(select.value).toBe("");
  expect(screen.getByText("选择模型")).toBeTruthy();
  expect((screen.getByTestId("composer-send") as HTMLButtonElement).disabled).toBe(true);
});

test("过期 model（provider 已删除，prefs 残留）→ 禁止发送：按钮禁用、点击与回车均不触发 onSend", () => {
  // providers 为空，但 prefs 里残留着已删除 provider 的 model —— 复现"未配置模型也能发消息"
  useProvidersStore.setState({ providers: [] });
  const onSend = mock();
  renderComposer({ model: "my-deepseek/deepseek-chat", onSend });

  const sendBtn = screen.getByTestId("composer-send") as HTMLButtonElement;
  expect(sendBtn.disabled).toBe(true);
  fireEvent.click(sendBtn);
  expect(onSend).not.toHaveBeenCalled();

  const textbox = screen.getByRole("textbox");
  fireEvent.keyDown(textbox, { key: "Enter" });
  expect(onSend).not.toHaveBeenCalled();
});

test("model 不在当前 providers 中（删了其中一个 provider）→ 禁止发送", () => {
  useProvidersStore.setState({
    providers: [
      { id: "p1", name: "openai", api: "openai-completions", baseUrl: "", apiKey: "", models: [{ id: "gpt-4o", contextWindow: 128000, maxTokens: 4096 }] },
    ],
  });
  const onSend = mock();
  renderComposer({ model: "my-deepseek/deepseek-chat", onSend });
  expect((screen.getByTestId("composer-send") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByTestId("composer-send"));
  expect(onSend).not.toHaveBeenCalled();
});

test("uploads selected file to project directory and adds attachment chip", async () => {
  const setAttachments = mock() as any;
  const file = new File(["hello"], "notes.txt", { type: "text/plain" });

  renderComposer({ setAttachments });

  const input = screen.getByTestId("composer-input").querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });

  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  const sent = completeLatestUpload("/project/p1/.wa-pi/uploads/notes.txt");
  expect(sent.projectId).toBe("p1");
  expect(sent.name).toBe("notes.txt");

  await waitFor(() => expect(setAttachments).toHaveBeenCalled());
  const updater = setAttachments.mock.calls[0][0];
  const attachments = updater([]);
  expect(attachments).toHaveLength(1);
  expect(attachments[0]).toMatchObject({
    kind: "file",
    name: "notes.txt",
    path: "/project/p1/.wa-pi/uploads/notes.txt",
  });
});

test("uploads pasted file from clipboard", async () => {
  const setAttachments = mock() as any;
  const file = new File(["pasted"], "pasted.txt", { type: "text/plain" });

  renderComposer({ setAttachments });

  const textbox = screen.getByTestId("composer-input").querySelector('[role="textbox"]')!;
  fireEvent.paste(textbox, { clipboardData: { files: [file] } });

  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  completeLatestUpload("/project/p1/.wa-pi/uploads/pasted.txt");

  await waitFor(() => expect(setAttachments).toHaveBeenCalled());
  const attachments = setAttachments.mock.calls[0][0]([]);
  expect(attachments[0]).toMatchObject({ kind: "file", name: "pasted.txt" });
});

test("uploads dropped file into composer", async () => {
  const setAttachments = mock() as any;
  const file = new File(["dropped"], "dropped.png", { type: "image/png" });

  renderComposer({ setAttachments });

  const composer = screen.getByTestId("composer-input").firstChild!;
  fireEvent.drop(composer, { dataTransfer: { files: [file] } });

  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  completeLatestUpload("/project/p1/.wa-pi/uploads/dropped.png");

  await waitFor(() => expect(setAttachments).toHaveBeenCalled());
  const attachments = setAttachments.mock.calls[0][0]([]);
  expect(attachments[0]).toMatchObject({ kind: "image", name: "dropped.png" });
});

test("plain text paste is not intercepted", async () => {
  const setText = mock();
  renderComposer({ setText });

  const textbox = screen.getByTestId("composer-input").querySelector('[role="textbox"]')!;
  fireEvent.paste(textbox, { clipboardData: { files: [] } });

  await new Promise(r => setTimeout(r, 50));
  expect(fetchMock).not.toHaveBeenCalled();
});

// === 富文本粘贴净化 ===

test("粘贴富文本 HTML：只保留纯文本，不插入 HTML 样式", async () => {
  const setText = mock();
  renderComposer({ setText, text: "" });

  const textbox = screen.getByTestId("composer-input").querySelector('[role="textbox"]')!;
  fireEvent.paste(textbox, {
    clipboardData: {
      files: [],
      getData: (type: string) =>
        type === "text/html"
          ? '<span style="color:red;font-weight:bold">加粗<b>内容</b></span>'
          : "加粗内容",
    },
  });

  await waitFor(() => expect(setText).toHaveBeenCalledWith("加粗内容"));
});

test("粘贴多行富文本：纯文本保留换行，丢弃 HTML 结构", async () => {
  const setText = mock();
  renderComposer({ setText, text: "" });

  const textbox = screen.getByTestId("composer-input").querySelector('[role="textbox"]')!;
  fireEvent.paste(textbox, {
    clipboardData: {
      files: [],
      getData: (type: string) =>
        type === "text/html"
          ? '<div style="color:red">第一行</div><div>第二行</div>'
          : "第一行\n第二行",
    },
  });

  await waitFor(() => expect(setText).toHaveBeenCalledWith("第一行\n第二行"));
});

// === Quick Invoke 测试 ===

test("输入 # 触发文件面板", async () => {
  const setText = mock();
  renderComposer({ text: "你好 #App", setText });

  await waitFor(() => {
    expect(apiCalls.some(c => c.path === "/api/fs/search" && c.body?.query === "App")).toBe(true);
  });

  // 面板容器应渲染（无结果时显示空提示）
  expect(screen.getByTestId("quick-invoke-menu")).toBeTruthy();
});

test("#文件搜索结果中目录项传递 isDir 并显示文件夹图标", async () => {
  renderComposer({ text: "打开 #src" });

  let req: any;
  await waitFor(() => {
    req = apiCalls.find(c => c.path === "/api/fs/search" && c.body?.query === "src");
    expect(req).toBeTruthy();
  });

  // 让 searchFilesStream 的动态 import("../src/events") 落定
  await act(async () => {});

  act(() => {
    emitEventForTesting({
      type: "fs:search:progress",
      requestId: req.body.requestId,
      query: "src",
      durationMs: 10,
      truncated: false,
      matches: [
        { name: "src", isDir: true, path: "/proj/p1/src" },
        { name: "App.tsx", isDir: false, path: "/proj/p1/src/App.tsx" },
      ],
    });
  });

  // 文件夹图标应出现
  expect(screen.getByText("📁")).toBeDefined();
  // 文件图标也应出现
  expect(screen.getByText("📄")).toBeDefined();
});

test("输入 @ 触发智能体面板（数据来自 useAgentsStore.list，按 displayName/description 过滤）", () => {
  useAgentsStore.setState({
    list: [
      { displayName: "需求设计", partners: { askTo: ["质量验收"] }, description: "梳理需求、输出 PRD" },
      { displayName: "质量验收", partners: { askTo: [] }, description: "测试与验收" },
    ] as any,
  });
  renderComposer({ text: "@质量", currentAgentName: "需求设计" });
  // 命中的智能体显示 displayName
  expect(screen.getByText("质量验收")).toBeDefined();
  // 当前主智能体自身被排除
  expect(screen.queryByText("需求设计")).toBeNull();
});

test("@ 面板空结果显示 无匹配智能体", () => {
  useAgentsStore.setState({ list: [] });
  renderComposer({ text: "@xyz" });
  expect(screen.getByText("无匹配智能体")).toBeDefined();
});

test("选中智能体后生成 @[name] chip token 并回调 onAgentMention", () => {
  const setText = mock();
  const onAgentMention = mock();
  // @ 菜单只显示当前主智能体 askTo 名单内的智能体，需同时喂主控与目标
  useAgentsStore.setState({
    list: [
      { displayName: "主控", partners: { askTo: ["需求设计"] }, description: "主控" },
      { displayName: "需求设计", partners: { askTo: [] }, description: "梳理需求" },
    ] as any,
  });
  renderComposer({ text: "@需求", setText, onAgentMention, currentAgentName: "主控" });
  fireEvent.click(screen.getByText("需求设计"));
  expect(setText).toHaveBeenCalled();
  const lastCall = setText.mock.calls.at(-1)?.[0] as string;
  expect(lastCall).toContain("@[需求设计]");
  expect(onAgentMention).toHaveBeenCalledWith("需求设计");
});

test("选中内置 subagent 后生成英文 name 的 @[token]（非中文 displayName）", () => {
  // 核心约束：内置 subagent 的 token 必须用英文 name（@[Plan]），
  // 与 delegate 工具/提示词里的内置类型名一致，避免 LLM 把中文名误当成命名智能体。
  // 卡片显示用中文 displayName，但 token data 存英文。
  const setText = mock();
  const onAgentMention = mock();
  useAgentsStore.setState({
    list: [
    ],
  });
  renderComposer({ text: "@规划", setText, onAgentMention, currentAgentName: "主控" });
  fireEvent.click(screen.getByText("规划子智能体"));
  expect(setText).toHaveBeenCalled();
  const lastCall = setText.mock.calls.at(-1)?.[0] as string;
  expect(lastCall).toContain("@[Plan]");           // 英文 name
  expect(lastCall).not.toContain("@[规划子智能体]"); // 不能是中文 displayName
  expect(onAgentMention).toHaveBeenCalledWith("Plan");
});

test("选中文件后生成 #[path] chip token", async () => {
  const setText = mock();
  renderComposer({ text: "#hello", setText });

  let req: any;
  await waitFor(() => {
    req = apiCalls.find(c => c.path === "/api/fs/search" && c.body?.query === "hello");
    expect(req).toBeTruthy();
  });

  await act(async () => {});

  act(() => {
    emitEventForTesting({
      type: "fs:search:progress",
      requestId: req.body.requestId,
      query: "hello",
      durationMs: 10,
      truncated: false,
      matches: [{ name: "hello.txt", isDir: false, path: "/proj/p1/hello.txt" }],
    });
  });

  fireEvent.click(screen.getByTestId("quick-invoke-item-0"));
  expect(setText).toHaveBeenCalled();
  const lastCall = setText.mock.calls.at(-1)?.[0] as string;
  expect(lastCall).toContain("#[hello.txt]");
});

test("输入 $ 触发技能面板", () => {
  useSkillsStore.setState({
    allSkills: [
      { name: "brainstorming", description: "头脑风暴", path: "/skills/brain", source: { type: "builtin" } },
    ],
    skills: [],
    dirs: [],
    disabledSkills: [],
    builtinDir: "",
  });
  renderComposer({ text: "用 $brain" });
  expect(screen.getByText("brainstorming")).toBeDefined();
});

test("输入全角 ￥（U+FFE5）触发技能面板（Windows 中文输入法场景）", () => {
  useSkillsStore.setState({
    allSkills: [
      { name: "brainstorming", description: "头脑风暴", path: "/skills/brain", source: { type: "builtin" } },
    ],
    skills: [],
    dirs: [],
    disabledSkills: [],
    builtinDir: "",
  });
  renderComposer({ text: "用 \uFFE5brain" });
  expect(screen.getByText("brainstorming")).toBeDefined();
});

test("选中技能后生成 chip token", () => {
  const setText = mock();
  useSkillsStore.setState({
    allSkills: [
      { name: "brainstorming", description: "头脑风暴", path: "/skills/brain", source: { type: "builtin" } },
    ],
    skills: [],
    dirs: [],
    disabledSkills: [],
    builtinDir: "",
  });
  renderComposer({ text: "$brain", setText });
  // 点击技能项
  fireEvent.click(screen.getByText("brainstorming"));
  // setText 应被调用，text 中应包含 $[brainstorming]
  expect(setText).toHaveBeenCalled();
  const lastCall = setText.mock.calls.at(-1)?.[0] as string;
  expect(lastCall).toContain("$[brainstorming]");
  // 不应再包含原始的 $brain 文本
  expect(lastCall).not.toMatch(/\$brain$/);
});

test("面板打开时按 Tab 等同 Enter 选中高亮项", () => {
  const setText = mock();
  useSkillsStore.setState({
    allSkills: [
      { name: "brainstorming", description: "", path: "/s", source: { type: "builtin" } },
    ],
    skills: [], dirs: [], disabledSkills: [], builtinDir: "",
  });
  renderComposer({ text: "$brain", setText });
  const textbox = screen.getByRole("textbox");
  // Tab 选中高亮的技能项
  fireEvent.keyDown(textbox, { key: "Tab" });
  expect(setText).toHaveBeenCalled();
  const lastCall = setText.mock.calls.at(-1)?.[0] as string;
  expect(lastCall).toContain("$[brainstorming]");
});

test("IME 组词中按 Enter 不发送消息（拼音选词确认）", () => {
  const onSend = mock();
  renderComposer({ text: "你好", onSend });
  const textbox = screen.getByRole("textbox");
  // isComposing=true 模拟 IME 正在组词
  fireEvent.keyDown(textbox, { key: "Enter", isComposing: true });
  expect(onSend).not.toHaveBeenCalled();
});

test("IME 组词结束后按 Enter 正常发送", () => {
  const onSend = mock();
  renderComposer({ text: "你好", onSend });
  const textbox = screen.getByRole("textbox");
  // isComposing=false（IME 已确认）正常发送
  fireEvent.keyDown(textbox, { key: "Enter", isComposing: false });
  expect(onSend).toHaveBeenCalledTimes(1);
});

test("Esc 关闭面板保留触发符文本", () => {
  useSkillsStore.setState({
    allSkills: [
      { name: "brainstorming", description: "", path: "/s", source: { type: "builtin" } },
    ],
    skills: [], dirs: [], disabledSkills: [], builtinDir: "",
  });
  renderComposer({ text: "$brain" });
  expect(screen.getByText("brainstorming")).toBeDefined();
  // 按 Esc
  const textbox = screen.getByRole("textbox");
  fireEvent.keyDown(textbox, { key: "Escape" });
  // 面板应消失
  expect(screen.queryByText("brainstorming")).toBeNull();
});

test("发送时 chip token 展开为纯文本", () => {
  // ComposerInput 本身不处理发送时的展开——由 Composer.tsx 调用 expandTokens
  // 这里验证 text 状态包含 token 格式
  const setText = mock();
  useSkillsStore.setState({
    allSkills: [{ name: "pdf", description: "", path: "/s", source: { type: "builtin" } }],
    skills: [], dirs: [], disabledSkills: [], builtinDir: "",
  });
  renderComposer({ text: "$pd", setText });
  fireEvent.click(screen.getByText("pdf"));
  const lastCall = setText.mock.calls.at(-1)?.[0] as string;
  // token 格式为 $[pdf]，发送时由 Composer 展开为 /skill:pdf（SDK _expandSkillCommand 格式）
  expect(lastCall).toContain("$[pdf]");
});

// === Task 1.3: @ 候选菜单只显示 askTo 名单内 ===

describe("ComposerInput @ 候选菜单过滤", () => {
  beforeEach(() => {
    // AgentConfig 无 name 字段，displayName 是唯一标识符
    useAgentsStore.setState({
      list: [
        { displayName: "研发", partners: { askTo: ["代码审查"] }, description: "写代码", avatar: "💻", avatarColor: "" },
        { displayName: "代码审查", partners: { askTo: [] }, description: "评审", avatar: "🔍", avatarColor: "" },
        { displayName: "项目管理", partners: { askTo: [] }, description: "拆需求", avatar: "📋", avatarColor: "" },
      ] as any,
    });
    useProvidersStore.setState({ providers: [{ id: "p1", name: "openai", api: "openai-completions", baseUrl: "", apiKey: "", models: [{ id: "gpt-4o", contextWindow: 128000, maxTokens: 4096 }] }] });
    useProjectsStore.setState({ projects: [{ id: "p1", name: "t", cwd: "/tmp", createdAt: 0 }], currentProjectId: "p1" });
  });

  it("主智能体 askTo=[代码审查] 时，@ 菜单只显示代码审查（排除自己 + 排除不在名单的项目管理）", async () => {
    render(
      <ComposerInput
        text="@" setText={() => {}} model="gpt-4o" setModel={() => {}}
        thinking="disabled" setThinking={() => {}}
        attachments={[]} setAttachments={() => {}}
        projectId="p1" sessionId="s1" onSend={() => {}} currentAgentName="研发"
      />
    );
    await waitFor(() => {
      expect(screen.getByText("代码审查")).toBeDefined();
    });
    expect(screen.queryByText("项目管理")).toBeNull();
    expect(screen.queryByText("研发")).toBeNull(); // 排除当前主智能体
  });

  it("主智能体 askTo 为空时，@ 菜单不再显示空提示（因内置 subagent 类型一定可见）", async () => {
    // 行为变化：追加内置 subagent 类型后，askTo 空时菜单也有候选（通用子智能体/探索子智能体）
    // 所以不再进入 empty 状态，旧版"无可调起"提示不再显示
    render(
      <ComposerInput
        text="@" setText={() => {}} model="gpt-4o" setModel={() => {}}
        thinking="disabled" setThinking={() => {}}
        attachments={[]} setAttachments={() => {}}
        projectId="p1" sessionId="s1" onSend={() => {}} currentAgentName="代码审查"
      />
    );
    // 内置类型一定可见（中文 displayName 显示）
    await waitFor(() => expect(screen.getByText("通用子智能体")).toBeDefined());
    // 旧版"无可调起"提示不再显示（因为有内置候选）
    expect(screen.queryByText("当前智能体无可调起的子智能体，请在智能体配置中设置关系网")).toBeNull();
  });

  it("主智能体 askTo 不为空但查询不匹配时，仍然显示无匹配智能体", async () => {
    render(
      <ComposerInput
        text="@xyz" setText={() => {}} model="gpt-4o" setModel={() => {}}
        thinking="disabled" setThinking={() => {}}
        attachments={[]} setAttachments={() => {}}
        projectId="p1" sessionId="s1" onSend={() => {}} currentAgentName="研发"
      />
    );
    await waitFor(() => {
      expect(screen.getByText("无匹配智能体")).toBeDefined();
    });
  });

  // ---- 内置 subagent 类型（general-purpose / Explore）候选 ----

  it("@ 菜单追加内置 subagent 类型（通用子智能体 / 探索子智能体），与 askTo 名单一起显示", async () => {
    render(
      <ComposerInput
        text="@" setText={() => {}} model="gpt-4o" setModel={() => {}}
        thinking="disabled" setThinking={() => {}}
        attachments={[]} setAttachments={() => {}}
        projectId="p1" sessionId="s1" onSend={() => {}} currentAgentName="研发"
      />
    );
    // askTo 名单内的实名
    await waitFor(() => expect(screen.getByText("代码审查")).toBeDefined());
    // 内置 subagent 类型（用中文 displayName 显示）
    expect(screen.getByText("通用子智能体")).toBeTruthy();
    expect(screen.getByText("探索子智能体")).toBeTruthy();
  });

  it("@ 菜单 askTo 为空时仍显示内置 subagent 类型", async () => {
    // askTo 空的智能体（代码审查）原本会显示"无可调起"提示，
    // 现在因为内置类型追加，应同时显示内置类型
    render(
      <ComposerInput
        text="@" setText={() => {}} model="gpt-4o" setModel={() => {}}
        thinking="disabled" setThinking={() => {}}
        attachments={[]} setAttachments={() => {}}
        projectId="p1" sessionId="s1" onSend={() => {}} currentAgentName="代码审查"
      />
    );
    // 内置类型一定可见（无论 askTo 是否空）
    await waitFor(() => expect(screen.getByText("通用子智能体")).toBeDefined());
    expect(screen.getByText("探索子智能体")).toBeTruthy();
  });

  it("@ 查询 \"探索\" 模糊匹配内置类型（按中文 displayName）", async () => {
    render(
      <ComposerInput
        text="@探索" setText={() => {}} model="gpt-4o" setModel={() => {}}
        thinking="disabled" setThinking={() => {}}
        attachments={[]} setAttachments={() => {}}
        projectId="p1" sessionId="s1" onSend={() => {}} currentAgentName="研发"
      />
    );
    await waitFor(() => expect(screen.getByText("探索子智能体")).toBeDefined());
    // 通用子智能体不匹配 "探索"，不应出现
    expect(screen.queryByText("通用子智能体")).toBeNull();
    // askTo 名单内的"代码审查"也不匹配
    expect(screen.queryByText("代码审查")).toBeNull();
  });

  it("选中内置 subagent 类型后生成 @[英文name] token（中文只做卡片渲染）", async () => {
    const setText = mock();
    const onAgentMention = mock();
    render(
      <ComposerInput
        text="@通用" setText={setText} model="gpt-4o" setModel={() => {}}
        thinking="disabled" setThinking={() => {}}
        attachments={[]} setAttachments={() => {}}
        projectId="p1" sessionId="s1" onSend={() => {}}
        currentAgentName="研发" onAgentMention={onAgentMention}
      />
    );
    await waitFor(() => expect(screen.getByText("通用子智能体")).toBeDefined());
    fireEvent.click(screen.getByText("通用子智能体"));
    const lastCall = setText.mock.calls.at(-1)?.[0] as string;
    // token 用英文 name（与 delegate 工具/提示词一致），卡片显示才是中文 displayName
    expect(lastCall).toContain("@[general-purpose]");
    expect(lastCall).not.toContain("@[通用子智能体]");
    expect(onAgentMention).toHaveBeenCalledWith("general-purpose");
  });
});

// ─── / 命令菜单：pi 框架命令 + 动态插件命令 ──────────────────────────────
describe("ComposerInput / 命令菜单（pi 命令动态注册）", () => {
  it("输入 / 显示前端 handler 命令 + pi 框架命令", () => {
    renderComposer({ text: "/" });
    // 前端 handler 命令
    expect(screen.getByText("系统设置")).toBeDefined();
    expect(screen.getByText("重载配置")).toBeDefined();
    // 注：pi 框架内置命令（model/compact/...）已在 ComposerInput 的 PI_FRAMEWORK_COMMANDS
    // 中全部注释移除（产品决策不再暴露），故不再断言。动态插件命令见下个 case。
  });

  it("pi 动态命令（插件贡献）来自 useCommandsStore 并显示在菜单", () => {
    useCommandsStore.setState({
      commands: [
        { name: "goal", description: "设定目标", source: "extension" },
        { name: "review", description: "代码审查", source: "prompt" },
      ],
      loading: false,
    });
    renderComposer({ text: "/" });
    expect(screen.getByText("goal")).toBeDefined();
    expect(screen.getByText("review")).toBeDefined();
  });

  it("选中 pi 命令时清除 / 触发文本并 dispatch wa-pi:pi-command 事件", () => {
    // pi 框架内置命令（model/compact/...）已全部注释移除，改用 prompt 模板命令
    // 验证同一 dispatch 路径（wa-pi:pi-command）。
    useCommandsStore.setState({
      commands: [{ name: "myreview", description: "我的审查", source: "prompt" }],
      loading: false,
    });
    const setText = mock();
    const handler = mock();
    window.addEventListener("wa-pi:pi-command", handler);
    try {
      renderComposer({ text: "/myr", setText });
      // 同步断言（与上方「pi 动态命令」case 一致）：load() 异步尚未清空 commands
      fireEvent.click(screen.getByText("myreview"));
      // setText 被调用，清除了 /myr 触发文本
      expect(setText).toHaveBeenCalled();
      const lastCall = setText.mock.calls.at(-1)?.[0] as string;
      expect(lastCall).not.toMatch(/\/myr$/);
      // 应 dispatch wa-pi:pi-command 事件，detail.text 为 /myreview
      expect(handler).toHaveBeenCalled();
      const detail = handler.mock.calls.at(-1)?.[0]?.detail;
      expect(detail?.text).toBe("/myreview");
    } finally {
      window.removeEventListener("wa-pi:pi-command", handler);
    }
  });

  it("选中插件命令（extension）插入 /[命令名] chip token 到输入框", () => {
    useCommandsStore.setState({
      commands: [{ name: "goal", description: "设定目标", source: "extension" }],
      loading: false,
    });
    const setText = mock();
    const piHandler = mock();
    window.addEventListener("wa-pi:pi-command", piHandler);
    try {
      renderComposer({ text: "/goal", setText });
      fireEvent.click(screen.getByText("goal"));
      // 不应 dispatch wa-pi:pi-command（插件命令直接插入输入框 chip）
      expect(piHandler).not.toHaveBeenCalled();
      // setText 被调用，输入框内容包含 /[goal] chip token
      expect(setText).toHaveBeenCalled();
      const lastCall = setText.mock.calls.at(-1)?.[0] as string;
      expect(lastCall).toContain("/[goal]");
    } finally {
      window.removeEventListener("wa-pi:pi-command", piHandler);
    }
  });

  it("选中 prompt 模板命令仍走 wa-pi:pi-command", () => {
    useCommandsStore.setState({
      commands: [{ name: "review", description: "代码审查", source: "prompt" }],
      loading: false,
    });
    const setText = mock();
    const handler = mock();
    window.addEventListener("wa-pi:pi-command", handler);
    try {
      renderComposer({ text: "/review", setText });
      fireEvent.click(screen.getByText("review"));
      expect(handler).toHaveBeenCalled();
      expect(handler.mock.calls.at(-1)?.[0]?.detail?.text).toBe("/review");
    } finally {
      window.removeEventListener("wa-pi:pi-command", handler);
    }
  });

  it("选中前端 handler 命令 reload 仍走原 handler（dispatch reload-config，非 pi-command）", () => {
    const piHandler = mock();
    window.addEventListener("wa-pi:pi-command", piHandler);
    try {
      // 用 / 不带查询，显示完整菜单（reload 中文名按英文 "reload" 查询匹配不上）
      renderComposer({ text: "/", isRunning: false, isNewSession: false });
      fireEvent.click(screen.getByText("重载配置"));
      // pi-command 不应被触发（reload 有自己的前端 handler）
      expect(piHandler).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("wa-pi:pi-command", piHandler);
    }
  });
});

// ── 超大附件降级为路径引用（Electron）/ 提示超限（浏览器）──
//
// 50MB 以上文件：Electron 下经 waPiApp.getPathForFile 取真实路径，降级为 @路径 引用
// （不上传内容）；浏览器无此 API 则提示超限。

// 构造指定大小的 File 对象（size 直接指定，不占实际内存——覆盖 File 的 size 属性）
function bigFile(name: string, mb: number, type = "application/octet-stream"): File {
  const file = new File(["x"], name, { type });
  const size = mb * 1024 * 1024;
  Object.defineProperty(file, "size", { value: size, configurable: true });
  return file;
}

describe("超大附件降级处理", () => {
  afterEach(() => {
    // 清理 window.waPiApp（避免泄漏到其他测试）
    (window as any).waPiApp = undefined;
  });

  it("Electron 环境：>50MB 文件降级为路径引用（不报错、不上传）", async () => {
    (window as any).waPiApp = { getPathForFile: (f: File) => `/home/user/${f.name}` };
    const setAttachments = mock() as any;
    const { container } = renderComposer({ setAttachments });

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [bigFile("big.zip", 80)] } });
    });

    // 降级为路径引用：setAttachments 被调用，附件 path 为真实路径
    await waitFor(() => expect(setAttachments).toHaveBeenCalled());
    const attachments = setAttachments.mock.calls[0][0]([]);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].path).toBe("/home/user/big.zip");
    expect(attachments[0].kind).toBe("file");
    // 未发起上传（无 fetch）
    expect(fetchCalls.length).toBe(0);
    // 无超限错误
    expect(screen.queryByText(/超过.*上限/)).toBeNull();
  });

  it("浏览器环境：>50MB 文件提示超限（无 waPiApp）", async () => {
    (window as any).waPiApp = undefined;
    const setAttachments = mock() as any;
    const { container } = renderComposer({ setAttachments });

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [bigFile("big.zip", 80)] } });
    });

    // 显示超限提示，不添加附件
    await waitFor(() => expect(screen.getByText(/超过.*50MB.*上限/)).toBeTruthy());
    expect(setAttachments).not.toHaveBeenCalled();
  });

  it("Electron 环境：≤50MB 文件仍正常上传（不降级）", async () => {
    (window as any).waPiApp = { getPathForFile: (f: File) => `/home/user/${f.name}` };
    const setAttachments = mock() as any;
    const { container } = renderComposer({ setAttachments });

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [bigFile("small.txt", 10)] } });
    });

    // 正常上传：走 fetch，路径为 uploads 目录
    await waitFor(() => expect(fetchCalls.length).toBe(1));
    await waitFor(() => expect(setAttachments).toHaveBeenCalled());
    const attachments = setAttachments.mock.calls[0][0]([]);
    expect(attachments[0].path).toContain("uploads");
  });
});
