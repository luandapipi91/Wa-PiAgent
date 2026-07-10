import { describe, it, expect, vi, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useProjectsStore } from "../src/store/projects";
import { useComposerPrefsStore } from "../src/store/composer-prefs";
import { useProvidersStore } from "../src/store/providers";

const handlers = new Set<(e: any) => void>();
const sendMock = vi.fn();

vi.mock("../src/ws-instance", () => ({
  send: sendMock,
  onMessage: (h: (e: any) => void) => {
    handlers.add(h);
    return () => handlers.delete(h);
  },
}));

// 单元测试环境没有可用的 IndexedDB，用内存 mock 替换 composer-db
let memoryDefaults: { model: string | null; thinking: any } = { model: null, thinking: "disabled" };
const memorySessions: Record<string, any> = {};
mock.module("../src/store/composer-db", () => ({
  getDefaults: async () => memoryDefaults,
  setDefaults: async (prefs: any) => {
    memoryDefaults = { ...prefs };
  },
  getSessionPrefs: async (sessionId: string) => memorySessions[sessionId],
  setSessionPrefs: async (record: any) => {
    memorySessions[record.sessionId] = { ...record };
  },
  deleteSessionPrefs: async (sessionId: string) => {
    delete memorySessions[sessionId];
  },
}));

import { setDefaults as dbSetDefaults } from "../src/store/composer-db";
import { NewSessionPane } from "../src/components/NewSessionPane";

describe("NewSessionPane", () => {
  beforeEach(() => {
    memoryDefaults = { model: null, thinking: "disabled" };
    for (const k of Object.keys(memorySessions)) delete memorySessions[k];

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
    handlers.clear();
    sendMock.mockClear();
  });

  it("renders project and agent selects", () => {
    render(<NewSessionPane />);
    expect(screen.getByTestId("project-select")).toBeTruthy();
    expect(screen.getByTestId("agent-select")).toBeTruthy();
  });

  it("clears text after sending", async () => {
    await dbSetDefaults({ model: "gpt-4o", thinking: "disabled" });
    useProvidersStore.setState({
      providers: [
        { id: "p1", name: "openai", api: "openai-completions", baseUrl: "", apiKey: "", models: [{ id: "gpt-4o", contextWindow: 128000, maxTokens: 4096 }] },
      ],
    });
    render(<NewSessionPane />);
    // 等待 loadDefaults 应用内存默认值，避免发送被 model 空拦截
    await waitFor(() => {
      expect(useComposerPrefsStore.getState().defaults.model).toBe("openai/gpt-4o");
    });
    const textarea = screen.getByTestId("composer-input").querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "你好" } });
    expect(textarea.value).toBe("你好");
    fireEvent.click(screen.getByTestId("composer-send"));
    expect(textarea.value).toBe("");
  });

  it("sends first prompt with model and thinking", async () => {
    await dbSetDefaults({ model: "claude-sonnet", thinking: "high" });
    useProvidersStore.setState({
      providers: [
        { id: "p1", name: "anthropic", api: "anthropic-messages", baseUrl: "", apiKey: "", models: [{ id: "claude-sonnet", contextWindow: 128000, maxTokens: 4096 }] },
      ],
    });
    useComposerPrefsStore.setState({
      defaults: { model: null, thinking: "disabled" },
      bySession: {},
    });

    render(<NewSessionPane />);

    await waitFor(() => {
      expect(useComposerPrefsStore.getState().defaults.model).toBe("anthropic/claude-sonnet");
    });

    const textarea = screen.getByTestId("composer-input").querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.click(screen.getByTestId("composer-send"));

    await waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({
        type: "agent:prompt",
        projectId: "p1",
        text: "hello",
        model: "anthropic/claude-sonnet",
        thinking: "high",
      }));
    });
  });

  it("sends prompt with attachments", async () => {
    useProvidersStore.setState({
      providers: [
        { id: "p1", name: "openai", api: "openai-completions", baseUrl: "", apiKey: "", models: [{ id: "gpt-4o", contextWindow: 128000, maxTokens: 4096 }] },
      ],
    });
    await dbSetDefaults({ model: "gpt-4o", thinking: "disabled" });
    render(<NewSessionPane />);

    await waitFor(() => {
      expect(useComposerPrefsStore.getState().defaults.model).toBe("openai/gpt-4o");
    });

    const fileInput = screen.getByTestId("composer-input").querySelector("input[type=file]")!;
    const file = new File(["content"], "note.txt", { type: "text/plain" });
    fireEvent.change(fileInput, { target: { files: [file] } });

    // 等待自动上传请求发出并模拟 kernel 返回项目目录路径
    await waitFor(() => expect(sendMock).toHaveBeenCalled());
    const sent = sendMock.mock.calls.find(([e]) => e.type === "fs:upload")?.[0];
    expect(sent).toBeTruthy();
    handlers.forEach(h => h({ type: "fs:upload", id: sent.id, path: "/a/.hiagent/uploads/note.txt" }));

    await waitFor(() => {
      expect(screen.getByTestId("attachment-list")).toBeTruthy();
    });

    const textarea = screen.getByTestId("composer-input").querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "with attachment" } });
    fireEvent.click(screen.getByTestId("composer-send"));

    await waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({
        type: "agent:prompt",
        projectId: "p1",
        text: "with attachment",
        attachments: [expect.objectContaining({ kind: "file", name: "note.txt", path: "/a/.hiagent/uploads/note.txt" })],
      }));
    });
  });
});
