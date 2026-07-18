import { describe, it, expect, vi, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { useProjectsStore } from "../src/store/projects";
import { useComposerPrefsStore } from "../src/store/composer-prefs";
import { useProvidersStore } from "../src/store/providers";
import { useRecordingStore } from "../src/store/recording";
import { _setRecordingManager } from "../src/recording/recorder";
import { useSkillsStore } from "../src/store/skills";

// 把文本写入 contenteditable textbox 并触发 input 事件（替代原 textarea 的 fireEvent.change）
function typeIntoComposer(value: string) {
  const textbox = screen.getByTestId("composer-input").querySelector('[role="textbox"]') as HTMLElement;
  textbox.textContent = value;
  fireEvent.input(textbox);
  return textbox;
}

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
let memoryRecordingPrefs: { lastSource?: "mic" | "system" } = {};
let memoryNewSessionIds: Record<string, string> = {};
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
  getRecordingPrefs: async () => memoryRecordingPrefs,
  setRecordingPrefs: async (prefs: any) => {
    memoryRecordingPrefs = { ...prefs };
  },
  getNewSessionIds: async () => memoryNewSessionIds,
  setNewSessionIds: async (ids: Record<string, string>) => {
    memoryNewSessionIds = { ...ids };
  },
}));

import { setDefaults as dbSetDefaults } from "../src/store/composer-db";
import { NewSessionPane } from "../src/components/NewSessionPane";

describe("NewSessionPane", () => {
  beforeEach(() => {
    memoryDefaults = { model: null, thinking: "disabled" };
    for (const k of Object.keys(memorySessions)) delete memorySessions[k];
    memoryRecordingPrefs = {};
    memoryNewSessionIds = {};

    useProjectsStore.setState({
      projects: [{ id: "p1", name: "项目A", cwd: "/a", createdAt: 0 }],
      sessions: [],
      currentProjectId: "p1",
      currentSessionId: null,
    });
    useComposerPrefsStore.setState({
      defaults: { model: null, thinking: "disabled" },
      bySession: {},
      newSessionIds: {},
    });
    useRecordingStore.setState({
      status: "idle",
      source: "mic",
      owningProjectId: "",
      owningSessionId: "",
      ownerLabel: "",
      startedAt: 0,
      elapsedMs: 0,
      error: undefined,
    });
    _setRecordingManager({ start: async () => {}, pause: () => {}, resume: () => {}, stop: async () => ({ path: "", size: 0, durationMs: 0 }) });
    useSkillsStore.setState({
      skills: [], allSkills: [], dirs: [], disabledSkills: [], builtinDir: "", loading: false,
      load: () => {}, setAll: () => {}, toggleSkill: () => {}, addDir: () => {}, removeDir: () => {},
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
    // 等待 model 状态同步到 selector（跨测试异步更新可能延迟）
    await waitFor(() => {
      expect((screen.getByTestId("model-selector") as HTMLSelectElement).value).toBe("openai/gpt-4o");
    });
    const textbox = typeIntoComposer("你好");
    expect(textbox.textContent).toBe("你好");
    await waitFor(() => {
      expect((screen.getByTestId("composer-send") as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(screen.getByTestId("composer-send"));
    await waitFor(() => {
      expect(textbox.textContent).toBe("");
    });
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
    await waitFor(() => {
      expect((screen.getByTestId("model-selector") as HTMLSelectElement).value).toBe("anthropic/claude-sonnet");
    });

    typeIntoComposer("hello");
    await waitFor(() => {
      expect((screen.getByTestId("composer-send") as HTMLButtonElement).disabled).toBe(false);
    });
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
    await waitFor(() => {
      expect((screen.getByTestId("model-selector") as HTMLSelectElement).value).toBe("openai/gpt-4o");
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

    typeIntoComposer("with attachment");
    await waitFor(() => {
      expect((screen.getByTestId("composer-send") as HTMLButtonElement).disabled).toBe(false);
    });
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

  it("@提及智能体：以 mention 为 agentName 发送且不弹确认框（新会话无缓存）", async () => {
    await dbSetDefaults({ model: "gpt-4o", thinking: "disabled" });
    useProvidersStore.setState({
      providers: [
        { id: "p1", name: "openai", api: "openai-completions", baseUrl: "", apiKey: "", models: [{ id: "gpt-4o", contextWindow: 128000, maxTokens: 4096 }] },
      ],
    });
    render(<NewSessionPane />);
    await waitFor(() => {
      expect(useComposerPrefsStore.getState().defaults.model).toBe("openai/gpt-4o");
    });
    await waitFor(() => {
      expect((screen.getByTestId("model-selector") as HTMLSelectElement).value).toBe("openai/gpt-4o");
    });

    typeIntoComposer("@[pm] 帮我看看需求");
    await waitFor(() => {
      expect((screen.getByTestId("composer-send") as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(screen.getByTestId("composer-send"));

    await waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({
        type: "agent:prompt",
        projectId: "p1",
        agentName: "pm",
        text: "帮我看看需求",
      }));
    });
    // 新建会话 primaryAgent 也应为 mention
    const session = useProjectsStore.getState().sessions[0];
    expect(session.primaryAgent).toBe("pm");
    // 不弹缓存确认框
    expect(screen.queryByTestId("mention-confirm")).toBeNull();
    // agent-select 同步为 mention
    expect((screen.getByTestId("agent-select") as HTMLSelectElement).value).toBe("pm");
  });

  it("新会话开始录音、切换会话再回来后停止，附件仍回到当前新建会话", async () => {
    _setRecordingManager({
      start: async () => {},
      pause: () => {},
      resume: () => {},
      stop: async () => ({ path: "/a/.hiagent/uploads/recording.webm", size: 100, durationMs: 5000 }),
    });
    useProvidersStore.setState({
      providers: [
        { id: "p1", name: "openai", api: "openai-completions", baseUrl: "", apiKey: "", models: [{ id: "gpt-4o", contextWindow: 128000, maxTokens: 4096 }] },
      ],
    });
    await dbSetDefaults({ model: "gpt-4o", thinking: "disabled" });

    const { unmount } = render(<NewSessionPane />);
    await waitFor(() => {
      expect(useComposerPrefsStore.getState().defaults.model).toBe("openai/gpt-4o");
    });
    // 让 loadDefaults + setNewSessionId 的异步 state 更新在 act 内 flush
    await act(async () => {});

    fireEvent.click(screen.getByTestId("record-button"));
    await waitFor(() => expect(useRecordingStore.getState().status).toBe("recording"));
    const owningSessionId = useRecordingStore.getState().owningSessionId;
    expect(owningSessionId).toBeTruthy();

    // 模拟切到其它会话再返回新建会话（组件重新挂载）
    unmount();
    render(<NewSessionPane />);
    await act(async () => {});

    await act(async () => {
      await useRecordingStore.getState().stop();
    });

    await waitFor(() => {
      expect(screen.getByTestId("attachment-list")).toBeTruthy();
    });
    const list = screen.getByTestId("attachment-list");
    expect(list.textContent).toContain("录音 0:05.webm");
    // 附件必须写入当前可见的新建会话，而不是旧的随机 sessionId
    expect(useComposerPrefsStore.getState().bySession[owningSessionId]?.attachments?.length).toBeGreaterThanOrEqual(1);
  });
});
