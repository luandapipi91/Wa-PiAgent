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

import type { AgentName, AgentConfig, AttachmentRef, ModelProvider } from "@hiagent/shared";
import { HIAGENT_DIR } from "@hiagent/shared";
import type { ProjectStore } from "./project-store";
import type { ConfigStore } from "./config-store";
import type { ProviderStore } from "./provider-store";
import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";

// SDK ImageContent 的最小镜像，避免依赖 @earendil-works/pi-ai 根 export
interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

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

    // 调 createAgentSession 创建 SDK session
    // 不再使用 agent config 里的默认模型：所有消息必须跟随用户显式选择的模型
    const { session } = await createFn({
      cwd: project.cwd,
      agentDir: HIAGENT_DIR,
      // SessionManager.open 打开已有 jsonl 文件（由 ProjectStore.createSession 预生成路径）
      sessionManager: sdk.SessionManager.open(sessionEntity.piSessionFile),
      resourceLoader: loader,
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
  async prompt(
    sessionId: string,
    text: string,
    opts?: {
      model?: string;
      thinking?: "disabled" | "high";
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

    // 按请求切换 thinking level："disabled" 映射为 SDK 的 "off"
    if (opts?.thinking) {
      const level = opts.thinking === "disabled" ? "off" : opts.thinking;
      session.setThinkingLevel(level);
    }

    // 构建最终 prompt 文本与图片附件
    // 根据当前模型是否支持 vision 决定是否直接发送图片；不支持时降级为文本引用
    const providers = this.opts.providerStore ? await this.opts.providerStore.load() : [];
    // 用 resolveModel 后的真实 model id 去匹配 provider 配置（opts.model 可能是 provider/id 格式）
    const modelId = model.id as string;
    const { text: finalText, images } = await buildPromptContent(
      text,
      opts?.attachments ?? [],
      modelId,
      providers,
    );

    if (session.isStreaming || session.pendingMessageCount > 0) {
      await session.prompt(finalText, images.length
        ? { images, streamingBehavior: "followUp" }
        : { streamingBehavior: "followUp" });
    } else if (images.length) {
      await session.prompt(finalText, { images });
    } else {
      await session.prompt(finalText);
    }
  }

  /** 
   * 清空队列 + abort + 剩余重入队 + 发目标消息。
   * promoteToSteer 和 immediate 共享实现。
   */
  private async _jumpQueue(sessionId: string, text: string, remainingTexts: string[]): Promise<void> {
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

  /** reload 所有活跃会话（技能/provider 配置变更后调用，让新配置热生效） */
  async reloadAllSessions(): Promise<void> {
    for (const [id, session] of [...this.sessions.entries()]) {
      try {
        // SDK AgentSession.reload() 热重载 skills/extensions/prompts
        await (session as any).reload();
      } catch (err) {
        console.error(`[kernel] session ${id} reload 失败:`, err);
        // 单个失败不阻断其他会话
      }
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
/** 构建 prompt 最终文本与图片内容列表。 */
interface PromptContent {
  text: string;
  images: ImageContent[];
}

async function buildPromptContent(
  text: string,
  attachments: AttachmentRef[],
  modelId: string | undefined,
  providers: ModelProvider[],
): Promise<PromptContent> {
  const textParts: string[] = [];
  const images: ImageContent[] = [];
  for (const a of attachments) {
    if (a.kind === "snippet") {
      textParts.push(`[片段: ${a.name}]\n${a.content}`);
    } else {
      textParts.push(`[附件: ${a.name}]`);
      if (a.kind === "image") {
        const supportsVision = modelId ? shouldSendAsImage(modelId, providers) : false;
        if (!supportsVision) {
          textParts.push(`<附件图片（模型不支持）: ${a.path}>`);
          continue;
        }
        const data = await readFile(a.path, "base64");
        images.push({
          type: "image",
          data,
          mimeType: inferImageMimeType(a.path),
        });
      } else if (a.kind === "file") {
        const content = await readFile(a.path, "utf8");
        textParts.push(content);
      }
    }
  }
  textParts.push(text);
  return { text: textParts.join("\n\n"), images };
}

/** 判断指定模型是否支持图片输入。 */
export function shouldSendAsImage(modelId: string, providers: ModelProvider[]): boolean {
  return providers.some(p => p.models.some(m => m.id === modelId && m.supportsVision));
}

/** 根据文件扩展名推断图片 MIME 类型。 */
function inferImageMimeType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".bmp")) return "image/bmp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return "image/png";
}

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
