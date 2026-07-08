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

import type { AgentName, AgentConfig } from "@hiagent/shared";
import { HIAGENT_DIR } from "@hiagent/shared";
import type { ProjectStore } from "./project-store";
import type { ConfigStore } from "./config-store";
import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";

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
  // 上层事件回调：携带 sessionId/projectId/agentName 上下文，转发 SDK 原始事件
  onEvent: (
    sessionId: string,
    projectId: string,
    agentName: AgentName,
    e: AgentSessionEvent,
  ) => void;
  // 测试注入 mock；生产留空 → 走真实 SDK 动态 import
  createAgentSessionFn?: CreateAgentSessionFn;
}

export class AgentManager {
  // sessionId → AgentSession（核心数据结构，一个 HiAgent 会话对应一个 SDK session）
  private sessions = new Map<string, AgentSession>();
  // sessionId → unsubscribe 函数（dispose 时解绑事件订阅）
  private unsubscribers = new Map<string, () => void>();

  constructor(private opts: AgentManagerOpts) {}

  /**
   * 启动或复用一个 AgentSession。
   * 同 sessionId 命中 Map 缓存则直接返回；否则创建新 session、设置 intercom 会话名、订阅事件。
   */
  async ensureStarted(
    projectId: string,
    agentName: AgentName,
    sessionId: string,
  ): Promise<AgentSession> {
    // 命中缓存直接返回（同 session 复用，不重复创建 SDK session）
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

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

    // AgentConfig → SDK ResourceLoader 选项映射
    // - systemPromptMode === "replace"：整体覆盖系统提示词
    // - systemPromptMode === "append"：在默认 agentsFiles 后追加虚拟文件
    const loader = new sdk.DefaultResourceLoader({
      cwd: project.cwd,
      agentDir: HIAGENT_DIR,
      systemPromptOverride:
        config?.systemPromptMode === "replace" && config.systemPromptBody
          ? () => config.systemPromptBody!
          : undefined,
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

    // 解析 config.model 字符串 → SDK Model 对象
    // resolveCliModel 未从 SDK 根 export，需要从深层模块动态 import
    const model = config?.model
      ? await resolveModel(config.model, modelRegistry)
      : undefined;

    // 调 createAgentSession 创建 SDK session
    const { session } = await createFn({
      cwd: project.cwd,
      agentDir: HIAGENT_DIR,
      // SessionManager.open 打开已有 jsonl 文件（由 ProjectStore.createSession 预生成路径）
      sessionManager: sdk.SessionManager.open(sessionEntity.piSessionFile),
      resourceLoader: loader,
      model,
      thinkingLevel: config?.thinking ?? "medium",
      // 无显式 tools 时用默认四件套（read/bash/edit/write）
      tools: config?.tools?.length
        ? config.tools
        : ["read", "bash", "edit", "write"],
      authStorage,
      modelRegistry,
    });

    // 设置 pi-intercom 会话名（对齐原 RPC --name 参数，格式：projectId-agentName-sessionId）
    session.setSessionName(`${projectId}-${agentName}-${sessionId}`);

    // 订阅 SDK 事件并转发给上层 onEvent（携带路由上下文）
    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      this.opts.onEvent(sessionId, projectId, agentName, event);
    });
    this.sessions.set(sessionId, session);
    this.unsubscribers.set(sessionId, unsubscribe);

    return session;
  }

  /** 发送用户输入。agent 运行中或有排队消息时 followUp 排队；空闲时直接 prompt。 */
  async prompt(sessionId: string, text: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`会话未启动: ${sessionId}`);
    if (session.state.isStreaming || session.hasQueuedMessages()) {
      await session.prompt(text, { streamingBehavior: "followUp" });
    } else {
      await session.prompt(text);
    }
  }

  /** 
   * 清空队列 + abort + 剩余重入队 + 发目标消息。
   * promoteToSteer 和 immediate 共享实现。
   */
  private async _jumpQueue(sessionId: string, text: string, remainingTexts: string[]): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`会话未启动: ${sessionId}`);

    // 1. 中断当前运行
    session.abort();
    await session.waitForIdle();

    // 2. 清空全部队列
    session.clearAllQueues();

    // 3. 剩余消息用 session.followUp() 入队（避免触发新 prompt）
    //    直接用 session.followUp 而非 session.prompt，因为 abort 后 agent idle，
    //    session.prompt(rt, {streamingBehavior:"followUp"}) 会启动新回合而非排队
    for (const rt of remainingTexts) {
      session.followUp({ role: "user", content: rt, timestamp: Date.now() });
    }

    // 4. 目标消息作为新回合开始
    await session.prompt(text);
  }

  /** 提升排队消息为引导（abort → 清空 → 剩余重入队 → 目标消息作为新回合） */
  async promoteToSteer(sessionId: string, text: string, remainingTexts: string[]): Promise<void> {
    await this._jumpQueue(sessionId, text, remainingTexts);
  }

  /** 立即执行排队消息（abort → 清空 → 剩余重入队 → 目标消息作为新回合） */
  async immediate(sessionId: string, text: string, remainingTexts: string[]): Promise<void> {
    await this._jumpQueue(sessionId, text, remainingTexts);
  }

  /** 清空 steer 引导队列（session 不存在时静默忽略） */
  clearSteeringQueue(sessionId: string): void {
    this.sessions.get(sessionId)?.clearSteeringQueue();
  }

  /** 清空 followUp 排队队列（session 不存在时静默忽略） */
  clearFollowUpQueue(sessionId: string): void {
    this.sessions.get(sessionId)?.clearFollowUpQueue();
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

  /** 清理单个会话：先解绑事件订阅，再 dispose session，最后从 Map 移除 */
  async disposeSession(sessionId: string): Promise<void> {
    this.unsubscribers.get(sessionId)?.();
    this.unsubscribers.delete(sessionId);
    this.sessions.get(sessionId)?.dispose();
    this.sessions.delete(sessionId);
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
async function resolveModel(
  modelPattern: string,
  modelRegistry: any,
): Promise<any | undefined> {
  // 从 SDK 根入口路径推导 model-resolver 模块路径
  const rootUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
  const rootPath = new URL(rootUrl).pathname;
  const resolverPath = rootPath.replace(
    "/dist/index.js",
    "/dist/core/model-resolver.js",
  );
  const { resolveCliModel } = await import(resolverPath);
  const result = resolveCliModel({
    cliModel: modelPattern,
    modelRegistry,
  });
  if (result.error) {
    throw new Error(`模型解析失败 (${modelPattern}): ${result.error}`);
  }
  return result.model;
}
