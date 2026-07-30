import { ConfigStore } from "./config-store";
import { ProjectStore } from "./project-store";
import { ProviderStore } from "./provider-store";
import { AgentManager } from "./agent-manager";
import { WSServer } from "./ws-server";
import { SkillManager } from "./skill-manager";
import { ExtensionManager } from "./extension-manager";
import { MemoryStore } from "./memory-store";
import { McpStore } from "./mcp-store";
import { migrateLegacySessions } from "./migrate";
import { ensureProviderExtensionRegistered } from "./provider-extension";
import { ensureBridgeExtension } from "./bridge-extension";
import { ensureSystemProject } from "./ensure-system-project";
import { cleanupExpiredWorkdirs } from "./workdir-cleaner";
import { ensurePromptsConfig } from "./system-prompt";
import { ensureSubagentOverrides } from "./subagent-store";
import { classifySdkError } from "./sdk-errors";
import { SdkEventThrottle } from "./event-throttle";
import { cleanupRecordingTemp } from "./recording-store";
import { WS_PORT, WA_PI_DIR, BUILTIN_SKILLS_DIR, SYSTEM_PROJECT_CWD, PROMPTS_FILE, SUBAGENT_OVERRIDES_FILE } from "@wa-pi/shared";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WSServerEvent } from "@wa-pi/shared";

/** 启动时写入 web-search.json，确保 web_search 工具不弹 curator */
async function ensureWebSearchConfig(waPiDir: string): Promise<void> {
  const configPath = join(waPiDir, "web-search.json");
  const config = { provider: "auto", workflow: "auto-summary" };
  try {
    await mkdir(waPiDir, { recursive: true });
    await writeFile(configPath, JSON.stringify(config) + "\n", "utf8");
  } catch { /* 静默忽略 */ }
}

export async function startKernel(
  opts?: { staticDir?: string; port?: number }
): Promise<{ port: number; stop: () => Promise<void> }> {
  // 让 pi 生态（pi-mcp-adapter 的 mcp-auth 等深导入模块）在本进程内解析到
  // ~/.wa-pi 作为 agent 目录；RPC 模式下 pi 子进程的环境变量由
  // AgentManager 在 spawn 时逐个注入（PI_CODING_AGENT_DIR=WA_PI_DIR），
  // 这里保留进程级设置供 kernel 内部的 pi 扩展包代码使用。
  process.env.PI_CODING_AGENT_DIR = WA_PI_DIR;

  // 确保内置技能目录存在
  await mkdir(BUILTIN_SKILLS_DIR, { recursive: true });
  // 确保 sessions 目录存在（Pi SDK SessionManager.open 需要）
  await mkdir(`${WA_PI_DIR}/sessions`, { recursive: true });

  const configStore = new ConfigStore();
  const projectStore = new ProjectStore();
  const providerStore = new ProviderStore();
  const skillManager = new SkillManager(WA_PI_DIR);
  const extensionManager = new ExtensionManager(WA_PI_DIR);
  const memoryStore = new MemoryStore({ waPiDir: WA_PI_DIR, projectStore });
  const mcpStore = new McpStore({ waPiDir: WA_PI_DIR, projectStore });

  // 启动时把已有 providers 注册成 Pi extension（幂等）
  await ensureProviderExtensionRegistered(providerStore);

  // 启动时生成 bridge 扩展（幂等）：RPC 模式下 pi 子进程经它注册宿主工具并回调 /bridge/tool
  await ensureBridgeExtension();

  // 迁移旧版 agent 数据（含 name 字段、文件名用内部 name）到 displayName 作 id（幂等）
  const nameMapping = await configStore.migrateNameToDisplayName();
  if (nameMapping.size > 0) {
    const { sessions } = await projectStore.load();
    for (const s of sessions) {
      const newName = nameMapping.get(s.primaryAgent);
      if (newName) await projectStore.setSessionAgent(s.id, newName);
    }
    console.log(`[kernel] 已迁移 ${nameMapping.size} 个智能体 name → displayName`);
  }

  // 逐角色检查、缺失才写入的幂等 seed（存量环境自动补齐新角色，不覆盖已有同名文件）
  await configStore.seedDefaults();

  const migrated = await migrateLegacySessions(projectStore);
  if (migrated) console.log("[kernel] 已迁移老数据至默认项目");

  // 启动时 seed 默认工作区虚拟项目（幂等）+ 确保 workdir 根目录存在
  await ensureSystemProject(projectStore);
  console.log(`[kernel] 默认工作区已就绪: ${SYSTEM_PROJECT_CWD}`);

  await ensureWebSearchConfig(WA_PI_DIR);

  // 启动时确保 prompts.json 配置存在（幂等），用户可手动编辑调整段落顺序/内容
  await ensurePromptsConfig(PROMPTS_FILE);

  // 启动时确保 subagent-overrides.json 存在（幂等初始化空配置）
  await ensureSubagentOverrides(SUBAGENT_OVERRIDES_FILE);

  // 启动时清理过期 workdir 子目录（默认工作区会话被删后保留 7 天）
  try {
    const cleaned = await cleanupExpiredWorkdirs(projectStore);
    if (cleaned > 0) console.log(`[kernel] 已清理 ${cleaned} 个过期 workdir 子目录`);
  } catch (e) {
    console.warn("[kernel] workdir 清理失败:", e);
  }
  // 每天定时清理一次
  const DAY_MS = 24 * 60 * 60 * 1000;
  setInterval(() => {
    cleanupExpiredWorkdirs(projectStore).catch(e => {
      console.warn("[kernel] workdir 定时清理失败:", e);
    });
  }, DAY_MS);

  // 启动清理：上次崩溃/异常退出遗留的录音临时分片
  try {
    const { projects } = await projectStore.load();
    await Promise.allSettled(projects.map(p => p.cwd ? cleanupRecordingTemp(join(p.cwd, ".wa-pi", "uploads")) : Promise.resolve()));
  } catch (e) {
    console.warn("[kernel] 清理录音临时文件失败:", e);
  }

  // 用占位 agentManager 先建 server（解决循环依赖：onEvent 要用 server.broadcast）
  // broadcast 在 ws-server.ts 已改为 public，AgentManager.onEvent 可直接调
  let broadcast: (e: WSServerEvent) => void = () => {};
  const server = new WSServer({
    configStore, projectStore,
    providerStore,
    skillManager,
    extensionManager,
    memoryStore,
    mcpStore,
    dataDir: WA_PI_DIR,
    agentManager: null as any,  // 占位，下面赋值
    port: opts?.port ?? WS_PORT,
    ...(opts?.staticDir ? { staticDir: opts.staticDir } : {}),
  });
  broadcast = (e) => server.broadcast(e);

  // AgentManager.onEvent 直接广播 sdk:event
  // pi RPC 事件与 shared SDKEvent 结构兼容但 TS 判为不同类型，event 用 any 桥接
  // message_update 经 SdkEventThrottle 节流合并（每 token 全量 partial 的 O(n²) 卡顿修复），
  // 其余事件类型原样透传、顺序不变。
  const eventThrottle = new SdkEventThrottle((e) => broadcast(e));
  const agentManager = new AgentManager({
    projectStore,
    configStore,
    providerStore,
    skillManager,
    extensionManager,
    memoryStore,
    mcpStore,
    // bridge 回调地址惰性取值：WS 端口在 server.start() 后才确定（AgentManager 构造在前）
    bridgeBaseUrl: () => `http://127.0.0.1:${server.actualPort}`,
    onEvent: (sessionId, projectId, agentName, event) => {
      eventThrottle.handle({ type: "sdk:event", projectId, sessionId, agentName, event: event as any });
      // pi 运行时错误（不可用模型 / 鉴权失败 / 网络等）不抛异常，而是编码进
      // message_end{stopReason:"error", errorMessage}。ws-server 的 try/catch 抓不到，
      // 前端又不读这些字段 → 静默。这里按错误分类翻译广播：
      //   - transient（网络/超时/限流）→ {type:"net:status"} 状态条提示，不进对话流
      //   - fatal（鉴权/配额/模型不可用）→ {type:"error"} 红色会话消息
      const classified = classifySdkError(event as any);
      if (classified) {
        if (classified.category === "transient") {
          broadcast({ type: "net:status", status: "degraded", message: classified.message, agentName, sessionId });
          // 标记 transient：agent_settled 时跳过 followUp/steer drain，
          // 避免网络不可用时自动发送排队消息再次失败；队列保留等用户重发。
          agentManager.markNetDegraded(sessionId, true);
        } else {
          broadcast({ type: "error", message: classified.message, agentName, sessionId });
        }
      }
      // agent 回复完成时更新 lastActivity，让会话列表的时间反映最新活动（而非仅用户发送时间）
      if ((event as any).type === "message_end") {
        projectStore.touchSession(sessionId).catch(() => {});
      }
    },
    // 孤儿会话回滚：删除记录后刷新前端会话列表（projects:list）
    onSessionRollback: () => {
      projectStore.load().then((data) =>
        broadcast({ type: "projects:list", projects: data.projects, sessions: data.sessions }),
      ).catch(() => {});
    },
  });
  // 回填真实 agentManager（绕开 TS 的「构造时已确定」语义；opts 为 private 故用 any 桥接）
  (server as any).opts.agentManager = agentManager;

  await server.start();
  console.log(`[kernel] HTTP 监听 http://127.0.0.1:${server.actualPort}`);

  // 优雅退出：RPC 架构下每个会话是一个 pi 子进程，kernel 退出时必须统一回收，
  // 避免孤儿进程滞留（SIGINT/SIGTERM 先 disposeAll 再停 server）。
  // 注意：pi 子进程在 stdin 关闭后也会自行退出（EOF 兜底），这里是主动加速回收。
  const shutdown = async (signal: string) => {
    console.log(`[kernel] ${signal} 收到，回收 pi 子进程并停止服务...`);
    eventThrottle.dispose();
    await agentManager.disposeAll().catch(() => {});
    await server.stop().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  return { port: server.actualPort, stop: () => server.stop() };
}

if (import.meta.main) {
  startKernel().catch(e => { console.error(e); process.exit(1); });
}
