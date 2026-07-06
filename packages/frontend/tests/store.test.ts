import { test, expect } from "bun:test";
import { useAgents } from "../src/store/agents";
import { useSession } from "../src/store/session";
import { useIntercom } from "../src/store/intercom";

test("agents store: setList + updateState", () => {
  useAgents.getState().setList([{ name: "dev", displayName: "研发", avatar: "⚙️", description: "", model: "test", thinking: "off", tools: [], skills: [], partners: { askTo: [], askFrom: [] } }]);
  expect(useAgents.getState().list.length).toBe(1);
  useAgents.getState().updateState("dev", { status: "thinking" });
  expect(useAgents.getState().states["dev"].status).toBe("thinking");
});

test("session store: selectAgent + addMessage", () => {
  useSession.getState().selectAgent("dev");
  expect(useSession.getState().currentAgent).toBe("dev");
  useSession.getState().addMessage("dev", { id: "m1", role: "user", text: "hi", timestamp: 1 });
  expect(useSession.getState().messages["dev"].length).toBe(1);
});

test("intercom store: addAsk + resolveAsk", () => {
  useIntercom.getState().addAsk({ messageId: "a1", from: "product", to: "dev", text: "1+1?", startedAt: 0, resolved: false });
  expect(useIntercom.getState().asks.length).toBe(1);
  useIntercom.getState().resolveAsk("a1");
  expect(useIntercom.getState().asks[0].resolved).toBe(true);
});
