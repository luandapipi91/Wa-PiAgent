import { test, expect } from "bun:test";
import { pickDefaultAgent } from "./NewSessionPane";

const agents = [
  { displayName: "甲" },
  { displayName: "林晓岚" },
  { displayName: "乙" },
] as any;

test("pendingAgent 最优先", () => {
  expect(pickDefaultAgent(agents, [], "丙", "林晓岚")).toBe("丙");
});

test("defaultAgent 次之（须仍在列表中）", () => {
  expect(pickDefaultAgent(agents, [], null, "林晓岚")).toBe("林晓岚");
});

test("defaultAgent 已被删除时落空到列表第一", () => {
  expect(pickDefaultAgent(agents, [], null, "已删除的人")).toBe("甲");
});

test("无 defaultAgent 时保持原逻辑：无会话取列表第一", () => {
  expect(pickDefaultAgent(agents, [], null, null)).toBe("甲");
});

test("有会话历史时 defaultAgent 仍优先于最近使用者", () => {
  // 发现 2 的级联语义：向导重设默认智能体后应覆盖「最近使用」的回填
  const sessions = [{ primaryAgent: "乙", lastActivity: 123 }] as any;
  expect(pickDefaultAgent(agents, sessions, null, "林晓岚")).toBe("林晓岚");
  // 对照：不传 defaultAgent 时才回落到最近使用者
  expect(pickDefaultAgent(agents, sessions, null, null)).toBe("乙");
});

test("空列表返回 null", () => {
  expect(pickDefaultAgent([], [], null, "林晓岚")).toBeNull();
});

// === lastAgent（上次在新建会话页选的角，持久化） ===
test("lastAgent 优先于最近使用者", () => {
  const sessions = [{ primaryAgent: "乙", lastActivity: 123 }] as any;
  expect(
    pickDefaultAgent(agents, sessions, null, null, "林晓岚"),
  ).toBe("林晓岚");
});

test("lastAgent 优先于向导 defaultAgent（更近的选择胜出）", () => {
  expect(pickDefaultAgent(agents, [], null, "甲", "林晓岚")).toBe("林晓岚");
});

test("lastAgent 已被删除时回落 defaultAgent", () => {
  expect(pickDefaultAgent(agents, [], null, "甲", "已删除的人")).toBe("甲");
});

// === currentAgent（从已有会话进入新建页，沿用该会话的角色） ===
test("当前会话角色优先于 lastAgent（已有会话仍按当时会话的角）", () => {
  expect(
    pickDefaultAgent(agents, [], null, null, "林晓岚", "乙"),
  ).toBe("乙");
});

test("当前会话角色优先于向导 defaultAgent", () => {
  expect(pickDefaultAgent(agents, [], null, "甲", null, "乙")).toBe("乙");
});

test("currentAgent 已被删除时回落 lastAgent", () => {
  expect(
    pickDefaultAgent(agents, [], null, null, "林晓岚", "已删除的人"),
  ).toBe("林晓岚");
});

test("pendingAgent 仍压过当前会话角色", () => {
  expect(pickDefaultAgent(agents, [], "丙", null, "林晓岚", "乙")).toBe("丙");
});
