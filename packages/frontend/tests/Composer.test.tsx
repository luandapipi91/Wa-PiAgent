import { describe, it, expect, vi, beforeEach } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Composer } from "../src/components/Composer";
import * as ws from "../src/ws-instance";
import { useComposerPrefsStore } from "../src/store/composer-prefs";
import { useProjectsStore } from "../src/store/projects";
import { useProvidersStore } from "../src/store/providers";
import { useSessionStore } from "../src/store/session";
import { useSkillsStore } from "../src/store/skills";

// 把文本写入 contenteditable textbox 并触发 input 事件（替代原 textarea 的 fireEvent.change）
function typeIntoComposer(value: string) {
  const textbox = screen.getByTestId("composer-input").querySelector('[role="textbox"]') as HTMLElement;
  textbox.textContent = value;
  fireEvent.input(textbox);
  return textbox;
}

describe("Composer", () => {
  beforeEach(() => {
    useProjectsStore.setState({
      projects: [],
      sessions: [{ id: "s1", projectId: "p1", primaryAgent: "dev", title: "t", createdAt: 0, lastActivity: 0, piSessionFile: "" }],
      currentProjectId: "p1",
      currentSessionId: "s1",
    });
    useProvidersStore.setState({
      providers: [
        { id: "prov-openai", name: "openai", api: "openai-completions", baseUrl: "", apiKey: "", models: [{ id: "gpt-4o", contextWindow: 128000, maxTokens: 4096 }] },
        { id: "prov-anthropic", name: "anthropic", api: "anthropic-messages", baseUrl: "", apiKey: "", models: [{ id: "claude-sonnet", contextWindow: 200000, maxTokens: 8192 }] },
      ],
    });
    useComposerPrefsStore.setState({
      defaults: { model: null, thinking: "disabled" },
      bySession: {},
    });
    useSessionStore.setState({ messagesBySession: {}, streamingBySession: {}, statusBySession: {}, optimisticEchoBySession: {} });
    useSkillsStore.setState({
      skills: [], allSkills: [], dirs: [], disabledSkills: [], builtinDir: "", loading: false,
      load: () => {}, setAll: () => {}, toggleSkill: () => {}, addDir: () => {}, removeDir: () => {},
    });
    vi.spyOn(ws, "send").mockImplementation(() => {});
  });

  it("sends prompt with model, thinking and attachments", async () => {
    useComposerPrefsStore.setState({
      bySession: {
        s1: {
          model: "anthropic/claude-sonnet",
          thinking: "high",
          attachments: [{ kind: "snippet", name: "note", content: "context" }],
        },
      },
    });

    render(<Composer sessionId="s1" agentName="dev" />);
    typeIntoComposer("hello");
    fireEvent.click(screen.getByTestId("composer-send"));

    await waitFor(() => {
      expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
        type: "agent:prompt",
        projectId: "p1",
        sessionId: "s1",
        agentName: "dev",
        text: "hello",
        model: "anthropic/claude-sonnet",
        thinking: "high",
        attachments: [{ kind: "snippet", name: "note", content: "context" }],
      }));
    });
  });

  it("clears text after sending and drops attachments from session prefs", async () => {
    useComposerPrefsStore.setState({
      bySession: {
        s1: { model: "openai/gpt-4o", thinking: "disabled", attachments: [] },
      },
    });
    render(<Composer sessionId="s1" agentName="dev" />);
    const textbox = typeIntoComposer("继续");
    expect(textbox.textContent).toBe("继续");

    fireEvent.click(screen.getByTestId("composer-send"));

    await waitFor(() => {
      expect(textbox.textContent).toBe("");
      expect(useComposerPrefsStore.getState().bySession["s1"]?.attachments).toEqual([]);
    });
  });

  it("still allows sending while agent is running (followUp queue)", async () => {
    useComposerPrefsStore.setState({
      bySession: {
        s1: { model: "openai/gpt-4o", thinking: "disabled", attachments: [] },
      },
    });
    render(<Composer sessionId="s1" agentName="dev" isRunning />);
    typeIntoComposer("排队消息");

    fireEvent.click(screen.getByTestId("composer-send"));

    await waitFor(() => {
      expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
        type: "agent:prompt",
        projectId: "p1",
        sessionId: "s1",
        agentName: "dev",
        text: "排队消息",
        model: "openai/gpt-4o",
        thinking: "disabled",
      }));
    });
  });

  it("agent 思考中发送消息不乐观显示（入队等待，不立即显示用户消息+AI loading）", () => {
    useComposerPrefsStore.setState({
      bySession: { s1: { model: "openai/gpt-4o", thinking: "disabled", attachments: [] } },
    });
    render(<Composer sessionId="s1" agentName="dev" isRunning />);
    typeIntoComposer("排队等一下");
    fireEvent.click(screen.getByTestId("composer-send"));

    const s = useSessionStore.getState();
    // 消息已发给 kernel（由 kernel 入队）
    expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({ type: "agent:prompt", text: "排队等一下" }));
    // 但前端不乐观显示：不追加用户消息、不设占位 streaming、不改 status
    expect(s.messagesBySession["s1"] ?? []).toHaveLength(0);
    expect(s.streamingBySession["s1"]).toBeFalsy();
    expect(s.optimisticEchoBySession["s1"]).toBeFalsy();
  });

  it("乐观发送：点击发送立即入列用户消息 + 占位 AI loading + status thinking（不等 SDK 回声）", () => {
    useComposerPrefsStore.setState({
      bySession: { s1: { model: "openai/gpt-4o", thinking: "disabled", attachments: [] } },
    });
    render(<Composer sessionId="s1" agentName="dev" />);
    typeIntoComposer("马上看到我");
    fireEvent.click(screen.getByTestId("composer-send"));

    const s = useSessionStore.getState();
    // 用户消息立即显示
    expect(s.messagesBySession["s1"]).toHaveLength(1);
    expect((s.messagesBySession["s1"][0].message as any).content).toBe("马上看到我");
    // 占位流式 assistant（loading 气泡）+ 顶部 spinner 立即可见
    expect(s.streamingBySession["s1"]).toBeTruthy();
    expect(s.statusBySession["s1"]).toBe("thinking");
    expect(s.optimisticEchoBySession["s1"]).toBe(true);
  });

  it("disabled=true 时 textarea 禁用、点发送不触发 agent:prompt", () => {
    useComposerPrefsStore.setState({
      bySession: { s1: { model: "openai/gpt-4o", thinking: "disabled", attachments: [] } },
    });
    render(<Composer sessionId="s1" agentName="dev" disabled />);
    const textbox = screen.getByTestId("composer-input").querySelector('[role="textbox"]') as HTMLElement;
    // contenteditable 处于禁用（contentEditable=false → isContentEditable 为 false）
    expect(textbox.isContentEditable).toBe(false);
    // 发送按钮点击后不应新增任何 agent:prompt（spy 在 describe 内跨 it 累积，故比较点击前后增量）
    const before = (ws.send as any).mock.calls.length;
    fireEvent.click(screen.getByTestId("composer-send"));
    const after = (ws.send as any).mock.calls.length;
    expect(after).toBe(before);
  });

  it("@提及其他智能体：不弹确认框、不发 set-agent，原样发 @[xxx] 给主智能体", async () => {
    useComposerPrefsStore.setState({
      bySession: { s1: { model: "gpt-4o", thinking: "disabled", attachments: [] } },
    });
    render(<Composer sessionId="s1" agentName="dev" />);
    typeIntoComposer("@[pm] 帮我看看需求");
    fireEvent.click(screen.getByTestId("composer-send"));

    // 不弹确认框
    expect(screen.queryByTestId("mention-confirm")).toBeNull();

    await waitFor(() => {
      // 不发 session:set-agent
      expect((ws.send as any).mock.calls.some((c: any[]) => c[0]?.type === "session:set-agent")).toBe(false);
      // 发 agent:prompt，agentName 仍为主智能体 dev，text 原样保留 @[pm]
      expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
        type: "agent:prompt",
        sessionId: "s1",
        agentName: "dev",
        text: "@[pm] 帮我看看需求",
      }));
    });
  });

  it("过期 model（provider 已删除、prefs 残留）→ 不发出 agent:prompt、不乐观上屏", () => {
    // 复现 bug：prefs 残留的 model 指向已被删除的 provider
    useProvidersStore.setState({ providers: [] });
    useComposerPrefsStore.setState({
      bySession: { s1: { model: "my-deepseek/deepseek-chat", thinking: "disabled", attachments: [] } },
    });
    render(<Composer sessionId="s1" agentName="dev" />);
    typeIntoComposer("这条消息不应发出");
    // spy 在 describe 内跨 it 累积，比较点击前后增量
    const before = (ws.send as any).mock.calls.length;
    fireEvent.click(screen.getByTestId("composer-send"));
    const after = (ws.send as any).mock.calls.length;

    // 不发 WS、不做乐观 UI（用户消息不上屏、无 loading 占位）
    expect(after).toBe(before);
    const s = useSessionStore.getState();
    expect(s.messagesBySession["s1"] ?? []).toHaveLength(0);
    expect(s.streamingBySession["s1"]).toBeFalsy();
  });
});
