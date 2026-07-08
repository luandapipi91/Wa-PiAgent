import { ConfigStore } from "./config-store";
import { ProjectStore } from "./project-store";
import { AgentManager } from "./agent-manager";
import { WSServer } from "./ws-server";
import { migrateLegacySessions } from "./migrate";
import { ensureIntercomInstalled } from "./intercom-setup";
import { WS_PORT } from "@hiagent/shared";
import type { WSServerEvent } from "@hiagent/shared";

async function main() {
  // 首次启动：确保 pi-intercom 扩展已配置到 ~/.hiagent/settings.json
  // （幂等，已配置则直接返回；Pi SDK 首次加载时据此自动拉取安装）
  await ensureIntercomInstalled();

  const configStore = new ConfigStore();
  const projectStore = new ProjectStore();

  const migrated = await migrateLegacySessions(projectStore);
  if (migrated) console.log("[kernel] 已迁移老数据至默认项目");

  // 用占位 agentManager 先建 server（解决循环依赖：onEvent 要用 server.broadcast）
  // broadcast 在 ws-server.ts 已改为 public，AgentManager.onEvent 可直接调
  let broadcast: (e: WSServerEvent) => void = () => {};
  const server = new WSServer({
    configStore, projectStore,
    agentManager: null as any,  // 占位，下面赋值
    port: WS_PORT,
  });
  broadcast = (e) => server.broadcast(e);

  // AgentManager.onEvent 直接广播 sdk:event
  // SDK AgentSessionEvent 与 shared SDKEvent 结构兼容但 TS 判为不同类型，event 用 any 桥接
  const agentManager = new AgentManager({
    projectStore,
    configStore,
    onEvent: (sessionId, projectId, agentName, event) => {
      console.log(`[kernel] sdk event: ${(event as any).type}`);
      broadcast({ type: "sdk:event", projectId, sessionId, agentName, event: event as any });
    },
  });
  // 回填真实 agentManager（绕开 TS 的「构造时已确定」语义；opts 为 private 故用 any 桥接）
  (server as any).opts.agentManager = agentManager;

  await server.start();
  console.log(`[kernel] WS 监听 ws://127.0.0.1:${server.actualPort}`);
}

main().catch(e => { console.error(e); process.exit(1); });
