import { ConfigStore } from "./config-store";
import { ProjectStore } from "./project-store";
import { ProviderStore } from "./provider-store";
import { AgentManager } from "./agent-manager";
import { WSServer } from "./ws-server";
import { SkillManager } from "./skill-manager";
import { ExtensionManager } from "./extension-manager";
import { migrateLegacySessions } from "./migrate";
import { ensureProviderExtensionRegistered } from "./provider-extension";
import { migrateSettingsPackages } from "./extensions";
import { extractSdkErrorMessage } from "./sdk-errors";
import { WS_PORT, HIAGENT_DIR, BUILTIN_SKILLS_DIR } from "@hiagent/shared";
import { mkdir } from "node:fs/promises";
import type { WSServerEvent } from "@hiagent/shared";

async function main() {
  // 让 Pi SDK 的全局 getAgentDir() 返回 ~/.hiagent，而非默认 ~/.pi/agent。
  // SDK 大量组件（auth/settings/sessions/bin/intercom/npm/models/prompts/tools/themes
  // 及 pi-intercom / pi-web-access 等扩展）直接调 config.getAgentDir()，该函数只读
  // PI_CODING_AGENT_DIR 环境变量、忽略传入的 agentDir 参数；不设则全部 fallback 到 ~/.pi/agent，
  // 与 hiagent 数据目录割裂（agentDir 参数只对 DefaultResourceLoader/SettingsManager 等少数入口生效）。
  // 必须在任意 SDK 代码 import/执行前设置。同时顺带解决 pi-web-access 配置透传（见 memory）。
  process.env.PI_CODING_AGENT_DIR = HIAGENT_DIR;

  // 一次性迁移：清空旧版本写入 settings.json.packages 的扩展路径，
  // 避免「packages 残留 + additionalExtensionPaths」双重加载同一扩展（见 extensions.ts）
  await migrateSettingsPackages();

  // 确保内置技能目录存在
  await mkdir(BUILTIN_SKILLS_DIR, { recursive: true });
  // 确保 sessions 目录存在（Pi SDK SessionManager.open 需要）
  await mkdir(`${HIAGENT_DIR}/sessions`, { recursive: true });

  const configStore = new ConfigStore();
  const projectStore = new ProjectStore();
  const providerStore = new ProviderStore();
  const skillManager = new SkillManager(HIAGENT_DIR);
  const extensionManager = new ExtensionManager(HIAGENT_DIR);

  // 启动时把已有 providers 注册成 Pi extension（幂等）
  await ensureProviderExtensionRegistered(providerStore);

  const migrated = await migrateLegacySessions(projectStore);
  if (migrated) console.log("[kernel] 已迁移老数据至默认项目");

  // 用占位 agentManager 先建 server（解决循环依赖：onEvent 要用 server.broadcast）
  // broadcast 在 ws-server.ts 已改为 public，AgentManager.onEvent 可直接调
  let broadcast: (e: WSServerEvent) => void = () => {};
  const server = new WSServer({
    configStore, projectStore,
    providerStore,
    skillManager,
    extensionManager,
    dataDir: HIAGENT_DIR,
    agentManager: null as any,  // 占位，下面赋值
    port: WS_PORT,
  });
  broadcast = (e) => server.broadcast(e);

  // AgentManager.onEvent 直接广播 sdk:event
  // SDK AgentSessionEvent 与 shared SDKEvent 结构兼容但 TS 判为不同类型，event 用 any 桥接
  const agentManager = new AgentManager({
    projectStore,
    configStore,
    providerStore,
    onEvent: (sessionId, projectId, agentName, event) => {
      console.log(`[kernel] sdk event: ${(event as any).type}`);
      broadcast({ type: "sdk:event", projectId, sessionId, agentName, event: event as any });
      // SDK 运行时错误（不可用模型 / 鉴权失败 / 网络等）不抛异常，而是编码进
      // message_end{stopReason:"error", errorMessage}。ws-server 的 try/catch 抓不到，
      // 前端又不读这些字段 → 静默。这里翻译成 {type:"error"}，复用前端红色 ⚠️ 渲染管线。
      const errMsg = extractSdkErrorMessage(event as any);
      if (errMsg) {
        broadcast({ type: "error", message: errMsg, agentName, sessionId });
      }
    },
  });
  // 回填真实 agentManager（绕开 TS 的「构造时已确定」语义；opts 为 private 故用 any 桥接）
  (server as any).opts.agentManager = agentManager;

  // 首启播种可选插件（默认启用 pi-lens）；后续由面板 toggle
  await extensionManager.list();

  await server.start();
  console.log(`[kernel] WS 监听 ws://127.0.0.1:${server.actualPort}`);
}

main().catch(e => { console.error(e); process.exit(1); });
