import { test, expect, mock, describe, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import type { AgentConfig, SessionMessage } from "@wa-pi/shared";
import { AgentListSection } from "../src/components/AgentListSection";
import { useAgentsStore } from "../src/store/agents";
import { useProjectsStore } from "../src/store/projects";
import { useSessionStore } from "../src/store/session";

const agent = (name: string): AgentConfig => ({
  displayName: name, avatar: "🤖", avatarColor: "#000-#111", description: "",
  model: "m", thinking: "medium", systemPromptMode: "replace",

  tools: [], skills: [], mcpServers: [], partners: { askTo: [] },
});

// 捕获真实 action：部分测试会 override deleteAgent/createAgent 做 spy，
// zustand 单例的 override 会跨测试残留，必须每轮恢复（同 ExtensionSection.test.tsx）。
const realDeleteAgent = useAgentsStore.getState().deleteAgent;
const realCreateAgent = useAgentsStore.getState().createAgent;

function seed(names: string[]) {
  useAgentsStore.setState({ list: names.map(agent), deleteAgent: realDeleteAgent, createAgent: realCreateAgent });
  useProjectsStore.setState({ sessions: [] });
  useSessionStore.setState({ statusBySession: {}, messagesBySession: {} });
}

const noop = () => {};

const s1 = { id: "s1", projectId: "p1", primaryAgent: "dev", title: "t1", createdAt: 0, lastActivity: 0, piSessionFile: "" };

describe("AgentListSection", () => {
  beforeEach(() => seed([]));

  test("只显示最近前 3 个，超过显示「更多智能体 (n)」", () => {
    seed(["a", "b", "c", "d", "e"]);
    render(<AgentListSection onChatWith={noop} onEdit={noop} onMore={noop} />);
    expect(screen.queryByTestId("agent-a")).toBeTruthy();
    expect(screen.queryByTestId("agent-c")).toBeTruthy();
    expect(screen.queryByTestId("agent-d")).toBeNull();
    expect(screen.getByTestId("agent-more").textContent).toContain("更多智能体 (2)");
  });

  test("≤3 个时不显示更多入口", () => {
    seed(["a", "b"]);
    render(<AgentListSection onChatWith={noop} onEdit={noop} onMore={noop} />);
    expect(screen.queryByTestId("agent-more")).toBeNull();
  });

  test("左键触发 onChatWith；右键弹菜单含编辑/删除；点空白处关闭", async () => {
    seed(["a"]);
    const onChatWith = mock();
    render(<AgentListSection onChatWith={onChatWith} onEdit={noop} onMore={noop} />);
    fireEvent.click(screen.getByTestId("agent-a"));
    expect(onChatWith).toHaveBeenCalledWith("a");
    fireEvent.contextMenu(screen.getByTestId("agent-a"));
    expect(screen.getByTestId("agent-ctx-edit")).toBeTruthy();
    expect(screen.getByTestId("agent-ctx-delete")).toBeTruthy();
    // 关闭菜单收尾：等 setTimeout(0) 把 click 监听器绑到 document 后点空白（同 ProjectItem.sort-menu 模式）。
    // bun 多文件共享同一 document 且非首个文件的组件不会卸载，菜单不关会把 portal+监听器泄漏给后续文件。
    await new Promise(r => setTimeout(r, 10));
    fireEvent.click(window.document);
    await waitFor(() => expect(screen.queryByTestId("agent-context-menu")).toBeNull());
  });

  test("菜单「编辑智能体」触发 onEdit", () => {
    seed(["a"]);
    const onEdit = mock();
    render(<AgentListSection onChatWith={noop} onEdit={onEdit} onMore={noop} />);
    fireEvent.contextMenu(screen.getByTestId("agent-a"));
    fireEvent.click(screen.getByTestId("agent-ctx-edit"));
    expect(onEdit).toHaveBeenCalledWith("a");
  });

  test("点「更多智能体」触发 onMore", () => {
    seed(["a", "b", "c", "d"]);
    const onMore = mock();
    render(<AgentListSection onChatWith={noop} onEdit={noop} onMore={onMore} />);
    fireEvent.click(screen.getByTestId("agent-more"));
    expect(onMore).toHaveBeenCalled();
  });

  test("点删除先弹二次确认，确认后调用 deleteAgent", () => {
    seed(["a"]);
    const deleteAgent = mock();
    useAgentsStore.setState({ deleteAgent });
    render(<AgentListSection onChatWith={noop} onEdit={noop} onMore={noop} />);
    fireEvent.contextMenu(screen.getByTestId("agent-a"));
    fireEvent.click(screen.getByTestId("agent-ctx-delete"));
    expect(screen.getByTestId("agent-delete-confirm")).toBeTruthy();
    fireEvent.click(screen.getByTestId("confirm-ok"));
    expect(deleteAgent).toHaveBeenCalledWith("a");
  });

  test("头像与名称优先取 config 的 avatar/displayName", () => {
    useAgentsStore.setState({
      list: [{ ...agent("需求设计"), avatar: "📋" }],
      deleteAgent: realDeleteAgent,
    });
    render(<AgentListSection onChatWith={noop} onEdit={noop} onMore={noop} />);
    const row = screen.getByTestId("agent-需求设计");
    expect(row.textContent).toContain("需求设计");
    expect(row.textContent).toContain("📋");
  });

  test("名下会话运行中时状态点显示靛蓝（thinking），无会话的 agent 保持空闲绿", () => {
    seed(["dev", "test"]);
    useProjectsStore.setState({ sessions: [s1] });
    useSessionStore.setState({ statusBySession: { s1: "thinking" } });
    render(<AgentListSection onChatWith={noop} onEdit={noop} onMore={noop} />);
    // STATUS_COLORS.thinking 为 "#5B5BD6"（accent 靛蓝），浏览器 normalize 后通常为小写
    expect((screen.getByTestId("status-dev") as HTMLElement).style.background.toLowerCase()).toBe("#5b5bd6");
    expect((screen.getByTestId("status-test") as HTMLElement).style.background.toLowerCase()).toBe("#34a853");
  });

  test("名下会话有待回答提问时状态点显示警告橙（blocked 优先于 thinking）", () => {
    const askCall = { type: "toolCall", id: "tc-1", name: "ask_user_question", arguments: { questions: [{ question: "Q?", header: "h", options: [{ label: "A", description: "x" }] }] } };
    const messages: SessionMessage[] = [
      { agentName: "dev", message: { role: "assistant", content: [askCall], model: "m", stopReason: "tool_use", timestamp: 1 } as any },
    ];
    seed(["dev", "test"]);
    useProjectsStore.setState({ sessions: [s1] });
    useSessionStore.setState({ statusBySession: { s1: "thinking" }, messagesBySession: { s1: messages } });
    render(<AgentListSection onChatWith={noop} onEdit={noop} onMore={noop} />);
    expect((screen.getByTestId("status-dev") as HTMLElement).style.background.toLowerCase()).toBe("#b45309");
  });

  test("空态显示新增智能体入口，回车创建", () => {
    seed([]);
    const createAgent = mock();
    useAgentsStore.setState({ createAgent });
    render(<AgentListSection onChatWith={noop} onEdit={noop} onMore={noop} />);
    expect(screen.getByTestId("agent-empty-create")).toBeTruthy();
    expect(screen.queryByTestId("agent-more")).toBeNull();
    fireEvent.click(screen.getByTestId("agent-empty-create"));
    const input = screen.getByTestId("agent-empty-input");
    fireEvent.change(input, { target: { value: "我的助手" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(createAgent).toHaveBeenCalledWith("我的助手");
    // 提交后收起输入行
    expect(screen.queryByTestId("agent-empty-input")).toBeNull();
  });

  test("空态输入 Esc 取消；空白名不提交", () => {
    seed([]);
    const createAgent = mock();
    useAgentsStore.setState({ createAgent });
    render(<AgentListSection onChatWith={noop} onEdit={noop} onMore={noop} />);
    fireEvent.click(screen.getByTestId("agent-empty-create"));
    const input = screen.getByTestId("agent-empty-input");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByTestId("agent-empty-input")).toBeNull();
    expect(createAgent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("agent-empty-create"));
    const input2 = screen.getByTestId("agent-empty-input");
    fireEvent.change(input2, { target: { value: "   " } });
    fireEvent.keyDown(input2, { key: "Enter" });
    expect(createAgent).not.toHaveBeenCalled();
  });

  test("非空列表不显示空态入口", () => {
    seed(["a"]);
    render(<AgentListSection onChatWith={noop} onEdit={noop} onMore={noop} />);
    expect(screen.queryByTestId("agent-empty-create")).toBeNull();
  });
});
