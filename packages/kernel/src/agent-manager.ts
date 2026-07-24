// AgentManager：管 pi rpc 子进程会话
//
// 架构（RPC 迁移后）：
// - 每个 HiAgent 会话对应一个 `pi --mode rpc` 子进程（rpc-client.ts 驱动），
//   不再 import @earendil-works/pi-coding-agent 的 SDK API。
// - steer / followUp 队列由 kernel 自管（RPC 无 clearQueue 等价物）：
//   followUp 在 agent_settled 时逐条 drain；steering 在 turn_end 时逐条投递；
//   队列变更合成 queue_update 事件转发给上层，前端契约不变。
// - 宿主工具（ask/memory/delegate/fleet）经 hiagent-bridge 扩展注册到 pi 进程，
//   工具 execute 回调 kernel /bridge/tool（bridge-registry.ts 注册的 ctx 执行）。
// - 系统提示词组合（composePrompt）结果写入临时文件，经 --system-prompt <file> 传入。
// - 工具放行：默认排除式（-xt subagent）；agent 配置显式 tools 时用 --tools 白名单
//   （config.tools ∪ EXTENSION_TOOL_MAP ∪ MCP direct 工具名）。
//
// 依赖注入：
// - createClientFn 可选参数，缺省时用真实 RpcClient（测试注入假 client）
// - bridgeBaseUrl 惰性取值：kernel 启动时 WS 端口在 AgentManager 构造后才确定

import type { AgentName, AttachmentRef, ThinkingLevel, MemoryConfig } from "@hiagent/shared";
import { HIAGENT_DIR, DEFAULT_AGENT_TOOLS, BUILTIN_SKILLS_DIR, EXTENSION_TOOL_MAP, resolveAgentTools, resolveSessionCwd, PROMPTS_FILE, SUBAGENT_TYPES, isSubagentType } from "@hiagent/shared";
import type { ProjectStore } from "./project-store";
import type { ConfigStore } from "./config-store";
import type { ProviderStore } from "./provider-store";
import { relative, join } from "node:path";
import { mkdir, writeFile, rm, appendFile } from "node:fs/promises";
import { buildAdditionalExtensionPaths } from "./extensions";
import { getGlobalMemoryStore, getProjectMemoryStore } from "./amaster-memory";
import { reconcileDanglingAsks } from "./ask-tool";
import { makeDelegateTool, makeFleetTool, buildDelegateRoster, makeSpawnFn } from "./delegate-tool";
import { SubagentTelemetry } from "./subagent-telemetry";
import type { HiAgentSpawnConfig } from "./subagent-runner";
import { seedBuiltinAgents } from "./builtin-agents";
import { readBuiltinAgentPrompt } from "./subagent-info";
import { askRegistry } from "./ask-registry";
import type { SkillManager } from "./skill-manager";
import type { ExtensionManager } from "./extension-manager";
import type { McpStore } from "./mcp-store";
import { resolveMcpDirectToolNames } from "./mcp-connector";
import {
  registerBridgeSession,
  unregisterBridgeSession,
  getBridgeToken,
  makeDefaultBridgeContext,
  type BridgeSessionContext,
  type BridgeToolResult,
} from "./bridge-registry";
import {
  RpcClient,
  buildPiArgs,
  resolvePiCliPath,
  resolvePiRuntime,
  type RpcClientOpts,
  type RpcEvent,
} from "./rpc-client";
import {
  composePrompt, loadPromptSegments, DEFAULT_PROMPT_SEGMENTS, HIAGENT_DEFAULT_BASE_PROMPT,
  type PromptSegment,
} from "./system-prompt";

/** 可注入的 client 工厂（测试用假 client 替换；生产 new RpcClient） */
export type CreateClientFn = (opts: RpcClientOpts) => RpcClient;

/** 上层事件回调携带的事件类型：pi RPC 事件 + kernel 合成的 queue_update */
export type AgentManagerEvent = RpcEvent;

export interface AgentManagerOpts {
  projectStore: ProjectStore;
  // configStore 可空：测试用 mock client 时不需要真实配置
  configStore: ConfigStore | null;
  // providerStore 可空：保留兼容（RPC 模式下模型能力查询走 pi 进程，暂未使用）
  providerStore?: ProviderStore;
  // 上层事件回调：携带 sessionId/projectId/agentName 上下文，转发 pi 事件与合成事件
  onEvent: (
    sessionId: string,
    projectId: string,
    agentName: AgentName,
    e: AgentManagerEvent,
  ) => void;
  // skillManager 可空：生产注入真实 SkillManager，解析启用 skill 目录传给 --skill
  skillManager?: SkillManager;
  // extensionManager 可空：用于按已启用动态插件决定 -e 扩展路径与工具放行
  extensionManager?: ExtensionManager;
  // mcpStore 可空：受限 agent 的 --tools 白名单需要 MCP direct 工具名（kernel 侧计算）
  mcpStore?: McpStore;
  // 惰性取 bridge 回调地址（kernel WS 端口在 AgentManager 构造后才确定）
  bridgeBaseUrl?: () => string;
  // 测试注入 mock；生产留空 → 真实 RpcClient
  createClientFn?: CreateClientFn;
  // 记忆配置读取（reviewEnabled 自动学习开关 / memoryPolicyStyle 注入提示开关）。
  // 可空：测试场景不传视为全开（与历史行为一致）；生产注入 MemoryStore。
  memoryStore?: { getConfig(): Promise<MemoryConfig> };
}

// 系统提示词的默认兜底基础段（被 prompts.json 的 base.content 覆盖；
// 若 base.content 也未写、且 config.systemPromptBody 未指定，最终使用此值）。
// 完整提示词段落组装见 system-prompt.ts。
export const HIAGENT_DEFAULT_SYSTEM_PROMPT = HIAGENT_DEFAULT_BASE_PROMPT;

/** 永不放行给 LLM 直接调用的工具（subagent 必须走宿主 delegate 工具） */
const ALWAYS_EXCLUDED_TOOLS = ["subagent"];

/** 单个会话的运行时句柄 */
interface SessionHandle {
  client: RpcClient;
  cwd: string;
  meta: { projectId: string; agentName: AgentName };
  /** agent 是否忙碌（prompt 发送后置 true，agent_settled 置 false） */
  busy: boolean;
  /** 历史消息快照（创建时经 get_messages 拉取 + message_end 增量追加） */
  messages: any[];
  /** kernel 自管队列 */
  steering: string[];
  followUp: string[];
  /** 系统提示词临时文件（dispose 时清理） */
  promptFile: string | null;
  /** 进程意外退出标记（下次 ensureStarted 重建） */
  crashed: boolean;
  /** dispose 标记（防止 onExit 误判为崩溃） */
  disposed: boolean;
  /** 子代理派发遥测收集器（会话销毁时 flush 到 subagent-telemetry.jsonl） */
  subagentTelemetry: SubagentTelemetry;
}

export class AgentManager {
  // sessionId → SessionHandle（核心数据结构，一个 HiAgent 会话对应一个 pi rpc 子进程）
  private sessions = new Map<string, SessionHandle>();
  // sessionId → promote/immediate 操作锁，防止快速连点导致并发 race
  private jumpQueueLocks = new Map<string, Promise<void>>();
  // 并发创建锁：同 sessionId 同时只创建一次，防止快速连发导致重复初始化同一 jsonl
  private starting = new Map<string, Promise<SessionHandle>>();
  // 标记在创建过程中被 dispose 的 sessionId，防止已清理的会话在创建完成后重新泄漏回 Map
  private disposed = new Set<string>();
  // 标记在 _createSession 期间收到的 abort 请求：client 注册后立即执行
  private pendingAborts = new Set<string>();
  // deferred reload：技能/扩展配置变更后标脏；会话下次命中缓存时重建（pi 进程重启）
  private dirty = new Set<string>();
  // deferred 重建：skill 配置变更（目录增删 / skill 禁用）后标脏；与 dirty 统一为进程重启，
  // 保留两个集合仅为调用方语义区分（skill:toggle 走 markSkillsDirty，extension 走 markAllDirty）
  private skillDirty = new Set<string>();
  // 系统提示词段落配置缓存（首次加载后缓存；用户编辑 prompts.json 后需重启 kernel 刷新）
  private promptSegments: PromptSegment[] | null = null;

  constructor(private opts: AgentManagerOpts) {}

  /**
   * 加载系统提示词段落配置（启动后首次调用时读 PROMPTS_FILE，之后用缓存）。
   * 读失败或格式错误时降级用代码内置默认配置，绝不抛错（保证 agent 创建不被提示词文件阻塞）。
   */
  private async getPromptSegments(): Promise<PromptSegment[]> {
    if (this.promptSegments !== null) return this.promptSegments;
    // ensurePromptsConfig 幂等：版本匹配时不动，版本过旧时迁移静态段（生产环境 index.ts 已调，此处兜底测试/直接构造场景）
    const { ensurePromptsConfig } = await import("./system-prompt");
    await ensurePromptsConfig(PROMPTS_FILE);
    const loaded = await loadPromptSegments(PROMPTS_FILE);
    this.promptSegments = loaded ?? DEFAULT_PROMPT_SEGMENTS;
    return this.promptSegments;
  }

  /**
   * 启动或复用一个会话。
   * 同 sessionId 命中 Map 缓存则直接返回；进程崩溃/标脏则重建；否则创建新 pi 进程。
   * 并发调用时共享同一个创建 Promise。
   */
  async ensureStarted(
    projectId: string,
    agentName: AgentName,
    sessionId: string,
  ): Promise<SessionHandle> {
    // 命中缓存：进程已崩溃则拆除重建；否则按 dirty 标记决定重建或直接复用
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (existing.crashed || !existing.client.isAlive()) {
        this._teardownSession(sessionId);
      } else {
        return await this._reloadIfDirty(sessionId, existing);
      }
    }

    // 同 sessionId 正在创建中则复用创建 Promise
    const inFlight = this.starting.get(sessionId);
    if (inFlight) return await inFlight;

    // 之前被 dispose 过的 sessionId 允许重新创建
    this.disposed.delete(sessionId);

    const promise = this._createSession(projectId, agentName, sessionId);
    this.starting.set(sessionId, promise);
    try {
      return await promise;
    } finally {
      this.starting.delete(sessionId);
    }
  }

  /**
   * 标记当前所有活跃会话为待重建（扩展/插件配置变更后调用）。
   * 不立即重建——各会话在下次被 ensureStarted（切换/使用）时各自重建一次。
   */
  markAllDirty(): void {
    for (const id of this.sessions.keys()) this.dirty.add(id);
  }

  /**
   * 标记当前所有活跃会话为待重建（skill 目录增删 / skill 禁用后调用）。
   * 与 markAllDirty 统一为进程重启（--skill 列表构造时固定，只能重启刷新）。
   */
  markSkillsDirty(): void {
    for (const id of this.sessions.keys()) this.skillDirty.add(id);
  }

  /** agent 重命名联动：更新活跃会话 meta，标 skillDirty 使下次 ensureStarted 重建 */
  renameAgentSessions(oldName: string, newName: string): void {
    for (const [id, handle] of this.sessions) {
      if (handle.meta.agentName === oldName) {
        this.sessions.set(id, { ...handle, meta: { ...handle.meta, agentName: newName } });
        this.skillDirty.add(id);
      }
    }
  }

  /** 对话中切换智能体：运行中先 abort，拆除后按同一 sessionId 重建（jsonl 历史保留） */
  async switchAgent(sessionId: string, agentName: AgentName): Promise<void> {
    const old = this.sessions.get(sessionId);
    if (old?.busy) {
      try { await old.client.abort(); } catch { /* 忽略 */ }
    }
    const meta = old?.meta;
    this._teardownSession(sessionId);
    const projectId = meta?.projectId ?? (await this.opts.projectStore.load()).sessions.find(s => s.id === sessionId)?.projectId;
    if (!projectId) throw new Error(`会话不存在: ${sessionId}`);
    await this.opts.projectStore.setSessionAgent(sessionId, agentName);
    const promise = this._createSession(projectId, agentName, sessionId);
    this.starting.set(sessionId, promise);
    try { await promise; } finally { this.starting.delete(sessionId); }
  }

  /**
   * 读取当前启用的可选插件 id 集合，供 -e 扩展路径与工具放行过滤。
   * 无 extensionManager 时返回空集（保持测试兼容）。
   */
  private async getEnabledExtensionIds(): Promise<Set<string>> {
    if (!this.opts.extensionManager) return new Set();
    const { packages } = await this.opts.extensionManager.list();
    return new Set(packages.filter((p) => p.enabled).map((p) => p.name));
  }

  /** 计算 MCP direct 工具名（受限 agent 白名单与 listGlobalTools 用）；无 mcpStore 时返回空 */
  private async getMcpDirectToolNames(): Promise<string[]> {
    if (!this.opts.mcpStore) return [];
    try {
      const [servers, settings] = await Promise.all([
        this.opts.mcpStore.list(),
        this.opts.mcpStore.getGlobalSettings(),
      ]);
      return await resolveMcpDirectToolNames(servers, settings);
    } catch (err) {
      console.error("[kernel] MCP direct 工具名计算失败，跳过:", err);
      return [];
    }
  }

  /** 全局工具清单：内置（DEFAULT_AGENT_TOOLS）+ MCP direct + 动态插件登记，供详情弹窗勾选。
   *  剔除 subagent（宿主不允许直接暴露，关系网调起走 delegate）。 */
  async listGlobalTools(): Promise<{ name: string; source: string }[]> {
    const items = DEFAULT_AGENT_TOOLS
      .filter((t) => t !== "subagent")
      .map((name) => ({ name, source: "内置" }));
    const seen = new Set(items.map((i) => i.name));
    // MCP direct 工具（kernel 侧按 mcp.json 计算，命名与 pi-mcp-adapter 一致）
    for (const t of await this.getMcpDirectToolNames()) {
      if (!seen.has(t)) { seen.add(t); items.push({ name: t, source: "扩展" }); }
    }
    // 动态插件登记的工具（EXTENSION_TOOL_MAP 按启用态注入）
    const enabledIds = await this.getEnabledExtensionIds();
    for (const [extId, extTools] of Object.entries(EXTENSION_TOOL_MAP)) {
      if (!enabledIds.has(extId)) continue;
      for (const t of extTools) {
        if (!seen.has(t) && t !== "subagent") { seen.add(t); items.push({ name: t, source: "扩展" }); }
      }
    }
    return items;
  }

  /**
   * 命中缓存时：dirty 标记（skill / extension 配置变更）→ 重建进程；进行中则跳过等 idle。
   */
  private async _reloadIfDirty(
    sessionId: string,
    handle: SessionHandle,
  ): Promise<SessionHandle> {
    const isDirty = this.skillDirty.has(sessionId) || this.dirty.has(sessionId);
    if (!isDirty) return handle;
    if (handle.busy || handle.followUp.length > 0) return handle;  // 进行中，保留 dirty 等 idle

    this.skillDirty.delete(sessionId);
    this.dirty.delete(sessionId);
    // 重建：拆除旧进程（不动 disposed）+ 重新 _createSession（同一会话文件，历史不丢）。
    // 用 starting 锁防止重建期间并发 ensureStarted 重复创建。
    this._teardownSession(sessionId);
    const promise = this._createSession(handle.meta.projectId, handle.meta.agentName, sessionId);
    this.starting.set(sessionId, promise);
    try {
      return await promise;
    } finally {
      this.starting.delete(sessionId);
    }
  }

  private async _createSession(
    projectId: string,
    agentName: AgentName,
    sessionId: string,
  ): Promise<SessionHandle> {
    // 启动时写入内置 subagent 的 .md 定义文件（~/.hiagent/agents/*.md），已存在不覆盖
    const agentsDir = join(HIAGENT_DIR, "agents");
    seedBuiltinAgents(agentsDir);

    // 从 ProjectStore 拉 project + session 实体（校验存在性 + 拿 cwd / piSessionFile）
    const { projects, sessions } = await this.opts.projectStore.load();
    const project = projects.find((p) => p.id === projectId);
    if (!project) throw new Error(`项目不存在: ${projectId}`);
    if (!project.cwd) {
      throw new Error(`项目工作目录缺失: ${project.name ?? projectId}`);
    }

    const sessionEntity = sessions.find((s) => s.id === sessionId);
    if (!sessionEntity) throw new Error(`会话不存在: ${sessionId}`);
    if (!sessionEntity.piSessionFile) {
      throw new Error(`会话 piSessionFile 缺失: ${sessionId}`);
    }

    // 计算本次会话的 cwd（普通项目会话用 project.cwd；默认工作区会话用 resolveSessionCwd 推导）
    const cwd = resolveSessionCwd(sessionEntity, project);

    // 读 agent 配置（系统提示词 / 工具 / 模型 / thinking level）
    const config = this.opts.configStore
      ? await this.opts.configStore.getAgent(agentName)
      : null;

    // 解析启用 skill 的目录路径，传给 pi 的 --skill 参数
    const additionalSkillPaths = await resolveEnabledSkillPaths(
      this.opts.skillManager,
      this.opts.extensionManager,
    );

    // host-controlled 记忆：预取全局+项目记忆快照注入系统提示词；记忆读取失败降级为空快照。
    // 「注入提示」开关（memoryPolicyStyle=none）关闭时不注入。
    const memConfig = await this.opts.memoryStore?.getConfig().catch(() => undefined);
    const memorySnapshot = memConfig?.memoryPolicyStyle === "none"
      ? ""
      : await buildMemorySnapshot(HIAGENT_DIR, cwd).catch(
        (err) => {
          console.error(`[kernel] 读取记忆快照失败，跳过注入:`, err);
          return "";
        },
      );

    // 关系网调起：delegate/fleet 工具的可用名单与 roster（与迁移前一致，内置 subagent 类型始终可调用）
    const askToNames = config?.partners?.askTo ?? [];
    const askToConfigs = (await Promise.all(askToNames.map((n) => this.opts.configStore!.getAgent(n)))).filter(
      (c): c is NonNullable<typeof c> => c != null,
    );
    // 加载系统提示词段落配置（首次加载后缓存）
    const promptSegments = await this.getPromptSegments();
    const askToTargets = askToConfigs.map((c) => ({
      name: c.displayName,
      description: c.description,
      delegationHints: c.delegationHints,
    }));

    // resolveSpawnConfig：从 ConfigStore 读 HiAgent 配置（用户在 UI 设置的 model/thinking/tools/skills），
    // 内置 subagent 类型不在 store 里——从 SUBAGENT_TYPES 常量读元信息 + ~/.hiagent/agents/*.md 读系统提示词。
    const resolveSpawnConfig = async (agentName: string): Promise<HiAgentSpawnConfig | null> => {
      // 内置 subagent 类型：从 SUBAGENT_TYPES 元信息 + agents/*.md 读定义（用户可覆盖）
      if (isSubagentType(agentName)) {
        const builtin = SUBAGENT_TYPES.find(t => t.name === agentName);
        if (builtin) {
          const prompt = await readBuiltinAgentPrompt(agentsDir, agentName);
          // 读取用户保存的 model/thinking 覆盖（~/.hiagent/subagent-overrides.json）
          const { getSubagentOverride } = await import("./subagent-store");
          const { SUBAGENT_OVERRIDES_FILE } = await import("@hiagent/shared");
          const override = await getSubagentOverride(SUBAGENT_OVERRIDES_FILE, agentName);
          return {
            name: builtin.name,
            description: builtin.description,
            systemPrompt: prompt,
            systemPromptMode: "replace",
            model: override?.model ?? null,
            thinking: override?.thinking ?? null,
            tools: builtin.readOnly ? ["read", "bash", "grep", "find", "ls"] : [],
            skills: [],
          };
        }
      }
      // 命名智能体：从 ConfigStore 读配置
      const cfg = await this.opts.configStore?.getAgent(agentName).catch(() => null);
      if (!cfg) return null;
      return {
        name: cfg.displayName,
        description: cfg.description,
        systemPrompt: cfg.systemPromptBody ?? "",
        systemPromptMode: cfg.systemPromptMode,
        model: cfg.model,
        thinking: cfg.thinking,
        tools: cfg.tools,
        skills: cfg.skills,
      };
    };

    // 会话级子代理遥测收集器：随 spawnFn 生命周期创建，_teardownSession 时 flush
    const subagentTelemetry = new SubagentTelemetry();
    const spawnFn = makeSpawnFn({
      resolveConfig: resolveSpawnConfig,
      cwd,
      onSpawnComplete: (input) => subagentTelemetry.record(input),
    });

    // 内置 subagent 的委派引导从 ~/.hiagent/agents/*.md 的 frontmatter 提取（与命名智能体统一来源）
    const { getSubagentInfo } = await import("./subagent-info");
    const builtinSubagents = await getSubagentInfo([]);
    const builtinHints: Record<string, import("@hiagent/shared").DelegationHints | undefined> = {};
    for (const s of builtinSubagents) {
      if (s.delegationHints) builtinHints[s.name] = s.delegationHints;
    }
    // 可用子智能体总览段：内置 + 命名统一列表（注入系统提示词 delegate-roster 段）
    const delegateRoster = buildDelegateRoster(askToTargets, builtinHints, agentsDir);

    // delegate/fleet 工具实例（execute 由 bridge ctx 调用；schema 在 hiagent-bridge 扩展里）
    const delegateTool = makeDelegateTool({ askTo: askToTargets, spawn: spawnFn });
    const fleetTool = makeFleetTool({ askTo: askToTargets, spawn: spawnFn });

    // bridge 会话上下文：ask/memory 走默认工厂，delegate/fleet 接宿主实现；
    // reviewEnabled=false 时记忆工具返回关闭提示（对齐迁移前「不注册记忆工具」的行为）
    const memoryEnabled = memConfig?.reviewEnabled !== false;
    const defaultCtx = makeDefaultBridgeContext({
      sessionId,
      cwd,
      memoryStores: {
        global: getGlobalMemoryStore(HIAGENT_DIR),
        project: getProjectMemoryStore(HIAGENT_DIR, cwd),
      },
    });
    const bridgeCtx: BridgeSessionContext = {
      cwd,
      async handleTool(tool, toolCallId, params, signal): Promise<BridgeToolResult> {
        if (tool === "delegate") {
          return delegateTool.execute(toolCallId, params as { agent: string; task: string });
        }
        if (tool === "fleet") {
          return fleetTool.execute(toolCallId, params as { tasks: Array<{ agent: string; task: string }> });
        }
        if (!memoryEnabled && tool.startsWith("memory_")) {
          return { content: [{ type: "text", text: "记忆功能已关闭（reviewEnabled=false）" }], details: { error: "memory_disabled" } };
        }
        return defaultCtx.handleTool(tool, toolCallId, params, signal);
      },
    };

    // 组合系统提示词并写入临时文件（pi 的 --system-prompt 支持文件路径，规避命令行长度限制）。
    // 角色提示词（agent.md 正文 systemPromptBody）注入 base 段：
    //   - systemPromptMode === "replace"（seed 与新建角色的默认）：正文替代默认 base 提示词
    //   - systemPromptMode === "append"：正文追加在默认 base 提示词之后
    // 注意：prompts.json 的 base.content（用户全局覆盖）优先级最高——
    // renderSegment 里 segment.content 非空时直接使用，不看 defaultBasePrompt。
    const defaultBasePrompt = !config?.systemPromptBody
      ? HIAGENT_DEFAULT_BASE_PROMPT
      : config.systemPromptMode === "append"
        ? `${HIAGENT_DEFAULT_BASE_PROMPT}\n\n${config.systemPromptBody}`
        : config.systemPromptBody;
    const composedPrompt = composePrompt(promptSegments, {
      defaultBasePrompt,
      delegateRoster,
      builtinSkillsDir: BUILTIN_SKILLS_DIR,
      memorySnapshot,
    });
    const tmpDir = join(HIAGENT_DIR, "tmp", "sysprompts");
    await mkdir(tmpDir, { recursive: true });
    const promptFile = join(tmpDir, `${sessionId}.md`);
    await writeFile(promptFile, composedPrompt, "utf8");

    // 工具放行策略：
    // - 默认（agent 未显式配置 tools）：排除式——不传 --tools，仅 -xt subagent；
    //   内置 7 工具 + 扩展工具 + MCP direct 工具全部可用（对齐迁移前 DEFAULT+harvested 的行为）。
    // - 显式配置 tools：白名单——config.tools ∪ EXTENSION_TOOL_MAP ∪ MCP direct 工具名。
    const enabledExtensionIds = await this.getEnabledExtensionIds();
    const restricted = !!(config?.tools?.length);
    const toolArgs: { tools?: string[]; excludeTools?: string[] } = restricted
      ? {
          tools: resolveAgentTools(
            config!.tools!,
            enabledExtensionIds,
            agentName,
            EXTENSION_TOOL_MAP,
            await this.getMcpDirectToolNames(),
          ),
        }
      : { excludeTools: [...ALWAYS_EXCLUDED_TOOLS] };

    // 注册 bridge 上下文（pi 进程内 hiagent-bridge 扩展回调用）
    registerBridgeSession(sessionId, bridgeCtx);

    // thinking level 映射（disabled→off，max→xhigh，其余透传）
    const thinking = mapThinkingLevel(config?.thinking ?? "medium");

    // spawn pi rpc 子进程
    const createClient: CreateClientFn = this.opts.createClientFn ?? ((o) => new RpcClient(o));
    const handle: SessionHandle = {
      client: null as unknown as RpcClient,
      cwd,
      meta: { projectId, agentName },
      busy: false,
      messages: [],
      steering: [],
      followUp: [],
      promptFile,
      crashed: false,
      disposed: false,
      subagentTelemetry,
    };
    const client = createClient({
      cliPath: resolvePiCliPath(),
      runtime: resolvePiRuntime(),
      args: buildPiArgs({
        sessionFile: sessionEntity.piSessionFile,
        systemPromptFile: promptFile,
        extensionPaths: buildAdditionalExtensionPaths([...enabledExtensionIds]),
        skillPaths: additionalSkillPaths,
        noSkills: true,
        thinking,
        name: `${agentName}-${sessionId.slice(0, 8)}`,
        ...toolArgs,
      }),
      cwd,
      env: {
        PI_CODING_AGENT_DIR: HIAGENT_DIR,
        HIAGENT_BRIDGE_URL: this.opts.bridgeBaseUrl?.() ?? "",
        HIAGENT_BRIDGE_TOKEN: getBridgeToken(),
        HIAGENT_SESSION_ID: sessionId,
      },
      onEvent: (e) => this._onSessionEvent(sessionId, e),
      onExit: (code) => this._onProcessExit(sessionId, code),
    });
    handle.client = client;

    // 提前注册 handle 到 map，让 abort / queue 操作在 start 期间即可用
    this.sessions.set(sessionId, handle);

    try {
      await client.start();
    } catch (err) {
      this._teardownSession(sessionId);
      throw err;
    }

    // _createSession 期间收到的 abort 请求：client 已注册，立即执行
    if (this.pendingAborts.has(sessionId)) {
      this.pendingAborts.delete(sessionId);
      try { await client.abort(); } catch { /* abort 失败不阻塞创建 */ }
    }

    // 历史消息快照（ws-server 的 session:messages 依赖该同步读取）。
    // 重启兜底：对「无 result 的 ask 调用」在快照里注入 cancelled，避免前端展示悬挂提问。
    try {
      const messages = await client.getMessages();
      handle.messages = reconcileDanglingAsks(messages) as any[];
    } catch (err) {
      console.error(`[kernel] session ${sessionId} 拉取历史消息失败:`, err);
      handle.messages = [];
    }

    // 如果创建过程中被 dispose，清理已提前注册的 handle
    if (this.disposed.has(sessionId)) {
      this.disposed.delete(sessionId);
      this._teardownSession(sessionId);
      throw new Error(`会话已清理: ${sessionId}`);
    }

    return handle;
  }

  // ---- 事件与队列 ----

  /** pi 事件入口：维护 busy/队列，再转发给上层 */
  private _onSessionEvent(sessionId: string, event: RpcEvent): void {
    const handle = this.sessions.get(sessionId);
    if (!handle) return;

    switch (event.type) {
      case "agent_start":
        handle.busy = true;
        break;
      case "message_end":
        if (event.message) handle.messages.push(event.message);
        break;
      case "turn_end":
        // steering 队列投递：每个完成的 turn 后投一条（one-at-a-time 语义）
        if (handle.steering.length > 0 && handle.busy) {
          const text = handle.steering.shift()!;
          handle.client.steer(text).catch((err) => {
            console.error(`[kernel] session ${sessionId} steer 投递失败:`, err);
          });
          this._emitQueueUpdate(sessionId, handle);
        }
        break;
      case "agent_settled":
        handle.busy = false;
        // followUp 队列 drain：agent 完全空闲后逐条发送
        if (handle.followUp.length > 0) {
          const text = handle.followUp.shift()!;
          this._emitQueueUpdate(sessionId, handle);
          void this._sendPromptNow(sessionId, handle, text).catch((err) => {
            console.error(`[kernel] session ${sessionId} followUp drain 失败:`, err);
          });
        }
        break;
    }

    this.opts.onEvent(sessionId, handle.meta.projectId, handle.meta.agentName, event);
  }

  /** 进程退出：非主动 dispose 的退出视为崩溃，合成错误事件通知前端，标记待重建 */
  private _onProcessExit(sessionId: string, code: number | null): void {
    const handle = this.sessions.get(sessionId);
    if (!handle || handle.disposed) return;
    handle.crashed = true;
    handle.busy = false;
    console.error(`[kernel] session ${sessionId} pi 进程意外退出 (code=${code})`);
    // 合成 message_end 错误事件：复用 extractSdkErrorMessage → 前端 ⚠️ 渲染管线
    this.opts.onEvent(sessionId, handle.meta.projectId, handle.meta.agentName, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: `agent 进程意外退出 (code=${code})，请重新发送消息`,
        timestamp: Date.now(),
      },
    });
  }

  /** 合成 queue_update 事件（形状与 pi/SDK 原生一致，前端契约不变） */
  private _emitQueueUpdate(sessionId: string, handle: SessionHandle): void {
    this.opts.onEvent(sessionId, handle.meta.projectId, handle.meta.agentName, {
      type: "queue_update",
      steering: [...handle.steering],
      followUp: [...handle.followUp],
    });
  }

  /** 立即发送 prompt（busy 置位 + 失败回退） */
  private async _sendPromptNow(sessionId: string, handle: SessionHandle, text: string): Promise<void> {
    handle.busy = true;
    try {
      await handle.client.prompt(text);
    } catch (err) {
      handle.busy = false;
      throw err;
    }
  }

  /** 发送用户输入。agent 运行中或队列非空时进 kernel followUp 队列；空闲时直接 prompt。 */
  async prompt(
    sessionId: string,
    text: string,
    opts?: {
      model?: string;
      thinking?: ThinkingLevel;
      attachments?: AttachmentRef[];
    },
  ): Promise<void> {
    const handle = this.sessions.get(sessionId);
    if (!handle) throw new Error(`会话未启动: ${sessionId}`);

    // 所有消息必须跟随用户显式选择的模型，禁止回退到 agent config 或 pi 默认模型
    if (!opts?.model) {
      throw new Error("未选择模型，请先在模型选择器中选择一个模型");
    }

    // 按请求切换模型（"provider/modelId" 拆分；无 "/" 时经 get_available_models 解析）
    const { provider, modelId } = await this._resolveModel(handle.client, opts.model);
    await handle.client.setModel(provider, modelId);

    // 按请求切换 thinking level（disabled→off，max→xhigh，pi 侧不支持时自动降级）
    if (opts?.thinking) {
      await handle.client.setThinkingLevel(mapThinkingLevel(opts.thinking));
    }

    // 构建最终 prompt 文本：snippet 直接内联，文件/图片统一用 @相对路径 引用
    const { text: finalText } = buildPromptContent(
      text,
      opts?.attachments ?? [],
      handle.cwd,
    );

    if (handle.busy || handle.followUp.length > 0 || handle.steering.length > 0) {
      handle.followUp.push(finalText);
      this._emitQueueUpdate(sessionId, handle);
      return;
    }
    await this._sendPromptNow(sessionId, handle, finalText);
  }

  /**
   * 清空队列 + abort + 剩余重入队 + 发目标消息。
   * immediate 专用；promoteToSteer 不打断当前 agent，仅移动队列。
   * @param interrupt 为 true 时目标消息优先以 steer 方式插队（abort 后 agent 仍在跑时降级）
   */
  private async _jumpQueue(sessionId: string, text: string, remainingTexts: string[], interrupt: boolean = false): Promise<void> {
    const handle = this.sessions.get(sessionId);
    if (!handle) throw new Error(`会话未启动: ${sessionId}`);

    askRegistry.cancelAll(sessionId);   // 中断类（immediate）作废 pending 提问

    // 1. 清空 kernel 队列（RPC 无 clearQueue 等价物，队列全在 kernel 侧）
    handle.steering = [];
    handle.followUp = [];

    // 2. 中断当前运行
    await handle.client.abort();
    handle.busy = false;

    // 3. 剩余消息重入 kernel followUp 队列
    handle.followUp.push(...remainingTexts);

    // 4. 目标消息作为新回合开始
    if (interrupt) {
      // abort 后 agent 可能仍在执行 tool calls（事件未落定），直接 prompt 会被拒，
      // 此时降级为 steer 插队，仍能尽快生效
      try {
        await this._sendPromptNow(sessionId, handle, text);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("already processing") || message.includes("streaming")) {
          await handle.client.steer(text);
          handle.busy = true;
        } else {
          throw err;
        }
      }
    } else {
      await this._sendPromptNow(sessionId, handle, text);
    }
    this._emitQueueUpdate(sessionId, handle);
  }

  /** 对 per-session 队列操作加串行锁（连续点击"引导"/"立即"时后一次等前一次完成） */
  private async _lockedQueueOp(sessionId: string, op: () => Promise<void>): Promise<void> {
    const previous = this.jumpQueueLocks.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => { }).then(op);
    this.jumpQueueLocks.set(sessionId, next);
    await next;
  }

  private async _lockedJumpQueue(sessionId: string, text: string, remainingTexts: string[], interrupt: boolean): Promise<void> {
    await this._lockedQueueOp(sessionId, () => this._jumpQueue(sessionId, text, remainingTexts, interrupt));
  }

  /** 提升排队消息为引导（不打断当前 agent，把目标消息从 followUp 移到 steering） */
  async promoteToSteer(sessionId: string, text: string, remainingTexts: string[]): Promise<void> {
    await this._lockedQueueOp(sessionId, async () => {
      const handle = this.sessions.get(sessionId);
      if (!handle) throw new Error(`会话未启动: ${sessionId}`);

      // 目标消息进 steering（当前 turn 结束后投递），其余按调用方给定顺序回 followUp
      handle.steering.push(text);
      handle.followUp = [...remainingTexts];

      // 空闲时 steering 立即以 prompt 生效
      if (!handle.busy) {
        const next = handle.steering.shift()!;
        await this._sendPromptNow(sessionId, handle, next);
      }
      this._emitQueueUpdate(sessionId, handle);
    });
  }

  /** 立即执行排队消息（abort → 清空 → 剩余重入队 → 目标消息作为新回合） */
  async immediate(sessionId: string, text: string, remainingTexts: string[]): Promise<void> {
    await this._lockedJumpQueue(sessionId, text, remainingTexts, true);
  }

  /** 清空 steer 引导队列（session 不存在时静默忽略） */
  clearSteeringQueue(sessionId: string): void {
    const handle = this.sessions.get(sessionId);
    if (!handle) return;
    handle.steering = [];
    this._emitQueueUpdate(sessionId, handle);
  }

  /** 清空 followUp 排队队列（session 不存在时静默忽略） */
  clearFollowUpQueue(sessionId: string): void {
    const handle = this.sessions.get(sessionId);
    if (!handle) return;
    handle.followUp = [];
    this._emitQueueUpdate(sessionId, handle);
  }

  /** 发送引导消息入队（不打断当前 agent，当前 turn 结束后生效；空闲时立即生效） */
  steerMessage(sessionId: string, text: string): void {
    const handle = this.sessions.get(sessionId);
    if (!handle) return;
    if (handle.busy) {
      handle.steering.push(text);
      this._emitQueueUpdate(sessionId, handle);
    } else {
      handle.busy = true;
      handle.client.prompt(text).catch((err) => {
        handle.busy = false;
        console.error(`[kernel] session ${sessionId} steerMessage 发送失败:`, err);
      });
    }
  }

  /** 清空全部队列（steering + followUp） — session 不存在时静默忽略 */
  clearAllQueues(sessionId: string): void {
    const handle = this.sessions.get(sessionId);
    if (!handle) return;
    handle.steering = [];
    handle.followUp = [];
    this._emitQueueUpdate(sessionId, handle);
  }

  /** 中止当前会话：清空 kernel 队列 + abort。 */
  async abort(sessionId: string): Promise<void> {
    const handle = this.sessions.get(sessionId);
    if (!handle) {
      if (this.starting.has(sessionId)) this.pendingAborts.add(sessionId);
      return;
    }

    askRegistry.cancelAll(sessionId);
    handle.steering = [];
    handle.followUp = [];
    this._emitQueueUpdate(sessionId, handle);
    console.log(`[agent-manager] abort session=${sessionId} busy=${handle.busy}`);
    await handle.client.abort().catch((err) => {
      console.error(`[agent-manager] abort 命令失败 session=${sessionId}:`, err);
    });
    handle.busy = false;
    console.log(`[agent-manager] abort DONE session=${sessionId}`);
  }

  /** 读取会话历史消息快照（session 不存在时返回空数组） */
  getMessages(sessionId: string): any[] {
    return this.sessions.get(sessionId)?.messages ?? [];
  }

  /** 检查 session 是否正在运行（供外部判断 abort 时 agent 是否已启动） */
  isSessionStreaming(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.busy ?? false;
  }

  /** 会话销毁时把子代理派发遥测追加到 HIAGENT_DIR/subagent-telemetry.jsonl（fire-and-forget） */
  private _flushSubagentTelemetry(sessionId: string, handle: SessionHandle): void {
    const records = handle.subagentTelemetry.records;
    if (records.length === 0) return;
    const summary = handle.subagentTelemetry.summary;
    const lines = [
      ...records.map((r) => JSON.stringify({ sessionId, ...r })),
      JSON.stringify({ type: "session_summary", sessionId, ts: new Date().toISOString(), ...summary }),
    ];
    console.log(
      `[telemetry] session ${sessionId.slice(0, 8)}: ${summary.spawnCount} 次派发，` +
      `成功率 ${(summary.successRate * 100).toFixed(0)}%，` +
      `估计节省父上下文 ${summary.totalSavingsTokensEst} tokens，` +
      `压缩率 ${summary.aggregateCompressionRatio.toFixed(2)}`,
    );
    void appendFile(join(HIAGENT_DIR, "subagent-telemetry.jsonl"), lines.join("\n") + "\n", "utf8")
      .catch(() => {});
  }

  /** 拆除单个会话的内部资源（注销 bridge ctx + kill 进程 + 清临时文件与各 Map），不动 disposed 标记 */
  private _teardownSession(sessionId: string): void {
    askRegistry.cancelAll(sessionId);  // 拆除资源时作废 pending ask
    unregisterBridgeSession(sessionId);
    const handle = this.sessions.get(sessionId);
    if (handle) {
      handle.disposed = true;
      this._flushSubagentTelemetry(sessionId, handle);
      // dispose 是异步 kill，fire-and-forget（调用方多为同步拆除路径）
      void handle.client.dispose().catch(() => {});
      if (handle.promptFile) {
        void rm(handle.promptFile, { force: true }).catch(() => {});
      }
    }
    this.sessions.delete(sessionId);
    this.jumpQueueLocks.delete(sessionId);
    this.dirty.delete(sessionId);
    this.skillDirty.delete(sessionId);
  }

  /** 清理单个会话：标记 disposed（防创建中被复用）+ 拆除资源 */
  async disposeSession(sessionId: string): Promise<void> {
    // 标记已被 dispose：若创建仍在进行中，_createSession 完成时会据此清理并放弃
    this.disposed.add(sessionId);
    this._teardownSession(sessionId);
  }

  /** 清理所有会话（进程退出 / 测试 teardown 用） */
  async disposeAll(): Promise<void> {
    // 复制 keys 避免 disposeSession 修改 Map 时迭代异常
    for (const id of [...this.sessions.keys()]) {
      await this.disposeSession(id);
    }
  }

  /**
   * 把模型字符串解析成 provider + modelId。
   * 常规形式 "provider/modelId"（按第一个 "/" 拆分，modelId 允许含 "/"）。
   * 无 "/" 时经 pi 的 get_available_models 模糊匹配（兼容旧数据里的裸 modelId）。
   */
  private async _resolveModel(
    client: RpcClient,
    pattern: string,
  ): Promise<{ provider: string; modelId: string }> {
    const slash = pattern.indexOf("/");
    if (slash > 0) {
      return { provider: pattern.slice(0, slash), modelId: pattern.slice(slash + 1) };
    }
    try {
      const data = await client.command({ type: "get_available_models" });
      const models: Array<{ id: string; provider: string }> = data?.models ?? [];
      const exact = models.find((m) => m.id === pattern);
      if (exact) return { provider: exact.provider, modelId: exact.id };
      const ci = models.find((m) => m.id.toLowerCase() === pattern.toLowerCase());
      if (ci) return { provider: ci.provider, modelId: ci.id };
    } catch { /* 查询失败走下面的错误 */ }
    throw new Error(`模型解析失败 (${pattern}): 请使用 "provider/modelId" 形式`);
  }
}

/** thinking level 映射：disabled→off，max→xhigh，其余透传（pi 侧不支持时自动降级） */
function mapThinkingLevel(thinking: string): string {
  return thinking === "disabled" ? "off" : thinking === "max" ? "xhigh" : thinking;
}

/** 构建 prompt 最终文本。snippet 直接内联；文件/图片统一用项目相对路径 @引用。 */
interface PromptContent {
  text: string;
}

function buildPromptContent(
  text: string,
  attachments: AttachmentRef[],
  cwd?: string,
): PromptContent {
  const textParts: string[] = [];
  const fileRefs: string[] = [];

  for (const a of attachments) {
    if (a.kind === "snippet") {
      textParts.push(`[片段: ${a.name}]\n${a.content}`);
    } else {
      const rel = cwd ? relative(cwd, a.path).replace(/\\/g, "/") : a.path;
      fileRefs.push(`@${rel}`);
    }
  }

  textParts.push(text);

  if (fileRefs.length > 0) {
    const refsText = `[${fileRefs.join(",\n")}]`;
    textParts.push(`Attachments:\n${refsText}`);
  }

  return { text: textParts.join("\n\n") };
}

/**
 * 构造注入系统提示词的记忆快照：全局 memory+user，叠加项目 memory+user。
 * 返回 amaster 已做 promptware 清洗的冻结快照；无任何记忆时返回空串。
 * 只读——agent 写记忆走 bridge 回调的记忆工具，全局记忆由用户经 UI 维护。
 */
async function buildMemorySnapshot(hiagentDir: string, projectCwd: string): Promise<string> {
  const parts: string[] = [];
  const globalSnap = await getGlobalMemoryStore(hiagentDir).snapshotAll();
  if (globalSnap) parts.push(globalSnap);
  const projectSnap = await getProjectMemoryStore(hiagentDir, projectCwd).snapshotAll();
  if (projectSnap) parts.push(projectSnap);
  return parts.join("\n\n");
}

/**
 * 解析启用 skill 的目录路径列表，供 pi --skill 参数使用。
 * 包含内置目录、userSkillDirs 和扩展包 skills/ 目录来源的**启用**技能。
 * Pi SDK 默认扫描已关闭（--no-skills），所以必须显式传入所有要加载的技能路径。
 * skillManager 为空（测试场景）时返回空数组。
 */
async function resolveEnabledSkillPaths(
  skillManager: SkillManager | undefined,
  extensionManager?: ExtensionManager,
): Promise<string[]> {
  if (!skillManager) return [];

  // 获取扩展技能路径（可能为空）
  const extSkillPaths = extensionManager
    ? await extensionManager.getEnabledExtensionSkillPaths()
    : [];

  // scan 已按 builtin → userDirs → ext 顺序去重并过滤 disabledSkills
  const { skills } = await skillManager.scan(extSkillPaths);

  // 把所有启用 skill 的具体目录路径传给 Pi，覆盖 --no-skills 后的空加载
  return skills.map((s) => s.path);
}
