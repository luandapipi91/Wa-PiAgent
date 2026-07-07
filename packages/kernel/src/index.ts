import { ConfigStore } from "./config-store";
import { ProjectStore } from "./project-store";
import { AgentManager } from "./agent-manager";
import { StateAggregator } from "./state-aggregator";
import { WSServer } from "./ws-server";
import { migrateLegacySessions } from "./migrate";
import { WS_PORT } from "@hiagent/shared";

async function main() {
  const configStore = new ConfigStore();
  const projectStore = new ProjectStore();

  const migrated = await migrateLegacySessions(projectStore);
  if (migrated) console.log("[kernel] 已迁移老数据至默认项目");

  let broadcast: (e: import("@hiagent/shared").WSServerEvent) => void = () => {};

  const agentManager = new AgentManager({
    projectStore,
    configStore,
    onEvent: () => {},
  });
  const stateAggregator = new StateAggregator({
    agentManager,
    onServerEvent: (e) => broadcast(e),
  });
  (agentManager as unknown as { opts: { onEvent: (k: never, e: never) => void } }).opts.onEvent =
    (key, e) => stateAggregator.routePiEvent(key as never, e as never);

  const server = new WSServer({
    configStore, projectStore,
    agentManager, stateAggregator,
    port: WS_PORT,
  });
  await server.start();
  broadcast = (e) => (server as unknown as { broadcast: (e2: import("@hiagent/shared").WSServerEvent) => void }).broadcast(e);
  server.bindAggregatorBroadcast();

  console.log(`[kernel] WS 监听 ws://127.0.0.1:${server.actualPort}`);
}

main().catch(e => { console.error(e); process.exit(1); });
