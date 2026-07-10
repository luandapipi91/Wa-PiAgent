import { describe, it, expect, vi, beforeEach } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Composer } from "../src/components/Composer";
import * as ws from "../src/ws-instance";
import { useComposerPrefsStore } from "../src/store/composer-prefs";
import { useProjectsStore } from "../src/store/projects";
import { useSessionStore } from "../src/store/session";

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
    const textarea = screen.getByTestId("composer-input").querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "hello" } });
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
    const textarea = screen.getByTestId("composer-input").querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "继续" } });
    expect(textarea.value).toBe("继续");

    fireEvent.click(screen.getByTestId("composer-send"));

    await waitFor(() => {
      expect(textarea.value).toBe("");
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
    const textarea = screen.getByTestId("composer-input").querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "排队消息" } });

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

  it("乐观发送：点击发送立即入列用户消息 + 占位 AI loading + status thinking（不等 SDK 回声）", () => {
    useComposerPrefsStore.setState({
      bySession: { s1: { model: "gpt-4o", thinking: "disabled", attachments: [] } },
    });
    render(<Composer sessionId="s1" agentName="dev" />);
    const textarea = screen.getByTestId("composer-input").querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "马上看到我" } });
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
});
