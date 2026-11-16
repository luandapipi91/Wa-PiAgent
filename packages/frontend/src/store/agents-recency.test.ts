// 最近使用排序的边界：lastActivity 缺失时不能退化成「名字排序」。
// 历史数据/导入数据可能没有 lastActivity 字段——旧实现里 Math.max(0, undefined) = NaN，
// 比较器返回 NaN 被 || 判为 falsy → 落到 displayName.localeCompare，
// 「最近使用」就悄悄变成了「名字排序第一」（新建会话默认角色看起来总选第一个的诱因之一）。
import { test, expect } from "bun:test";
import { topAgentsByRecency } from "./agents";

const agents = [
  { displayName: "产品经理" },
  { displayName: "高级项目经理" },
] as any;

test("lastActivity 缺失时按 0 处理，不让有会话的智能体掉到名字序后面", () => {
  const sessions = [{ primaryAgent: "高级项目经理" }] as any;
  expect(topAgentsByRecency(agents, sessions, 1)[0].displayName).toBe(
    "高级项目经理",
  );
});

test("正常 lastActivity 仍按时间倒序", () => {
  const sessions = [
    { primaryAgent: "产品经理", lastActivity: 200 },
    { primaryAgent: "高级项目经理", lastActivity: 100 },
  ] as any;
  expect(topAgentsByRecency(agents, sessions, 1)[0].displayName).toBe(
    "产品经理",
  );
});
