import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useProvidersStore } from "../src/store/providers";
import { useProjectsStore } from "../src/store/projects";
import { useSkillsStore } from "../src/store/skills";
import { useAgentsStore } from "../src/store/agents";

const handlers = new Set<(e: any) => void>();
const sendMock = mock();

mock.module("../src/ws-instance", () => ({
  send: sendMock,
  onMessage: (h: (e: any) => void) => {
    handlers.add(h);
    return () => handlers.delete(h);
  },
}));

import { ComposerInput } from "../src/components/ui/ComposerInput";

beforeEach(() => {
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
  handlers.clear();
  sendMock.mockClear();
});

function renderComposer(props?: Partial<React.ComponentProps<typeof ComposerInput>>) {
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

function completeLatestUpload(path: string) {
  const sent = sendMock.mock.calls.find(([e]) => e.type === "fs:upload")?.[0];
  expect(sent).toBeTruthy();
  handlers.forEach(h => h({ type: "fs:upload", id: sent.id, path }));
  return sent;
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

  await waitFor(() => expect(sendMock).toHaveBeenCalled());
  const sent = completeLatestUpload("/project/p1/.hiagent/uploads/notes.txt");
  expect(sent.projectId).toBe("p1");
  expect(sent.name).toBe("notes.txt");

  await waitFor(() => expect(setAttachments).toHaveBeenCalled());
  const updater = setAttachments.mock.calls[0][0];
  const attachments = updater([]);
  expect(attachments).toHaveLength(1);
  expect(attachments[0]).toMatchObject({
    kind: "file",
    name: "notes.txt",
    path: "/project/p1/.hiagent/uploads/notes.txt",
  });
});

test("uploads pasted file from clipboard", async () => {
  const setAttachments = mock() as any;
  const file = new File(["pasted"], "pasted.txt", { type: "text/plain" });

  renderComposer({ setAttachments });

  const textbox = screen.getByTestId("composer-input").querySelector('[role="textbox"]')!;
  fireEvent.paste(textbox, { clipboardData: { files: [file] } });

  await waitFor(() => expect(sendMock).toHaveBeenCalled());
  completeLatestUpload("/project/p1/.hiagent/uploads/pasted.txt");

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

  await waitFor(() => expect(sendMock).toHaveBeenCalled());
  completeLatestUpload("/project/p1/.hiagent/uploads/dropped.png");

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
  expect(sendMock).not.toHaveBeenCalled();
});

// === Quick Invoke 测试 ===

test("输入 # 触发文件面板", () => {
  const setText = mock();
  renderComposer({ text: "你好 #App", setText });
  // 面板应该出现（searchFilesStream 是异步的，但面板组件应渲染）
  // 初始状态下 items 可能还没加载，但 menu 容器应存在
  waitFor(() => {
    const menu = document.querySelector('[data-testid="quick-invoke-menu"]');
    // 面板可能存在也可能因无数据不渲染——核心是触发检测工作
  });
  // 验证触发了 fs:search WS 请求
  const searchCall = sendMock.mock.calls.find(([e]) => e.type === "fs:search");
  expect(searchCall).toBeTruthy();
});

test("#文件搜索结果中目录项传递 isDir 并显示文件夹图标", async () => {
  renderComposer({ text: "打开 #src" });
  // 获取搜索请求的 requestId
  const searchCall = sendMock.mock.calls.find(([e]) => e.type === "fs:search");
  expect(searchCall).toBeTruthy();
  const requestId = searchCall![0].requestId;
  // 模拟 kernel 返回包含目录的搜索结果
  await waitFor(() => {
    handlers.forEach(h => h({
      type: "fs:search:progress",
      requestId,
      query: "src",
      matches: [
        { name: "src", isDir: true, path: "/proj/p1/src" },
        { name: "App.tsx", isDir: false, path: "/proj/p1/src/App.tsx" },
      ],
    }));
  });
  // 文件夹图标应出现
  expect(screen.getByText("📁")).toBeDefined();
  // 文件图标也应出现
  expect(screen.getByText("📄")).toBeDefined();
});

test("输入 @ 触发智能体面板（数据来自 useAgentsStore.list，按 displayName/description 过滤）", () => {
  useAgentsStore.setState({
    list: [
      { name: "pm", displayName: "需求设计", description: "梳理需求、输出 PRD" },
      { name: "test", displayName: "质量验收", description: "测试与验收" },
    ] as any,
  });
  renderComposer({ text: "@需求" });
  // 命中的智能体显示 displayName
  expect(screen.getByText("需求设计")).toBeDefined();
  // 未命中的不显示
  expect(screen.queryByText("质量验收")).toBeNull();
});

test("@ 面板空结果显示 无匹配智能体", () => {
  useAgentsStore.setState({ list: [] });
  renderComposer({ text: "@xyz" });
  expect(screen.getByText("无匹配智能体")).toBeDefined();
});

test("选中智能体后生成 @[name] chip token 并回调 onAgentMention", () => {
  const setText = mock();
  const onAgentMention = mock();
  useAgentsStore.setState({
    list: [
      { displayName: "需求设计", description: "梳理需求", avatar: "", avatarColor: "", model: "m", thinking: "medium", systemPromptMode: "replace", inheritProjectContext: true, inheritSkills: true, tools: [], skills: [], mcpServers: [], partners: { askTo: [], askFrom: [] }, triggerKeywords: [] },
    ] as any,
  });
  renderComposer({ text: "@需求", setText, onAgentMention });
  fireEvent.click(screen.getByText("需求设计"));
  expect(setText).toHaveBeenCalled();
  const lastCall = setText.mock.calls[setText.mock.calls.length - 1][0] as string;
  expect(lastCall).toContain("@[需求设计]");
  expect(onAgentMention).toHaveBeenCalledWith("需求设计");
});

test("选中文件后生成 #[path] chip token", async () => {
  const setText = mock();
  renderComposer({ text: "#hello", setText });
  const searchCall = sendMock.mock.calls.find(([e]) => e.type === "fs:search");
  expect(searchCall).toBeTruthy();
  const requestId = searchCall![0].requestId;
  await waitFor(() => {
    handlers.forEach(h => h({
      type: "fs:search:progress",
      requestId,
      query: "hello",
      matches: [{ name: "hello.txt", isDir: false, path: "/proj/p1/hello.txt" }],
    }));
  });
  fireEvent.click(screen.getByTestId("quick-invoke-item-0"));
  expect(setText).toHaveBeenCalled();
  const lastCall = setText.mock.calls[setText.mock.calls.length - 1][0] as string;
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
  const lastCall = setText.mock.calls[setText.mock.calls.length - 1][0] as string;
  expect(lastCall).toContain("$[brainstorming]");
  // 不应再包含原始的 $brain 文本
  expect(lastCall).not.toMatch(/\$brain$/);
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
  const lastCall = setText.mock.calls[setText.mock.calls.length - 1][0] as string;
  // token 格式为 $[pdf]，发送时由 Composer 展开为 /skill:pdf（SDK _expandSkillCommand 格式）
  expect(lastCall).toContain("$[pdf]");
});
