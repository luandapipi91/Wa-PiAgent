import "./mock-composer-db";
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { composerDbDefaults, composerDbSessions } from "./mock-composer-db";

const sent: any[] = [];

mock.module("../src/api-client", () => ({
  api: {
    get: () => Promise.resolve({}),
    post: (_path: string, body?: any) => { sent.push({ path: _path, body }); return Promise.resolve({}); },
    put: () => Promise.resolve({}),
    del: () => Promise.resolve({}),
  },
  ApiError: class extends Error { status: number; constructor(m: string, s: number) { super(m); this.status = s; this.name = "ApiError"; } },
}));

import { Composer } from "../src/components/Composer";
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
    sent.length = 0;
    composerDbDefaults.model = null;
    composerDbDefaults.thinking = "disabled";
    for (const k of Object.keys(composerDbSessions)) delete composerDbSessions[k];
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
      loadedBySession: {},
    });
    useSessionStore.setState({ messagesBySession: {}, streamingBySession: {}, statusBySession: {}, optimisticEchoBySession: {} });
    useSkillsStore.setState({
      skills: [], allSkills: [], dirs: [], disabledSkills: [], builtinDir: "", loading: false,
      load: () => {}, setAll: () => {}, toggleSkill: () => {}, addDir: () => {}, removeDir: () => {},
    });
  });

  afterEach(() => {
    useSkillsStore.setState(useSkillsStore.getInitialState(), true);
  });

  function lastPrompt() {
    return sent.filter((s) => s.path && s.path.includes("/prompt")).at(-1)?.body;
  }

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
    composerDbDefaults.model = "anthropic/claude-sonnet";
    composerDbDefaults.thinking = "high";
    composerDbSessions.s1 = { model: "anthropic/claude-sonnet", thinking: "high", attachments: [{ kind: "snippet", name: "note", content: "context" }] };

    render(<Composer sessionId="s1" agentName="dev" />);
    await act(async () => {});
    typeIntoComposer("hello");
    fireEvent.click(screen.getByTestId("composer-send"));

    await waitFor(() => {
      const req = sent.filter((s) => s.path && s.path.includes("/prompt")).at(-1);
      expect(req?.path).toBe("/api/agents/p1/s1/prompt");
      expect(req?.body).toMatchObject({
        agentName: "dev",
        text: "hello",
        model: "anthropic/claude-sonnet",
        thinking: "high",
        attachments: [{ kind: "snippet", name: "note", content: "context" }],
      });
    });
  });

  it("clears text after sending and drops attachments from session prefs", async () => {
    useComposerPrefsStore.setState({
      bySession: {
        s1: { model: "openai/gpt-4o", thinking: "disabled", attachments: [] },
      },
    });
    composerDbDefaults.model = "openai/gpt-4o";
    composerDbSessions.s1 = { model: "openai/gpt-4o", thinking: "disabled", attachments: [] };

    render(<Composer sessionId="s1" agentName="dev" />);
    await act(async () => {});
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
    composerDbDefaults.model = "openai/gpt-4o";
    composerDbSessions.s1 = { model: "openai/gpt-4o", thinking: "disabled", attachments: [] };

    render(<Composer sessionId="s1" agentName="dev" isRunning />);
    await act(async () => {});
    typeIntoComposer("排队消息");

    fireEvent.click(screen.getByTestId("composer-send"));

    await waitFor(() => {
      const req = sent.filter((s) => s.path && s.path.includes("/prompt")).at(-1);
      expect(req?.path).toBe("/api/agents/p1/s1/prompt");
      expect(req?.body).toMatchObject({
        agentName: "dev",
        text: "排队消息",
        model: "openai/gpt-4o",
        thinking: "disabled",
      });
    });
  });

  it("agent 思考中发送消息入队但不注入会话列表，标记 optimisticEcho 防止 echo_user 重复", () => {
    useComposerPrefsStore.setState({
      bySession: { s1: { model: "openai/gpt-4o", thinking: "disabled", attachments: [] } },
    });
    composerDbDefaults.model = "openai/gpt-4o";
    composerDbSessions.s1 = { model: "openai/gpt-4o", thinking: "disabled", attachments: [] };

    render(<Composer sessionId="s1" agentName="dev" isRunning />);
    typeIntoComposer("排队等一下");
    fireEvent.click(screen.getByTestId("composer-send"));

    const s = useSessionStore.getState();
    expect(lastPrompt()).toMatchObject({ text: "排队等一下" });
    // 消息不应出现在会话列表（仅入 followUp 队列）
    expect(s.messagesBySession["s1"] ?? []).toHaveLength(0);
    expect(s.streamingBySession["s1"]).toBeFalsy();
    // 必须标记 optimisticEcho，否则 kernel 的 session:echo_user 会把 followUp 消息重复注入 messagesBySession
    expect(s.optimisticEchoBySession["s1"]).toBe(true);
  });

  it("乐观发送：点击发送立即入列用户消息 + 占位 AI loading + status thinking（不等 SDK 回声）", () => {
    useComposerPrefsStore.setState({
      bySession: { s1: { model: "openai/gpt-4o", thinking: "disabled", attachments: [] } },
    });
    composerDbDefaults.model = "openai/gpt-4o";
    composerDbSessions.s1 = { model: "openai/gpt-4o", thinking: "disabled", attachments: [] };

    render(<Composer sessionId="s1" agentName="dev" />);
    typeIntoComposer("马上看到我");
    fireEvent.click(screen.getByTestId("composer-send"));

    const s = useSessionStore.getState();
    expect(s.messagesBySession["s1"]).toHaveLength(1);
    expect((s.messagesBySession["s1"][0].message as any).content).toBe("马上看到我");
    expect(s.streamingBySession["s1"]).toBeTruthy();
    expect(s.statusBySession["s1"]).toBe("thinking");
    expect(s.optimisticEchoBySession["s1"]).toBe(true);
  });

  it("disabled=true 时 textarea 禁用、点发送不触发 agent:prompt", () => {
    useComposerPrefsStore.setState({
      bySession: { s1: { model: "openai/gpt-4o", thinking: "disabled", attachments: [] } },
    });
    composerDbDefaults.model = "openai/gpt-4o";
    composerDbSessions.s1 = { model: "openai/gpt-4o", thinking: "disabled", attachments: [] };

    render(<Composer sessionId="s1" agentName="dev" disabled />);
    const textbox = screen.getByTestId("composer-input").querySelector('[role="textbox"]') as HTMLElement;
    expect(textbox.isContentEditable).toBe(false);
    const before = sent.length;
    fireEvent.click(screen.getByTestId("composer-send"));
    const after = sent.length;
    expect(after).toBe(before);
  });

  it("@提及其他智能体：不弹确认框、不发 set-agent，原样发 @[xxx] 给主智能体", async () => {
    useComposerPrefsStore.setState({
      bySession: { s1: { model: "openai/gpt-4o", thinking: "disabled", attachments: [] } },
    });
    composerDbDefaults.model = "openai/gpt-4o";
    composerDbSessions.s1 = { model: "openai/gpt-4o", thinking: "disabled", attachments: [] };

    render(<Composer sessionId="s1" agentName="dev" />);
    await act(async () => {});
    typeIntoComposer("@[pm] 帮我看看需求");
    fireEvent.click(screen.getByTestId("composer-send"));

    expect(screen.queryByTestId("mention-confirm")).toBeNull();

    await waitFor(() => {
      const setAgent = sent.find((s) => s.path && s.path.includes("/set-agent"));
      expect(setAgent).toBeUndefined();
      const req = sent.filter((s) => s.path && s.path.includes("/prompt")).at(-1);
      expect(req?.path).toBe("/api/agents/p1/s1/prompt");
      expect(req?.body).toMatchObject({
        agentName: "dev",
        text: "@[pm] 帮我看看需求",
      });
    });
  });

  it("过期 model（provider 已删除、prefs 残留）→ 不发出 agent:prompt、不乐观上屏", () => {
    useProvidersStore.setState({ providers: [] });
    useComposerPrefsStore.setState({
      bySession: { s1: { model: "my-deepseek/deepseek-chat", thinking: "disabled", attachments: [] } },
    });
    composerDbDefaults.model = "my-deepseek/deepseek-chat";
    composerDbSessions.s1 = { model: "my-deepseek/deepseek-chat", thinking: "disabled", attachments: [] };

    render(<Composer sessionId="s1" agentName="dev" />);
    typeIntoComposer("这条消息不应发出");
    const before = sent.length;
    fireEvent.click(screen.getByTestId("composer-send"));
    const after = sent.length;

    expect(after).toBe(before);
    const s = useSessionStore.getState();
    expect(s.messagesBySession["s1"] ?? []).toHaveLength(0);
    expect(s.streamingBySession["s1"]).toBeFalsy();
  });

  it("冷加载切到已有会话：loadSession 异步间隙不得触发 auto-select 覆盖存储的 model", async () => {
    // 场景复现：本次启动首次切到 s2（bySession 缓存为空），s2 在 DB 里存了 claude-sonnet；
    // providers 已加载（auto-select 条件齐全）。修复前：loadSession 异步间隙 model=null
    // → ModelSelector auto-select 第一个模型（openai/gpt-4o）→ 覆盖 s2 的 prefs 与 defaults。
    composerDbSessions.s2 = { model: "anthropic/claude-sonnet", thinking: "disabled", attachments: [] };
    useProjectsStore.setState({
      projects: [],
      sessions: [
        { id: "s1", projectId: "p1", primaryAgent: "dev", title: "t", createdAt: 0, lastActivity: 0, piSessionFile: "" },
        { id: "s2", projectId: "p1", primaryAgent: "dev", title: "t2", createdAt: 0, lastActivity: 0, piSessionFile: "" },
      ],
      currentProjectId: "p1",
      currentSessionId: "s2",
    });

    render(<Composer sessionId="s2" agentName="dev" />);

    // loadSession 完成后：s2 的 model 必须还是 DB 里存储的值
    await waitFor(() => {
      expect(useComposerPrefsStore.getState().bySession["s2"]?.model).toBe("anthropic/claude-sonnet");
    });
    // defaults 也不得被 auto-select 污染成第一个模型
    expect(useComposerPrefsStore.getState().defaults.model).not.toBe("openai/gpt-4o");
  });

  it("prefs 含 text 时挂载后恢复草稿", async () => {
    useComposerPrefsStore.setState({
      bySession: { s1: { model: "openai/gpt-4o", thinking: "disabled", attachments: [], text: "写了一半" } },
      loadedBySession: { s1: true },
    });
    composerDbDefaults.model = "openai/gpt-4o";
    composerDbSessions.s1 = { model: "openai/gpt-4o", thinking: "disabled", attachments: [], text: "写了一半" };

    render(<Composer sessionId="s1" agentName="dev" />);
    await act(async () => {});
    const textbox = screen.getByTestId("composer-input").querySelector('[role="textbox"]') as HTMLElement;
    expect(textbox.textContent).toBe("写了一半");
  });

  it("输入防抖写回草稿；清空输入框写回空串（手动清空=放弃草稿）", async () => {
    useComposerPrefsStore.setState({
      bySession: { s1: { model: "openai/gpt-4o", thinking: "disabled", attachments: [] } },
      loadedBySession: { s1: true },
    });
    composerDbDefaults.model = "openai/gpt-4o";
    composerDbSessions.s1 = { model: "openai/gpt-4o", thinking: "disabled", attachments: [] };

    render(<Composer sessionId="s1" agentName="dev" />);
    await act(async () => {});
    const textbox = typeIntoComposer("草稿");
    await new Promise((r) => setTimeout(r, 350)); // 等防抖 300ms 触发
    expect(useComposerPrefsStore.getState().bySession["s1"]?.text).toBe("草稿");

    textbox.textContent = "";
    fireEvent.input(textbox);
    await new Promise((r) => setTimeout(r, 350));
    expect(useComposerPrefsStore.getState().bySession["s1"]?.text).toBe("");
  });

  it("发送后清空草稿（含防抖未触发场景：发送前输入不复活）", async () => {
    useComposerPrefsStore.setState({
      bySession: { s1: { model: "openai/gpt-4o", thinking: "disabled", attachments: [] } },
      loadedBySession: { s1: true },
    });
    composerDbDefaults.model = "openai/gpt-4o";
    composerDbSessions.s1 = { model: "openai/gpt-4o", thinking: "disabled", attachments: [] };

    render(<Composer sessionId="s1" agentName="dev" />);
    await act(async () => {});
    const textbox = typeIntoComposer("立即发送");
    // 300ms 内点发送：防抖定时器必须被清理，否则发送后草稿会"复活"
    fireEvent.click(screen.getByTestId("composer-send"));

    await waitFor(() => {
      expect(useComposerPrefsStore.getState().bySession["s1"]?.text).toBe("");
    });
    // 等待超过防抖窗口，确认没有被写回发送前文本
    await new Promise((r) => setTimeout(r, 350));
    expect(useComposerPrefsStore.getState().bySession["s1"]?.text).toBe("");
  });

  it("切换 sessionId 后清空旧文本并恢复新会话草稿（组件复用）", async () => {
    useComposerPrefsStore.setState({
      bySession: {
        s1: { model: "openai/gpt-4o", thinking: "disabled", attachments: [], text: "会话A草稿" },
        s2: { model: "openai/gpt-4o", thinking: "disabled", attachments: [], text: "会话B草稿" },
      },
      loadedBySession: { s1: true, s2: true },
    });
    composerDbDefaults.model = "openai/gpt-4o";
    composerDbSessions.s1 = { model: "openai/gpt-4o", thinking: "disabled", attachments: [], text: "会话A草稿" };
    composerDbSessions.s2 = { model: "openai/gpt-4o", thinking: "disabled", attachments: [], text: "会话B草稿" };
    useProjectsStore.setState({
      projects: [],
      sessions: [
        { id: "s1", projectId: "p1", primaryAgent: "dev", title: "t", createdAt: 0, lastActivity: 0, piSessionFile: "" },
        { id: "s2", projectId: "p1", primaryAgent: "dev", title: "t2", createdAt: 0, lastActivity: 0, piSessionFile: "" },
      ],
      currentProjectId: "p1",
      currentSessionId: "s1",
    });

    const { rerender } = render(<Composer sessionId="s1" agentName="dev" />);
    await act(async () => {});
    const textbox = screen.getByTestId("composer-input").querySelector('[role="textbox"]') as HTMLElement;
    expect(textbox.textContent).toBe("会话A草稿");

    rerender(<Composer sessionId="s2" agentName="dev" />);
    await act(async () => {});
    expect(textbox.textContent).toBe("会话B草稿");
  });
});
