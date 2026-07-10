import { describe, it, expect, vi, beforeEach } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Composer } from "../src/components/Composer";
import * as ws from "../src/ws-instance";
import { useComposerPrefsStore } from "../src/store/composer-prefs";
import { useProjectsStore } from "../src/store/projects";

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
});
