import { ConfigStore } from "./config-store";
import { ProjectStore } from "./project-store";
import { SessionStore } from "./session-store";
import { AgentManager } from "./agent-manager";
import { IntercomMonitor } from "./intercom-monitor";
import { StateAggregator } from "./state-aggregator";
import { WSServer } from "./ws-server";
import { migrateLegacySessions } from "./migrate";
import { WS_PORT } from "@hiagent/shared";

async function main() {
  const configStore = new ConfigStore();
  const projectStore = new ProjectStore();
  const sessionStore = new SessionStore();

  // 老数据迁移：server.start() 前完成，确保首条 projects:list 已含迁移后的项目
  const migrated = await migrateLegacySessions(projectStore);
  if (migrated) console.log("[kernel] 已迁移老数据至默认项目");

  // 先建一个占位 broadcast，待 WSServer 实例化后绑定真实实现
  let broadcast: (e: import("@hiagent/shared").WSServerEvent) => void = () => {};

  // StateAggregator：Pi 事件 → WS 事件，输出到 broadcast
  const agentManager = new AgentManager({
    projectStore,
    configStore,
    onEvent: () => {},
  });
  const stateAggregator = new StateAggregator({
    sessionStore,
    agentManager,
    onServerEvent: (e) => broadcast(e),
  });
  // 用真实闭包重写 AgentManager.onEvent（opts 是 private，经 unknown 转）
  (agentManager as unknown as { opts: { onEvent: (k: never, e: never) => void } }).opts.onEvent =
    (key, e) => stateAggregator.routePiEvent(key as never, e as never);

  const intercomMonitor = new IntercomMonitor({
    onAsk: (a) => stateAggregator.routeAsk(a),
    onReply: (id, sid) => stateAggregator.routeReply(id, sid),
  });
  await intercomMonitor.connect();

  const server = new WSServer({
    configStore, projectStore, sessionStore,
    agentManager, intercomMonitor, stateAggregator,
    port: WS_PORT,
  });
  await server.start();
  // 绑定真实广播（WSServer.broadcast 通过 clients 集群分发）
  broadcast = (e) => (server as unknown as { broadcast: (e2: import("@hiagent/shared").WSServerEvent) => void }).broadcast(e);
  server.bindAggregatorBroadcast();

  console.log(`[kernel] WS 监听 ws://127.0.0.1:${server.actualPort}`);
}

main().catch(e => { console.error(e); process.exit(1); });
