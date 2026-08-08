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
