import { describe, it, expect, vi, beforeEach } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Composer } from "../src/components/Composer";
import * as ws from "../src/ws-instance";
import { useComposerPrefsStore } from "../src/store/composer-prefs";
import { useProjectsStore } from "../src/store/projects";
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
          model: "claude-sonnet",
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
        model: "claude-sonnet",
        thinking: "high",
        attachments: [{ kind: "snippet", name: "note", content: "context" }],
      }));
    });
  });

  it("clears text after sending and drops attachments from session prefs", async () => {
    useComposerPrefsStore.setState({
      bySession: {
        s1: { model: "gpt-4o", thinking: "disabled", attachments: [] },
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
        s1: { model: "gpt-4o", thinking: "disabled", attachments: [] },
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
        model: "gpt-4o",
        thinking: "disabled",
      }));
    });
  });

  it("agent 思考中发送消息不乐观显示（入队等待，不立即显示用户消息+AI loading）", () => {
    useComposerPrefsStore.setState({
      bySession: { s1: { model: "gpt-4o", thinking: "disabled", attachments: [] } },
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
      bySession: { s1: { model: "gpt-4o", thinking: "disabled", attachments: [] } },
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
      bySession: { s1: { model: "gpt-4o", thinking: "disabled", attachments: [] } },
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

  it("@提及其他智能体：弹缓存失效确认框，确认后先 set-agent 再发 prompt", async () => {
    useComposerPrefsStore.setState({
      bySession: { s1: { model: "gpt-4o", thinking: "disabled", attachments: [] } },
    });
    render(<Composer sessionId="s1" agentName="dev" />);
    typeIntoComposer("@[pm] 帮我看看需求");
    // spy 跨 it 累积，记录基线增量比较
    const base = (ws.send as any).mock.calls.length;
    fireEvent.click(screen.getByTestId("composer-send"));

    // 弹出确认框，文案同 Task 13
    const dialog = await screen.findByTestId("mention-confirm");
    expect(dialog.textContent).toContain("切换智能体后所有缓存都会失效，是否继续？");
    // 确认前不应发出任何消息
    expect((ws.send as any).mock.calls.length).toBe(base);

    fireEvent.click(screen.getByTestId("mention-confirm-ok"));

    await waitFor(() => {
      // 先切换会话智能体
      expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
        type: "session:set-agent",
        sessionId: "s1",
        agentName: "pm",
      }));
      // 再发 prompt：agentName 用 mention，文本剥离 @[pm] token
      expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
        type: "agent:prompt",
        sessionId: "s1",
        agentName: "pm",
        text: "帮我看看需求",
      }));
    });
  });

  it("@提及其他智能体：取消确认框则不发送", async () => {
    useComposerPrefsStore.setState({
      bySession: { s1: { model: "gpt-4o", thinking: "disabled", attachments: [] } },
    });
    render(<Composer sessionId="s1" agentName="dev" />);
    typeIntoComposer("@[pm] 帮我看看需求");
    const base = (ws.send as any).mock.calls.length;
    fireEvent.click(screen.getByTestId("composer-send"));

    await screen.findByTestId("mention-confirm");
    fireEvent.click(screen.getByTestId("mention-confirm-cancel"));

    await waitFor(() => {
      expect(screen.queryByTestId("mention-confirm")).toBeNull();
    });
    expect((ws.send as any).mock.calls.length).toBe(base);
  });

  it("@提及当前智能体：不弹确认框，剥离 token 直接发送", async () => {
    useComposerPrefsStore.setState({
      bySession: { s1: { model: "gpt-4o", thinking: "disabled", attachments: [] } },
    });
    render(<Composer sessionId="s1" agentName="dev" />);
    typeIntoComposer("@[dev] 继续干活");
    fireEvent.click(screen.getByTestId("composer-send"));

    await waitFor(() => {
      expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
        type: "agent:prompt",
        agentName: "dev",
        text: "继续干活",
      }));
    });
    expect(screen.queryByTestId("mention-confirm")).toBeNull();
  });
});
