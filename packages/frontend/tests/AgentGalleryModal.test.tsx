import { test, expect, mock, describe, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import type { AgentConfig } from "@hiagent/shared";
import { AgentGalleryModal } from "../src/components/AgentGalleryModal";
import { useAgentsStore } from "../src/store/agents";
import { useProjectsStore } from "../src/store/projects";
import { useSessionStore } from "../src/store/session";

const agent = (name: string, description = "简介"): AgentConfig => ({
  name, displayName: name, avatar: "🤖", avatarColor: "#000-#111", description,
  model: "m", thinking: "medium", systemPromptMode: "replace",
  inheritProjectContext: true, inheritSkills: true,
  tools: [], skills: [], mcpServers: [], partners: { askTo: [], askFrom: [] }, triggerKeywords: [],
});

// 捕获真实 action：部分测试 override createAgent/deleteAgent 做 spy，
// zustand 单例的 override 会跨测试残留，必须每轮恢复（同 AgentListSection.test.tsx）。
const realCreateAgent = useAgentsStore.getState().createAgent;
const realDeleteAgent = useAgentsStore.getState().deleteAgent;

function seed(names: string[]) {
  useAgentsStore.setState({
    list: names.map(n => agent(n)),
    createAgent: realCreateAgent,
    deleteAgent: realDeleteAgent,
  });
  useProjectsStore.setState({ sessions: [] });
  useSessionStore.setState({ statusBySession: {}, messagesBySession: {} });
}

const noop = () => {};

const renderModal = (over: Partial<Parameters<typeof AgentGalleryModal>[0]> = {}) =>
  render(<AgentGalleryModal onClose={noop} onChatWith={noop} onEdit={noop} onCreated={noop} {...over} />);

// 弹窗含 portal 菜单与 window 级 ESC 监听，显式 unmount 触发 effect cleanup，
// 避免泄漏给共享同一 document 的后续测试文件（同 ProjectItem.sort-menu 模式）。
afterEach(() => cleanup());

describe("AgentGalleryModal", () => {
  beforeEach(() => seed([]));

  test("宫格渲染全部智能体（名称+简介+计数）", () => {
    seed(["a", "b", "c", "d"]);
    renderModal();
    expect(screen.getByTestId("agent-gallery")).toBeTruthy();
    for (const n of ["a", "b", "c", "d"]) {
      const card = screen.getByTestId(`gallery-card-${n}`);
      expect(card.textContent).toContain(n);
      expect(card.textContent).toContain("简介");
    }
    expect(screen.getByTestId("agent-gallery").textContent).toContain("4 个");
  });

  test("左键卡片触发 onChatWith；右键弹编辑/删除菜单，点空白处关闭", async () => {
    seed(["a"]);
    const onChatWith = mock();
    renderModal({ onChatWith });
    fireEvent.click(screen.getByTestId("gallery-card-a"));
    expect(onChatWith).toHaveBeenCalledWith("a");
    fireEvent.contextMenu(screen.getByTestId("gallery-card-a"));
    expect(screen.getByTestId("gallery-ctx-edit")).toBeTruthy();
    expect(screen.getByTestId("gallery-ctx-delete")).toBeTruthy();
    // 等 setTimeout(0) 把 click 监听器绑到 document 后点空白关闭（同 AgentListSection 模式）
    await new Promise(r => setTimeout(r, 10));
    fireEvent.click(window.document);
    await waitFor(() => expect(screen.queryByTestId("gallery-context-menu")).toBeNull());
  });

  test("菜单「编辑智能体」触发 onEdit", () => {
    seed(["a"]);
    const onEdit = mock();
    renderModal({ onEdit });
    fireEvent.contextMenu(screen.getByTestId("gallery-card-a"));
    fireEvent.click(screen.getByTestId("gallery-ctx-edit"));
    expect(onEdit).toHaveBeenCalledWith("a");
  });

  test("点删除先弹二次确认，确认后调用 deleteAgent", () => {
    seed(["a"]);
    const deleteAgent = mock();
    useAgentsStore.setState({ deleteAgent });
    renderModal();
    fireEvent.contextMenu(screen.getByTestId("gallery-card-a"));
    fireEvent.click(screen.getByTestId("gallery-ctx-delete"));
    expect(screen.getByTestId("gallery-delete-confirm")).toBeTruthy();
    fireEvent.click(screen.getByTestId("confirm-ok"));
    expect(deleteAgent).toHaveBeenCalledWith("a");
  });

  test("点新建智能体输入名称后调用 createAgent 并触发 onCreated", () => {
    seed([]);
    const createAgent = mock();
    useAgentsStore.setState({ createAgent });
    const onCreated = mock();
    renderModal({ onCreated });
    fireEvent.click(screen.getByTestId("gallery-create"));
    fireEvent.change(screen.getByTestId("gallery-create-input"), { target: { value: "新智能体" } });
    fireEvent.click(screen.getByTestId("gallery-create-ok"));
    expect(createAgent).toHaveBeenCalledWith("新智能体");
    expect(onCreated).toHaveBeenCalledWith("新智能体");
  });

  test("名下会话运行中时状态点显示靛蓝（thinking），无会话的 agent 保持空闲绿", () => {
    seed(["dev", "test"]);
    useProjectsStore.setState({
      sessions: [{ id: "s1", projectId: "p1", primaryAgent: "dev", title: "t", createdAt: 0, lastActivity: 0, piSessionFile: "" }],
    });
    useSessionStore.setState({ statusBySession: { s1: "thinking" } });
    renderModal();
    expect((screen.getByTestId("gallery-status-dev") as HTMLElement).style.background.toLowerCase()).toBe("#5b5bd6");
    expect((screen.getByTestId("gallery-status-test") as HTMLElement).style.background.toLowerCase()).toBe("#34a853");
  });
});
