import "./mock-composer-db";
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import type { AttachmentDraft } from "@wa-pi/shared";
import { composerDbDefaults, composerDbSessions } from "./mock-composer-db";

const sent: any[] = [];

mock.module("../src/api-client", () => ({
  api: {
    get: () => Promise.resolve({}),
    post: (_path: string, body?: any) => {
      sent.push({ path: _path, body });
      return Promise.resolve({});
    },
    put: () => Promise.resolve({}),
    del: () => Promise.resolve({}),
  },
  ApiError: class extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
      this.name = "ApiError";
    }
  },
}));

import { Composer } from "../src/components/Composer";
import { useCommandsStore } from "../src/store/commands";
import { useComposerPrefsStore } from "../src/store/composer-prefs";
import { useProjectsStore } from "../src/store/projects";
import { useProvidersStore } from "../src/store/providers";
import { useSessionStore } from "../src/store/session";
import { useSkillsStore } from "../src/store/skills";

// 把文本写入 contenteditable textbox 并触发 input 事件（替代原 textarea 的 fireEvent.change）
function typeIntoComposer(value: string) {
  const textbox = screen
    .getByTestId("composer-input")
    .querySelector('[role="textbox"]') as HTMLElement;
  textbox.textContent = value;
  fireEvent.input(textbox);
  return textbox;
}

describe("Composer", () => {
  beforeEach(() => {
    sent.length = 0;
    composerDbDefaults.model = null;
    composerDbDefaults.thinking = "disabled";
    for (const k of Object.keys(composerDbSessions))
      delete composerDbSessions[k];
    useProjectsStore.setState({
      projects: [],
      sessions: [
        {
          id: "s1",
          projectId: "p1",
          primaryAgent: "dev",
          title: "t",
          createdAt: 0,
          lastActivity: 0,
          piSessionFile: "",
        },
      ],
      currentProjectId: "p1",
      currentSessionId: "s1",
    });
    useProvidersStore.setState({
      providers: [
        {
          id: "prov-openai",
          name: "openai",
          api: "openai-completions",
          baseUrl: "",
          apiKey: "",
          models: [{ id: "gpt-4o", contextWindow: 128000, maxTokens: 4096 }],
        },
        {
          id: "prov-anthropic",
          name: "anthropic",
          api: "anthropic-messages",
          baseUrl: "",
          apiKey: "",
          models: [
            { id: "claude-sonnet", contextWindow: 200000, maxTokens: 8192 },
          ],
        },
      ],
    });
    useComposerPrefsStore.setState({
      defaults: { model: null, thinking: "disabled" },
      bySession: {},
      loadedBySession: {},
    });
    useSessionStore.setState({
      messagesBySession: {},
      streamingBySession: {},
      statusBySession: {},
      optimisticEchoBySession: {},
      queueBySession: {},
    });
    useCommandsStore.setState({
      commands: [],
      allCommands: [],
      loading: false,
    });
    useSkillsStore.setState({
      skills: [],
      allSkills: [],
      dirs: [],
      disabledSkills: [],
      builtinDir: "",
      loading: false,
      load: () => {},
      setAll: () => {},
      toggleSkill: () => {},
      addDir: () => {},
      removeDir: () => {},
    });
  });

  afterEach(() => {
    useSkillsStore.setState(useSkillsStore.getInitialState(), true);
  });

  function lastPrompt() {
    return sent.filter((s) => s.path && s.path.includes("/prompt")).at(-1)
      ?.body;
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
    composerDbSessions.s1 = {
      model: "anthropic/claude-sonnet",
      thinking: "high",
      attachments: [{ kind: "snippet", name: "note", content: "context" }],
    };

    render(<Composer sessionId="s1" agentName="dev" />);
    await act(async () => {});
    typeIntoComposer("hello");
    fireEvent.click(screen.getByTestId("composer-send"));

    await waitFor(() => {
      const req = sent
        .filter((s) => s.path && s.path.includes("/prompt"))
        .at(-1);
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
    composerDbSessions.s1 = {
      model: "openai/gpt-4o",
      thinking: "disabled",
      attachments: [],
    };

    render(<Composer sessionId="s1" agentName="dev" />);
    await act(async () => {});
    const textbox = typeIntoComposer("继续");
    expect(textbox.textContent).toBe("继续");

    fireEvent.click(screen.getByTestId("composer-send"));

    await waitFor(() => {
      expect(textbox.textContent).toBe("");
      expect(
        useComposerPrefsStore.getState().bySession["s1"]?.attachments,
      ).toEqual([]);
    });
  });

  it("still allows sending while agent is running (followUp queue)", async () => {
    useComposerPrefsStore.setState({
      bySession: {
        s1: { model: "openai/gpt-4o", thinking: "disabled", attachments: [] },
      },
    });
    composerDbDefaults.model = "openai/gpt-4o";
    composerDbSessions.s1 = {
      model: "openai/gpt-4o",
      thinking: "disabled",
      attachments: [],
    };

    render(<Composer sessionId="s1" agentName="dev" isRunning />);
    await act(async () => {});
    typeIntoComposer("排队消息");

    fireEvent.click(screen.getByTestId("composer-send"));

    await waitFor(() => {
      const req = sent
        .filter((s) => s.path && s.path.includes("/prompt"))
        .at(-1);
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
      bySession: {
        s1: { model: "openai/gpt-4o", thinking: "disabled", attachments: [] },
      },
    });
    composerDbDefaults.model = "openai/gpt-4o";
    composerDbSessions.s1 = {
      model: "openai/gpt-4o",
      thinking: "disabled",
      attachments: [],
    };

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
      bySession: {
        s1: { model: "openai/gpt-4o", thinking: "disabled", attachments: [] },
      },
    });
    composerDbDefaults.model = "openai/gpt-4o";
    composerDbSessions.s1 = {
      model: "openai/gpt-4o",
      thinking: "disabled",
      attachments: [],
    };

    render(<Composer sessionId="s1" agentName="dev" />);
    typeIntoComposer("马上看到我");
    fireEvent.click(screen.getByTestId("composer-send"));

    const s = useSessionStore.getState();
    expect(s.messagesBySession["s1"]).toHaveLength(1);
    expect((s.messagesBySession["s1"][0].message as any).content).toBe(
      "马上看到我",
    );
    expect(s.streamingBySession["s1"]).toBeTruthy();
    expect(s.statusBySession["s1"]).toBe("thinking");
    expect(s.optimisticEchoBySession["s1"]).toBe(true);
  });

  it("已注册扩展命令（/uidemo）：不乐观插入用户消息，仍原样发给 kernel", () => {
    useComposerPrefsStore.setState({
      bySession: {
        s1: { model: "openai/gpt-4o", thinking: "disabled", attachments: [] },
      },
    });
    composerDbDefaults.model = "openai/gpt-4o";
    composerDbSessions.s1 = {
      model: "openai/gpt-4o",
      thinking: "disabled",
      attachments: [],
    };
    // / 菜单命令清单含扩展命令 uidemo（已开启）
    useCommandsStore.setState({
      commands: [
        {
          name: "uidemo",
          source: "extension",
          packageName: "ext-ui-bridge-demo",
          enabled: true,
        },
      ],
      allCommands: [
        {
          name: "uidemo",
          source: "extension",
          packageName: "ext-ui-bridge-demo",
          enabled: true,
        },
      ],
      loading: false,
    });

    render(<Composer sessionId="s1" agentName="dev" />);
    typeIntoComposer("/uidemo notify");
    fireEvent.click(screen.getByTestId("composer-send"));

    const s = useSessionStore.getState();
    // pi 对已注册扩展命令拦截执行、不产生 user 回声 → 聊天列表不应出现该用户消息
    expect(s.messagesBySession["s1"] ?? []).toHaveLength(0);
    expect(s.streamingBySession["s1"]).toBeFalsy();
    expect(s.statusBySession["s1"]).toBeFalsy();
    // 文本仍原样交给 kernel 分发
    expect(lastPrompt()).toMatchObject({ text: "/uidemo notify" });
  });

  it("未注册 slash 文本（/unknown）：照常乐观插入（作为普通消息发给 LLM）", () => {
    useComposerPrefsStore.setState({
      bySession: {
        s1: { model: "openai/gpt-4o", thinking: "disabled", attachments: [] },
      },
    });
    composerDbDefaults.model = "openai/gpt-4o";
    composerDbSessions.s1 = {
      model: "openai/gpt-4o",
      thinking: "disabled",
      attachments: [],
    };
    useCommandsStore.setState({
      commands: [{ name: "uidemo", source: "extension", enabled: true }],
      allCommands: [{ name: "uidemo", source: "extension", enabled: true }],
      loading: false,
    });

    render(<Composer sessionId="s1" agentName="dev" />);
    typeIntoComposer("/unknown 你好");
    fireEvent.click(screen.getByTestId("composer-send"));

    const s = useSessionStore.getState();
    expect(s.messagesBySession["s1"]).toHaveLength(1);
    expect((s.messagesBySession["s1"][0].message as any).content).toBe(
      "/unknown 你好",
    );
  });

  it("开关已关闭的扩展命令（不在 / 菜单但在 allCommands）：仍不乐观插入（pi 注册即拦截）", () => {
    useComposerPrefsStore.setState({
      bySession: {
        s1: { model: "openai/gpt-4o", thinking: "disabled", attachments: [] },
      },
    });
    composerDbDefaults.model = "openai/gpt-4o";
    composerDbSessions.s1 = {
      model: "openai/gpt-4o",
      thinking: "disabled",
      attachments: [],
    };
    // goal 开关已关闭：/ 菜单（commands）不展示，但 allCommands 保留（pi 侧仍注册）
    useCommandsStore.setState({
      commands: [],
      allCommands: [
        {
          name: "goal",
          source: "extension",
          packageName: "pi-goal",
          enabled: false,
        },
      ],
      loading: false,
    });

    render(<Composer sessionId="s1" agentName="dev" />);
    typeIntoComposer("/goal 写个计划");
    fireEvent.click(screen.getByTestId("composer-send"));

    const s = useSessionStore.getState();
    expect(s.messagesBySession["s1"] ?? []).toHaveLength(0);
    expect(lastPrompt()).toMatchObject({ text: "/goal 写个计划" });
  });

  it("disabled=true 时 textarea 禁用、点发送不触发 agent:prompt", () => {
    useComposerPrefsStore.setState({
      bySession: {
        s1: { model: "openai/gpt-4o", thinking: "disabled", attachments: [] },
      },
    });
    composerDbDefaults.model = "openai/gpt-4o";
    composerDbSessions.s1 = {
      model: "openai/gpt-4o",
      thinking: "disabled",
      attachments: [],
    };

    render(<Composer sessionId="s1" agentName="dev" disabled />);
    const textbox = screen
      .getByTestId("composer-input")
      .querySelector('[role="textbox"]') as HTMLElement;
    expect(textbox.isContentEditable).toBe(false);
    const before = sent.length;
    fireEvent.click(screen.getByTestId("composer-send"));
    const after = sent.length;
    expect(after).toBe(before);
  });

  it("@提及其他智能体：不弹确认框、不发 set-agent，原样发 @[xxx] 给主智能体", async () => {
    useComposerPrefsStore.setState({
      bySession: {
        s1: { model: "openai/gpt-4o", thinking: "disabled", attachments: [] },
      },
    });
    composerDbDefaults.model = "openai/gpt-4o";
    composerDbSessions.s1 = {
      model: "openai/gpt-4o",
      thinking: "disabled",
      attachments: [],
    };

    render(<Composer sessionId="s1" agentName="dev" />);
    await act(async () => {});
    typeIntoComposer("@[pm] 帮我看看需求");
    fireEvent.click(screen.getByTestId("composer-send"));

    expect(screen.queryByTestId("mention-confirm")).toBeNull();

    await waitFor(() => {
      const setAgent = sent.find(
        (s) => s.path && s.path.includes("/set-agent"),
      );
      expect(setAgent).toBeUndefined();
      const req = sent
        .filter((s) => s.path && s.path.includes("/prompt"))
        .at(-1);
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
      bySession: {
        s1: {
          model: "my-deepseek/deepseek-chat",
          thinking: "disabled",
          attachments: [],
        },
      },
    });
    composerDbDefaults.model = "my-deepseek/deepseek-chat";
    composerDbSessions.s1 = {
      model: "my-deepseek/deepseek-chat",
      thinking: "disabled",
      attachments: [],
    };

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
    composerDbSessions.s2 = {
      model: "anthropic/claude-sonnet",
      thinking: "disabled",
      attachments: [],
    };
    useProjectsStore.setState({
      projects: [],
      sessions: [
        {
          id: "s1",
          projectId: "p1",
          primaryAgent: "dev",
          title: "t",
          createdAt: 0,
          lastActivity: 0,
          piSessionFile: "",
        },
        {
          id: "s2",
          projectId: "p1",
          primaryAgent: "dev",
          title: "t2",
          createdAt: 0,
          lastActivity: 0,
          piSessionFile: "",
        },
      ],
      currentProjectId: "p1",
      currentSessionId: "s2",
    });

    render(<Composer sessionId="s2" agentName="dev" />);

    // loadSession 完成后：s2 的 model 必须还是 DB 里存储的值
    await waitFor(() => {
      expect(useComposerPrefsStore.getState().bySession["s2"]?.model).toBe(
        "anthropic/claude-sonnet",
      );
    });
    // defaults 也不得被 auto-select 污染成第一个模型
    expect(useComposerPrefsStore.getState().defaults.model).not.toBe(
      "openai/gpt-4o",
    );
  });

  it("prefs 含 text 时挂载后恢复草稿", async () => {
    useComposerPrefsStore.setState({
      bySession: {
        s1: {
          model: "openai/gpt-4o",
          thinking: "disabled",
          attachments: [],
          text: "写了一半",
        },
      },
      loadedBySession: { s1: true },
    });
    composerDbDefaults.model = "openai/gpt-4o";
    composerDbSessions.s1 = {
      model: "openai/gpt-4o",
      thinking: "disabled",
      attachments: [],
      text: "写了一半",
    };

    render(<Composer sessionId="s1" agentName="dev" />);
    await act(async () => {});
    const textbox = screen
      .getByTestId("composer-input")
      .querySelector('[role="textbox"]') as HTMLElement;
    expect(textbox.textContent).toBe("写了一半");
  });

  it("输入防抖写回草稿；清空输入框写回空串（手动清空=放弃草稿）", async () => {
    useComposerPrefsStore.setState({
      bySession: {
        s1: { model: "openai/gpt-4o", thinking: "disabled", attachments: [] },
      },
      loadedBySession: { s1: true },
    });
    composerDbDefaults.model = "openai/gpt-4o";
    composerDbSessions.s1 = {
      model: "openai/gpt-4o",
      thinking: "disabled",
      attachments: [],
    };

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
      bySession: {
        s1: { model: "openai/gpt-4o", thinking: "disabled", attachments: [] },
      },
      loadedBySession: { s1: true },
    });
    composerDbDefaults.model = "openai/gpt-4o";
    composerDbSessions.s1 = {
      model: "openai/gpt-4o",
      thinking: "disabled",
      attachments: [],
    };

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
        s1: {
          model: "openai/gpt-4o",
          thinking: "disabled",
          attachments: [],
          text: "会话A草稿",
        },
        s2: {
          model: "openai/gpt-4o",
          thinking: "disabled",
          attachments: [],
          text: "会话B草稿",
        },
      },
      loadedBySession: { s1: true, s2: true },
    });
    composerDbDefaults.model = "openai/gpt-4o";
    composerDbSessions.s1 = {
      model: "openai/gpt-4o",
      thinking: "disabled",
      attachments: [],
      text: "会话A草稿",
    };
    composerDbSessions.s2 = {
      model: "openai/gpt-4o",
      thinking: "disabled",
      attachments: [],
      text: "会话B草稿",
    };
    useProjectsStore.setState({
      projects: [],
      sessions: [
        {
          id: "s1",
          projectId: "p1",
          primaryAgent: "dev",
          title: "t",
          createdAt: 0,
          lastActivity: 0,
          piSessionFile: "",
        },
        {
          id: "s2",
          projectId: "p1",
          primaryAgent: "dev",
          title: "t2",
          createdAt: 0,
          lastActivity: 0,
          piSessionFile: "",
        },
      ],
      currentProjectId: "p1",
      currentSessionId: "s1",
    });

    const { rerender } = render(<Composer sessionId="s1" agentName="dev" />);
    await act(async () => {});
    const textbox = screen
      .getByTestId("composer-input")
      .querySelector('[role="textbox"]') as HTMLElement;
    expect(textbox.textContent).toBe("会话A草稿");

    rerender(<Composer sessionId="s2" agentName="dev" />);
    await act(async () => {});
    expect(textbox.textContent).toBe("会话B草稿");
  });

  it("冷加载未编辑即卸载：cleanup 不写空文本，保留存储旧草稿", async () => {
    // 会话 A 在 IDB 有旧草稿 "old"；loadedBySession 未置位（loadSession 尚未完成）。
    // 用户未输入就切走/卸载：cleanup flush 不得写 text:""（否则 gap 空串胜出覆盖旧草稿）
    useComposerPrefsStore.setState({
      bySession: {
        s1: { model: "openai/gpt-4o", thinking: "disabled", attachments: [] },
      },
      loadedBySession: {},
    });
    composerDbDefaults.model = "openai/gpt-4o";
    composerDbSessions.s1 = {
      model: "openai/gpt-4o",
      thinking: "disabled",
      attachments: [],
      text: "old",
    };

    const { unmount } = render(<Composer sessionId="s1" agentName="dev" />);
    unmount(); // loadSession 完成前卸载
    await act(async () => {}); // 等 loadSession 完成并合并
    expect(useComposerPrefsStore.getState().bySession["s1"]?.text).toBe("old");
  });

  it("冷加载间隙已输入：loadSession 完成不恢复旧草稿覆盖用户输入", async () => {
    // 存储里有旧草稿，但 loadSession 尚未完成（prefsLoaded=false）；
    // 用户在间隙输入 "hello"（防抖未触发）→ loadSession 完成后恢复 effect 不得用旧草稿覆盖
    useComposerPrefsStore.setState({
      bySession: {
        s1: { model: "openai/gpt-4o", thinking: "disabled", attachments: [] },
      },
      loadedBySession: {},
    });
    composerDbDefaults.model = "openai/gpt-4o";
    composerDbSessions.s1 = {
      model: "openai/gpt-4o",
      thinking: "disabled",
      attachments: [],
      text: "旧草稿",
    };

    render(<Composer sessionId="s1" agentName="dev" />);
    typeIntoComposer("hello"); // 冷加载间隙即开始输入
    await act(async () => {}); // 等 loadSession 完成 → prefsLoaded=true
    const textbox = screen
      .getByTestId("composer-input")
      .querySelector('[role="textbox"]') as HTMLElement;
    expect(textbox.textContent).toBe("hello"); // 已输入内容未被旧草稿覆盖

    // 防抖照常写回已输入内容（不干扰、不被旧草稿污染）
    await new Promise((r) => setTimeout(r, 350));
    expect(useComposerPrefsStore.getState().bySession["s1"]?.text).toBe(
      "hello",
    );
  });

  it("set_editor_text 注入应用后清除记录：重挂载不重放、不覆盖用户后续编辑的草稿", async () => {
    // 回归：注入记录曾永留 store，appliedInjectionTsRef 随卸载重置 → 重挂载时
    // ts!==0 判定通过 → 旧注入重放，冲掉用户之后编辑的草稿（切「新会话」视图再切回即触发）
    useComposerPrefsStore.setState({
      bySession: {
        s1: { model: "openai/gpt-4o", thinking: "disabled", attachments: [] },
      },
      loadedBySession: { s1: true },
    });
    composerDbDefaults.model = "openai/gpt-4o";
    composerDbSessions.s1 = {
      model: "openai/gpt-4o",
      thinking: "disabled",
      attachments: [],
    };
    useSessionStore.setState({
      editorTextInjection: { s1: { text: "注入文本", ts: 123 } },
    });

    const { unmount } = render(<Composer sessionId="s1" agentName="dev" />);
    await act(async () => {});
    let textbox = screen
      .getByTestId("composer-input")
      .querySelector('[role="textbox"]') as HTMLElement;
    expect(textbox.textContent).toBe("注入文本");
    // 应用后注入记录已被清除（重挂载无从重放）
    expect(
      useSessionStore.getState().editorTextInjection["s1"],
    ).toBeUndefined();

    // 用户继续编辑（等防抖写回草稿）
    typeIntoComposer("用户改过的");
    await new Promise((r) => setTimeout(r, 350));
    expect(useComposerPrefsStore.getState().bySession["s1"]?.text).toBe(
      "用户改过的",
    );

    // 重挂载（模拟切「新会话」视图再切回）：恢复的是用户草稿，而非重放注入
    unmount();
    render(<Composer sessionId="s1" agentName="dev" />);
    await act(async () => {});
    textbox = screen
      .getByTestId("composer-input")
      .querySelector('[role="textbox"]') as HTMLElement;
    expect(textbox.textContent).toBe("用户改过的");
  });

  it("运行中 Ctrl+Enter 发送引导消息（steering）：调 /steer、入 steering 队列、不进 followUp、清空输入框与附件", async () => {
    const keptAttachment: AttachmentDraft[] = [
      { kind: "snippet", name: "keep", content: "keep" },
    ];
    useComposerPrefsStore.setState({
      bySession: {
        s1: {
          model: "openai/gpt-4o",
          thinking: "disabled",
          attachments: keptAttachment,
        },
      },
    });
    composerDbDefaults.model = "openai/gpt-4o";
    composerDbSessions.s1 = {
      model: "openai/gpt-4o",
      thinking: "disabled",
      attachments: keptAttachment,
    };

    render(<Composer sessionId="s1" agentName="dev" isRunning />);
    await act(async () => {});
    const textbox = typeIntoComposer("引导消息");
    fireEvent.keyDown(textbox, { key: "Enter", ctrlKey: true });

    await waitFor(() => {
      const steerReq = sent
        .filter((s) => s.path && s.path.includes("/steer"))
        .at(-1);
      expect(steerReq?.path).toBe("/api/sessions/s1/steer");
      expect(steerReq?.body).toMatchObject({ text: "引导消息" });
      // 附件随 /steer 请求发出（steer 链路 attachments 透传）
      expect(steerReq?.body.attachments).toEqual(keptAttachment);
      const s = useSessionStore.getState();
      expect(s.queueBySession["s1"]?.steering).toContain("引导消息");
      expect(s.queueBySession["s1"]?.followUp ?? []).not.toContain("引导消息");
      // 发送后清空输入框（setText 异步渲染，在 waitFor 内断言）
      expect(textbox.textContent).toBe("");
    });
    // 不得走 /prompt（引导消息不能进入 followUp 排队）
    expect(
      sent.filter((s) => s.path && s.path.includes("/prompt")),
    ).toHaveLength(0);
    // steer 分支发送后与 doSend 一致清空附件（附件已随请求发出，不再残留输入框）
    expect(
      useComposerPrefsStore.getState().bySession["s1"]?.attachments ?? [],
    ).toEqual([]);
  });

  it("空闲时 Ctrl+Enter 等同普通发送：调 /prompt", async () => {
    useComposerPrefsStore.setState({
      bySession: {
        s1: { model: "openai/gpt-4o", thinking: "disabled", attachments: [] },
      },
    });
    composerDbDefaults.model = "openai/gpt-4o";
    composerDbSessions.s1 = {
      model: "openai/gpt-4o",
      thinking: "disabled",
      attachments: [],
    };

    render(<Composer sessionId="s1" agentName="dev" />);
    await act(async () => {});
    const textbox = typeIntoComposer("普通消息");
    fireEvent.keyDown(textbox, { key: "Enter", ctrlKey: true });

    await waitFor(() => {
      const req = sent
        .filter((s) => s.path && s.path.includes("/prompt"))
        .at(-1);
      expect(req?.path).toBe("/api/agents/p1/s1/prompt");
      expect(req?.body).toMatchObject({ text: "普通消息", agentName: "dev" });
    });
    // 空闲 Ctrl+Enter 等同普通发送：不得调用 /steer
    expect(
      sent.filter((s) => s.path && s.path.includes("/steer")),
    ).toHaveLength(0);
  });

  it("IME 组词中 Ctrl+Enter 不触发发送", async () => {
    useComposerPrefsStore.setState({
      bySession: {
        s1: { model: "openai/gpt-4o", thinking: "disabled", attachments: [] },
      },
    });
    composerDbDefaults.model = "openai/gpt-4o";
    composerDbSessions.s1 = {
      model: "openai/gpt-4o",
      thinking: "disabled",
      attachments: [],
    };

    render(<Composer sessionId="s1" agentName="dev" isRunning />);
    await act(async () => {});
    const textbox = typeIntoComposer("测试");
    fireEvent.keyDown(textbox, {
      key: "Enter",
      ctrlKey: true,
      isComposing: true,
    });

    await waitFor(() => expect(sent.length).toBe(0));
  });

  it("运行中已有引导中时，Ctrl+Enter 降级进排队队列：调 /prompt、不叠加 steering、不调 /steer", async () => {
    useComposerPrefsStore.setState({
      bySession: {
        s1: { model: "openai/gpt-4o", thinking: "disabled", attachments: [] },
      },
    });
    composerDbDefaults.model = "openai/gpt-4o";
    composerDbSessions.s1 = {
      model: "openai/gpt-4o",
      thinking: "disabled",
      attachments: [],
    };
    // 预置：已有引导中（steering 非空）
    useSessionStore.setState({
      queueBySession: { s1: { steering: ["已有引导"], followUp: [] } },
    });

    render(<Composer sessionId="s1" agentName="dev" isRunning />);
    await act(async () => {});
    const textbox = typeIntoComposer("第二条消息");
    fireEvent.keyDown(textbox, { key: "Enter", ctrlKey: true });

    await waitFor(() => {
      // 降级为排队：调 /prompt，不调 /steer
      const req = sent
        .filter((s) => s.path && s.path.includes("/prompt"))
        .at(-1);
      expect(req?.path).toBe("/api/agents/p1/s1/prompt");
      expect(req?.body).toMatchObject({ text: "第二条消息", agentName: "dev" });
      // steering 不叠加第二条，保持一条
      const s = useSessionStore.getState();
      expect(s.queueBySession["s1"]?.steering).toEqual(["已有引导"]);
      // 消息进入 followUp 排队
      expect(s.queueBySession["s1"]?.followUp).toContain("第二条消息");
    });
    // 不得调用 /steer
    expect(
      sent.filter((s) => s.path && s.path.includes("/steer")),
    ).toHaveLength(0);
    // 输入框清空
    expect(textbox.textContent).toBe("");
  });

  it("macOS Cmd+Enter 运行中同样引导发送：调 /steer", async () => {
    useComposerPrefsStore.setState({
      bySession: {
        s1: { model: "openai/gpt-4o", thinking: "disabled", attachments: [] },
      },
    });
    composerDbDefaults.model = "openai/gpt-4o";
    composerDbSessions.s1 = {
      model: "openai/gpt-4o",
      thinking: "disabled",
      attachments: [],
    };

    render(<Composer sessionId="s1" agentName="dev" isRunning />);
    await act(async () => {});
    const textbox = typeIntoComposer("Cmd 引导");
    fireEvent.keyDown(textbox, { key: "Enter", metaKey: true });

    await waitFor(() => {
      const steerReq = sent
        .filter((s) => s.path && s.path.includes("/steer"))
        .at(-1);
      expect(steerReq?.path).toBe("/api/sessions/s1/steer");
      expect(steerReq?.body).toMatchObject({ text: "Cmd 引导" });
    });
    // metaKey 与 ctrlKey 统一处理：不得走 /prompt
    expect(
      sent.filter((s) => s.path && s.path.includes("/prompt")),
    ).toHaveLength(0);
  });
});
