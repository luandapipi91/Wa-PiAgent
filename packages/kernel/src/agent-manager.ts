// AgentManager：管 AgentSession 对象
//
// 设计要点：
// - 用 Map<sessionId, AgentSession> 管理生命周期（不再用 projectId:agentName:sessionId 三 key）
// - 通过 createAgentSessionFn 注入 createAgentSession（测试用 mock，生产用真实 SDK）
// - ensureStarted 里调 session.setSessionName() 设置 pi-intercom 会话名
// - session.subscribe() 把 SDK 事件转发给上层 onEvent
//
// 依赖注入：
// - createAgentSessionFn 可选参数，缺省时动态 import 真实 SDK（避免类型循环依赖）
// - _authStorage / _modelRegistry 用 (this as any)._xxx ??= 模式做进程级单例

import type { AgentName, AgentConfig, AttachmentRef, ThinkingLevel } from "@hiagent/shared";
import { HIAGENT_DIR, DEFAULT_AGENT_TOOLS } from "@hiagent/shared";
import type { ProjectStore } from "./project-store";
import type { ConfigStore } from "./config-store";
import type { ProviderStore } from "./provider-store";
import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { relative, isAbsolute } from "node:path";
import { buildAdditionalExtensionPaths } from "./extensions";
import type { SkillManager } from "./skill-manager";

// 可注入的 createAgentSession 签名（与 SDK 的 createAgentSession 对齐，但用 any 避免 SDK 类型穿透）
// 测试用 mock 替换；生产路径走真实 SDK
type CreateAgentSessionFn = (opts: {
  cwd: string;
  agentDir: string;
  sessionManager: any;
  resourceLoader: any;
  model?: any;
  thinkingLevel?: string;
  tools?: string[];
  authStorage: any;
  modelRegistry: any;
}) => Promise<{ session: AgentSession }>;

export interface AgentManagerOpts {
  projectStore: ProjectStore;
  // configStore 可空：测试用 mock createAgentSession 时不需要真实配置
  configStore: ConfigStore | null;
  // providerStore 可空：用于判断当前模型是否支持图片输入；测试可 mock
  providerStore?: ProviderStore;
  // 上层事件回调：携带 sessionId/projectId/agentName 上下文，转发 SDK 原始事件
  onEvent: (
    sessionId: string,
    projectId: string,
    agentName: AgentName,
    e: AgentSessionEvent,
  ) => void;
  // skillManager 可空：测试用 mock createAgentSession 且不关心 skill 时可不传；
  // 生产注入真实 SkillManager，_createSession 用其 scan() 取启用 skill 路径喂给 SDK loader
  skillManager?: SkillManager;
  // 测试注入 mock；生产留空 → 走真实 SDK 动态 import
  createAgentSessionFn?: CreateAgentSessionFn;
}

/**
 * hiagent 默认系统提示词（systemPromptOverride 的兜底，即「默认 replace 模式」）。
 *
 * 始终作为 DefaultResourceLoader.systemPromptOverride 的返回值，使 loader.getSystemPrompt()
 * 非空 → buildSystemPrompt 走 customPrompt 分支，绕过 SDK 默认提示词。SDK 默认提示词里写死了
 * "You are ... operating inside pi, a coding agent harness." 和整段 "Pi documentation"
 * （指示 agent 被问到 skills 时去读 docs/skills.md 等），会把「底层是 pi」直接暴露给 agent。
 *
 * 代价：customPrompt 分支不会自动生成 SDK 默认分支里的 "Available tools: ..." 工具清单和部分
 * 动态 guidelines；工具本身仍通过 tool schema 注入，agent 照常可用。文案可按需调整。
 */
const HIAGENT_DEFAULT_SYSTEM_PROMPT =
  "You are an expert coding assistant operating inside hiagent. " +
  "You help users by reading files, executing commands, editing code, and writing new files.\n\n" +
  "Use the available tools to explore and modify the codebase. " +
  "Be concise in your responses. Show file paths clearly when working with files.";

export class AgentManager {
  // sessionId → AgentSession（核心数据结构，一个 HiAgent 会话对应一个 SDK session）
  private sessions = new Map<string, AgentSession>();
  // sessionId → 项目工作目录，用于把附件绝对路径转成相对路径
  private sessionCwd = new Map<string, string>();
  // sessionId → unsubscribe 函数（dispose 时解绑事件订阅）
  private unsubscribers = new Map<string, () => void>();
  // sessionId → promote/immediate 操作锁，防止快速连点导致并发 race
  private jumpQueueLocks = new Map<string, Promise<void>>();
  // 并发创建锁：同 sessionId 同时只创建一次，防止快速连发导致重复初始化同一 jsonl
  private starting = new Map<string, Promise<AgentSession>>();
  // 标记在创建过程中被 dispose 的 sessionId，防止已清理的会话在创建完成后重新泄漏回 Map
  private disposed = new Set<string>();
  // deferred reload：技能/扩展配置变更后标脏；会话下次命中缓存时 reload 一次并清脏。
  private dirty = new Set<string>();
  // deferred 重建：skill 配置变更（目录增删 / skill 禁用）后标脏；会话下次命中缓存且 idle 时重建。
  // 与 dirty（reload 路径，extension toggle 用）分开，因为 additionalSkillPaths 构造时固定，必须重建才能刷新。
  private skillDirty = new Set<string>();
  // sessionId → {projectId, agentName}，重建会话时复用（_reloadIfDirty 没有 projectId/agentName 入参）
  private sessionMeta = new Map<string, { projectId: string; agentName: AgentName }>();

  constructor(private opts: AgentManagerOpts) {}

  /**
   * 启动或复用一个 AgentSession。
   * 同 sessionId 命中 Map 缓存则直接返回；否则创建新 session、设置 intercom 会话名、订阅事件。
   * 并发调用时共享同一个创建 Promise，避免重复创建 SDK session 导致 jsonl 文件 EEXIST。
   */
  async ensureStarted(
    projectId: string,
    agentName: AgentName,
    sessionId: string,
  ): Promise<AgentSession> {
    // 命中缓存：deferred reload（若有）后直接返回（同 session 复用，不重复创建）
    const existing = this.sessions.get(sessionId);
    if (existing) {
      await this._reloadIfDirty(sessionId, existing);
      return existing;
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
   * 标记当前所有活跃会话为待 reload（技能/扩展配置变更后调用）。
   * 不立即 reload——各会话在下次被 ensureStarted（切换/使用）时各自 reload 一次。
   */
  markAllDirty(): void {
    for (const id of this.sessions.keys()) this.dirty.add(id);
  }

  /**
   * 标记当前所有活跃会话为待重建（skill 目录增删 / skill 禁用后调用）。
   * 不立即重建——各会话在下次被 ensureStarted（切换/使用）且 idle 时各自重建一次。
   * 与 markAllDirty 区别：走重建而非 reload，因为 additionalSkillPaths 构造时固定。
   */
  markSkillsDirty(): void {
    for (const id of this.sessions.keys()) this.skillDirty.add(id);
  }

  /** 命中缓存时：若该会话被标脏，reload 一次并清脏（单会话失败不阻断）。 */
  private async _reloadIfDirty(sessionId: string, session: AgentSession): Promise<void> {
    if (!this.dirty.has(sessionId)) return;
    // 正在流式输出 / 有排队消息时跳过 reload，保留 dirty 等下次 idle 时再试，
    // 避免在生成过程中热替换工具/系统提示词。
    if (session.isStreaming || session.pendingMessageCount > 0) return;
    this.dirty.delete(sessionId);
    try {
      // SDK AgentSession.reload() 重读 settings.json（disabledSkills / extensions 等）
      await (session as any).reload();
    } catch (err) {
      console.error(`[kernel] session ${sessionId} deferred reload 失败:`, err);
    }
  }

  private async _createSession(
    projectId: string,
    agentName: AgentName,
    sessionId: string,
  ): Promise<AgentSession> {
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

    // 读 agent 配置（系统提示词 / 工具 / 模型 / thinking level）
    const config = this.opts.configStore
      ? await this.opts.configStore.getAgent(agentName)
      : null;

    // 动态 import SDK（避免类型循环依赖；只在真正需要创建 session 时加载）
    const sdk = await import("@earendil-works/pi-coding-agent");
    const createFn: CreateAgentSessionFn =
      this.opts.createAgentSessionFn ??
      (sdk.createAgentSession as CreateAgentSessionFn);

    // 共享 auth/model：实例级惰性单例（多次 ensureStarted 复用同一 AuthStorage / ModelRegistry）
    // AuthStorage 从 HIAGENT_DIR/auth.json 读凭证（SDK 默认读 ~/.pi/agent/auth.json，这里对齐 HiAgent 目录）
    const authStorage = ((this as any)._authStorage ??=
      sdk.AuthStorage.create(`${HIAGENT_DIR}/auth.json`));
    const modelRegistry = ((this as any)._modelRegistry ??=
      sdk.ModelRegistry.create(authStorage));

    // 解析启用 skill 的目录路径，喂给 SDK additionalSkillPaths。
    // 只含 userSkillDirs 来源的 skill（builtin 由 SDK includeDefaults 自动扫，重复传入会触发碰撞诊断）。
    // additionalSkillPaths 构造时固定，skill 配置变更后需重建会话才能刷新（见 _reloadIfDirty）。
    const additionalSkillPaths = await resolveEnabledSkillPaths(this.opts.skillManager);

    // AgentConfig → SDK ResourceLoader 选项映射
    // - systemPromptMode === "replace"：整体覆盖系统提示词
    // - systemPromptMode === "append"：在默认 agentsFiles 后追加虚拟文件
    const loader = new sdk.DefaultResourceLoader({
      cwd: project.cwd,
      agentDir: HIAGENT_DIR,
      // 扩展改用 additionalExtensionPaths 纯内存注入（见 extensions.ts）
      additionalExtensionPaths: buildAdditionalExtensionPaths(),
      additionalSkillPaths,
      // 默认 replace 模式：始终提供 customPrompt，绕过 SDK 默认提示词
      // （"operating inside pi" + "Pi documentation" 段，会把底层暴露给 agent）。
      // 显式 replace 配置优先用用户 body；其余（含无配置）一律用 hiagent 默认提示词。
      systemPromptOverride: () =>
        config?.systemPromptMode === "append" && config.systemPromptBody
          ? config.systemPromptBody!
          : HIAGENT_DEFAULT_SYSTEM_PROMPT,
      agentsFilesOverride:
        config?.systemPromptMode === "append" && config.systemPromptBody
          ? (current: {
              agentsFiles: Array<{ path: string; content: string }>;
            }) => ({
              agentsFiles: [
                ...current.agentsFiles,
                {
                  path: `/virtual/${config.name}.md`,
                  content: config.systemPromptBody!,
                },
              ],
            })
          : undefined,
    });
    await loader.reload();

    // 调 createAgentSession 创建 SDK session
    // 不再使用 agent config 里的默认模型：所有消息必须跟随用户显式选择的模型
    const { session } = await createFn({
      cwd: project.cwd,
      agentDir: HIAGENT_DIR,
      // SessionManager.open 打开已有 jsonl 文件（由 ProjectStore.createSession 预生成路径）
      sessionManager: sdk.SessionManager.open(sessionEntity.piSessionFile),
      resourceLoader: loader,
      thinkingLevel: config?.thinking ?? "medium",
      // 无显式 tools 时用默认工具集（含 Pi 内置 + pi-web-access 网络工具）
      tools: config?.tools?.length ? config.tools : DEFAULT_AGENT_TOOLS,
      authStorage,
      modelRegistry,
    });

    // 设置 pi-intercom 会话名（对齐原 RPC --name 参数，格式：projectId-agentName-sessionId）
    session.setSessionName(`${projectId}-${agentName}-${sessionId}`);

    // 订阅 SDK 事件并转发给上层 onEvent（携带路由上下文）
    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      this.opts.onEvent(sessionId, projectId, agentName, event);
    });

    // 如果创建过程中被 dispose，则清理刚创建的 session，避免泄漏回 Map
    if (this.disposed.has(sessionId)) {
      this.disposed.delete(sessionId);
      unsubscribe();
      session.dispose();
      throw new Error(`会话已清理: ${sessionId}`);
    }

    this.sessions.set(sessionId, session);
    this.unsubscribers.set(sessionId, unsubscribe);
    this.sessionCwd.set(sessionId, project.cwd);
    this.sessionMeta.set(sessionId, { projectId, agentName });

    return session;
  }

  /** 发送用户输入。agent 运行中或有排队消息时 followUp 排队；空闲时直接 prompt。 */
  async prompt(
    sessionId: string,
    text: string,
    opts?: {
      model?: string;
      thinking?: ThinkingLevel;
      attachments?: AttachmentRef[];
    },
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`会话未启动: ${sessionId}`);

    // 所有消息必须跟随用户显式选择的模型，禁止回退到 agent config 或 SDK 默认模型
    if (!opts?.model) {
      throw new Error("未选择模型，请先在模型选择器中选择一个模型");
    }

    // 按请求切换模型
    const modelRegistry = (session as any).modelRegistry;
    const model = await resolveModel(opts.model, modelRegistry);
    await session.setModel(model);

    // 按请求切换 thinking level：
    // - "disabled" 映射为 SDK 的 "off"
    // - "max" 映射为 "xhigh"：DeepSeek 的 thinkingLevelMap 把 xhigh → API "max"；
    //   SDK 内部 clampThinkingLevel 会在模型不支持 xhigh 时自动降级到 high
    // - "medium" / "high" 透传
    if (opts?.thinking) {
      const level =
        opts.thinking === "disabled" ? "off" :
        opts.thinking === "max" ? "xhigh" :
        opts.thinking;
      session.setThinkingLevel(level);
    }

    // 构建最终 prompt 文本：snippet 直接内联，文件/图片统一用 @相对路径 引用
    const cwd = this.sessionCwd.get(sessionId);
    const { text: finalText } = buildPromptContent(
      text,
      opts?.attachments ?? [],
      cwd,
    );

    if (session.isStreaming || session.pendingMessageCount > 0) {
      await session.prompt(finalText, { streamingBehavior: "followUp" });
    } else {
      await session.prompt(finalText);
    }
  }

  /**
   * 清空队列 + abort + 剩余重入队 + 发目标消息。
   * promoteToSteer 和 immediate 共享实现。
   * @param interrupt 为 true 时目标消息使用 streamingBehavior: "steer"，即使 abort 后
   *                  agent 仍在运行，也会以 steer 方式中断当前并立即处理，避免
   *                  "Agent is already processing" 报错。
   */
  private async _jumpQueue(sessionId: string, text: string, remainingTexts: string[], interrupt: boolean = false): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`会话未启动: ${sessionId}`);

    // 1. 中断当前运行（abort 返回 Promise，await 即等待 idle）
    await session.abort();

    // 2. 清空全部队列
    session.clearQueue();

    // 3. 剩余消息用 session.followUp() 入队（SDK API: followUp(text)）
    for (const rt of remainingTexts) {
      await session.followUp(rt);
    }

    // 4. 目标消息作为新回合开始
    if (interrupt) {
      // steer 模式在 streaming 时中断当前，在 idle 时等价于直接 prompt。
      // 若 abort 后 agent activeRun 仍存在（例如正在执行 tool calls），直接 prompt
      // 会在 agent 层抛 "already processing"，此时降级为 steer 排队，仍能尽快生效。
      try {
        await session.prompt(text, { streamingBehavior: "steer" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("already processing")) {
          await session.steer(text);
        } else {
          throw err;
        }
      }
    } else {
      await session.prompt(text);
    }
  }

  /**
   * 对 _jumpQueue 加 per-session 串行锁。
   * 连续点击"引导"/"立即"时，后一次操作必须等待前一次完成，避免并发 race。
   */
  private async _lockedJumpQueue(sessionId: string, text: string, remainingTexts: string[], interrupt: boolean): Promise<void> {
    const previous = this.jumpQueueLocks.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => { })
      .then(() => this._jumpQueue(sessionId, text, remainingTexts, interrupt));
    this.jumpQueueLocks.set(sessionId, next);
    await next;
  }

  /** 提升排队消息为引导（abort → 清空 → 剩余重入队 → 目标消息作为新回合） */
  async promoteToSteer(sessionId: string, text: string, remainingTexts: string[]): Promise<void> {
    await this._lockedJumpQueue(sessionId, text, remainingTexts, false);
  }

  /** 立即执行排队消息（abort → 清空 → 剩余重入队 → 目标消息作为新回合） */
  async immediate(sessionId: string, text: string, remainingTexts: string[]): Promise<void> {
    await this._lockedJumpQueue(sessionId, text, remainingTexts, true);
  }

  /** 清空 steer 引导队列（session 不存在时静默忽略） */
  clearSteeringQueue(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    // SDK 的 clearQueue() 返回 { steering, followUp }，我们只需要清 steering
    const queued = session.clearQueue();
    // 把 followUp 恢复回去
    for (const msg of queued.followUp) {
      session.followUp(msg).catch(() => {});
    }
  }

  /** 清空 followUp 排队队列（session 不存在时静默忽略） */
  clearFollowUpQueue(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    // SDK 的 clearQueue() 返回 { steering, followUp }，我们只需要清 followUp
    const queued = session.clearQueue();
    // 把 steering 恢复回去
    for (const msg of queued.steering) {
      session.steer(msg).catch(() => {});
    }
  }

  /** 发送引导消息入队（不打断当前 agent，等待下回合生效） */
  steerMessage(sessionId: string, text: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.steer(text).catch(() => {});
  }

  /** 清空全部队列（steering + followUp） — session 不存在时静默忽略 */
  clearAllQueues(sessionId: string): void {
    this.sessions.get(sessionId)?.clearQueue();
  }

  /** 中止当前会话的进行中请求（无 session 时静默忽略，便于幂等清理） */
  async abort(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) await session.abort();
  }

  /** 读取会话历史消息（session 不存在时返回空数组） */
  getMessages(sessionId: string): any[] {
    return this.sessions.get(sessionId)?.messages ?? [];
  }

  /** 拆除单个会话的内部资源（unsubscribe + dispose + 清各 Map），不动 disposed 标记。
   *  disposeSession（用户删除）与 _reloadIfDirty 重建共用。重建不能动 disposed，
   *  否则 _createSession 末尾的 disposed 检查会把新 session 当「创建中被清理」丢弃。 */
  private _teardownSession(sessionId: string): void {
    this.unsubscribers.get(sessionId)?.();
    this.unsubscribers.delete(sessionId);
    this.sessions.get(sessionId)?.dispose();
    this.sessions.delete(sessionId);
    this.sessionCwd.delete(sessionId);
    this.sessionMeta.delete(sessionId);
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
}

/**
 * 把 AgentConfig.model 字符串（如 "anthropic/claude-sonnet-4-5"）解析成 SDK Model 对象。
 *
 * SDK 的 resolveCliModel 没有从包根 export，只能从深层模块动态 import。
 * 这里用 import.meta.resolve 拿到 SDK 根路径，再推导出 model-resolver.js 的绝对路径。
 * 该路径在 SDK 0.80.x 验证有效；如果未来 SDK 改了内部结构，这里会抛 import 错误（fail-fast）。
 */
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

async function resolveModel(
  modelPattern: string,
  modelRegistry: any,
): Promise<any | undefined> {
  // 从 SDK 根入口推导 model-resolver 模块路径。
  // 必须直接对 import.meta.resolve 返回的 file:// URL 做字符串替换后再 import；
  // 不能用 new URL(url).pathname —— 在 Windows 上它会把 "file:///H:/..." 转成
  // "/H:/..."（带前导斜杠），导致 Bun 动态 import 报 "Cannot find module"。
  // （POSIX 绝对路径本就以 / 开头，所以该写法历史上在 macOS/Linux 上恰好可用。）
  const rootUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
  const resolverUrl = rootUrl.replace(
    "/dist/index.js",
    "/dist/core/model-resolver.js",
  );
  const { resolveCliModel } = await import(resolverUrl);
  const result = resolveCliModel({
    cliModel: modelPattern,
    modelRegistry,
  });
  if (result.error) {
    throw new Error(`模型解析失败 (${modelPattern}): ${result.error}`);
  }
  return result.model;
}

/**
 * 解析启用 skill 的目录路径列表，供 SDK additionalSkillPaths 使用。
 * 只含来自 userSkillDirs 的 skill（scan().dirs 中除 builtinDir 外的目录），builtin 留给 SDK 自动扫。
 * skillManager 为空（测试场景）时返回空数组。
 */
async function resolveEnabledSkillPaths(
  skillManager: SkillManager | undefined,
): Promise<string[]> {
  if (!skillManager) return [];
  const { skills, dirs, builtinDir } = await skillManager.scan();
  const userDirs = dirs.filter((d) => d !== builtinDir);
  return skills
    .filter((s) => userDirs.some((d) => isUnderPath(s.path, d)))
    .map((s) => s.path);
}

/** 判断 child 是否在 parent 目录下（含相等）。跨平台用 relative 判定，避免盘符/大小写/分隔符差异。 */
function isUnderPath(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
