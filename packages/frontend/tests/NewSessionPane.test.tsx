import { describe, it, expect, vi, beforeEach } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NewSessionPane } from "../src/components/NewSessionPane";
import * as ws from "../src/ws-instance";
import { useProjectsStore } from "../src/store/projects";
import { useComposerPrefsStore } from "../src/store/composer-prefs";
import { setDefaults as dbSetDefaults } from "../src/store/composer-db";

describe("NewSessionPane", () => {
  beforeEach(() => {
    useProjectsStore.setState({
      projects: [{ id: "p1", name: "项目A", cwd: "/a", createdAt: 0 }],
      sessions: [],
      currentProjectId: "p1",
      currentSessionId: null,
    });
    useComposerPrefsStore.setState({
      defaults: { model: null, thinking: "disabled" },
      bySession: {},
    });
    vi.spyOn(ws, "send").mockImplementation(() => {});
  });

  it("renders project and agent selects", () => {
    render(<NewSessionPane />);
    expect(screen.getByTestId("project-select")).toBeTruthy();
    expect(screen.getByTestId("agent-select")).toBeTruthy();
  });

  it("clears text after sending", () => {
    useComposerPrefsStore.setState({ defaults: { model: "gpt-4o", thinking: "disabled" } });
    render(<NewSessionPane />);
    const textarea = screen.getByTestId("composer-input").querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "你好" } });
    expect(textarea.value).toBe("你好");
    fireEvent.click(screen.getByTestId("composer-send"));
    expect(textarea.value).toBe("");
  });

  it("sends first prompt with model and thinking", async () => {
    await dbSetDefaults({ model: "claude-sonnet", thinking: "high" });
    useComposerPrefsStore.setState({
      defaults: { model: null, thinking: "disabled" },
      bySession: {},
    });

    render(<NewSessionPane />);

    await waitFor(() => {
      expect(useComposerPrefsStore.getState().defaults.model).toBe("claude-sonnet");
    });

    const textarea = screen.getByTestId("composer-input").querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.click(screen.getByTestId("composer-send"));

    await waitFor(() => {
      expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
        type: "agent:prompt",
        projectId: "p1",
        text: "hello",
        model: "claude-sonnet",
        thinking: "high",
      }));
    });
  });

  it("sends prompt with attachments", async () => {
    useComposerPrefsStore.setState({ defaults: { model: "gpt-4o", thinking: "disabled" } });
    render(<NewSessionPane />);

    await waitFor(() => {
      expect(useComposerPrefsStore.getState().defaults.thinking).toBe("disabled");
    });

    const fileInput = screen.getByTestId("composer-input").querySelector("input[type=file]")!;
    const file = new File(["content"], "note.txt", { type: "text/plain" });
    fireEvent.change(fileInput, { target: { files: [file] } });

    fireEvent.change(screen.getByTestId("path-input"), { target: { value: "/tmp/note.txt" } });
    fireEvent.click(screen.getByTestId("confirm-path"));

    await waitFor(() => {
      expect(screen.getByTestId("attachment-list")).toBeTruthy();
    });

    const textarea = screen.getByTestId("composer-input").querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "with attachment" } });
    fireEvent.click(screen.getByTestId("composer-send"));

    await waitFor(() => {
      expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
        type: "agent:prompt",
        projectId: "p1",
        text: "with attachment",
        attachments: [expect.objectContaining({ kind: "file", name: "note.txt", path: "/tmp/note.txt" })],
      }));
    });
  });
});
