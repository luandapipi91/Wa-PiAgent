import { test, expect, beforeEach } from "vitest";
import { useAgentsStore } from "../src/store/agents";

beforeEach(() => useAgentsStore.setState({ states: {}, configs: {} }));

test("getGlobalState 跨项目聚合", () => {
  const { setState, getGlobalState } = useAgentsStore.getState();
  setState("p1:dev", { name: "dev", status: "idle" });
  setState("p2:dev", { name: "dev", status: "thinking" });
  expect(getGlobalState("dev")).toBe("thinking");
  setState("p3:dev", { name: "dev", status: "blocked" });
  expect(getGlobalState("dev")).toBe("blocked");
});
