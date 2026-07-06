import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "./config-store";
import { AgentManager } from "./agent-manager";
import { IntercomMonitor } from "./intercom-monitor";
import { StateAggregator } from "./state-aggregator";
import { WSServer } from "./ws-server";

async function main() {
  const agentsDir = process.env.HIAGENT_AGENTS_DIR ?? join(homedir(), ".pi/agent/agents");
  const cwd = process.env.HIAGENT_CWD ?? process.cwd();
  const port = 9776;
  console.log(`[HiAgent kernel] agentsDir=${agentsDir} cwd=${cwd} port=${port}`);

  const configStore = new ConfigStore(agentsDir);
  const agentManager = new AgentManager(configStore, cwd);
  const intercomMonitor = new IntercomMonitor();
  const aggregator = new StateAggregator(agentManager, intercomMonitor);
  const wsServer = new WSServer(port, aggregator);

  aggregator.start();
  await wsServer.start();
  await intercomMonitor.connect().catch(() => console.log("[kernel] broker not ready, will retry"));

  wsServer.onClientMessage(async (msg) => {
    try {
      switch (msg.type) {
        case "agents:list":
          aggregator.emit("ws:event", { type: "agents:list", agents: await agentManager.listAvailableAgents() });
          break;
        case "agent:prompt":
          await intercomMonitor.connect().catch(() => {});
          await (await agentManager.ensureStarted(msg.agentName)).prompt(msg.message);
          break;
        case "agent:abort":
          agentManager.get(msg.agentName)?.abort();
          break;
        case "intercom:inject-reply":
          await intercomMonitor.injectReply(msg.messageId, msg.agentName, msg.toAskFrom, msg.text);
          break;
      }
    } catch (e: any) { console.error("[kernel] cmd error:", e.message); }
  });

  console.log(`[HiAgent kernel] listening on ws://localhost:${port}`);
  process.on("SIGINT", async () => { agentManager.stopAll(); await intercomMonitor.disconnect(); wsServer.stop(); process.exit(0); });
}
main().catch(e => { console.error(e); process.exit(1); });
