import { test, expect } from "bun:test";
import { agentEmoji, agentGradient } from "../src/theme/agents";
import { STATUS_COLORS } from "../src/theme/colors";

test("agentEmoji 4 角色", () => {
  expect(agentEmoji("product")).toBe("📋");
  expect(agentEmoji("dev")).toBe("⚙️");
});

test("agentGradient 含两色", () => {
  expect(agentGradient("dev")).toContain("#1D1D1F");
  expect(agentGradient("dev")).toContain("#2C2C2E");
});

test("未知名回退 agentDefOf 默认头像与渐变（动态智能体无内置定义）", () => {
  expect(agentEmoji("自定义智能体")).toBe("🤖");
  expect(agentGradient("自定义智能体")).toContain("#4b5563");
  expect(agentGradient("自定义智能体")).toContain("#6b7280");
});

test("STATUS_COLORS 三态", () => {
  expect(STATUS_COLORS.thinking).toBe("#5B5BD6");
  expect(STATUS_COLORS.idle).toBe("#34A853");
  expect(STATUS_COLORS.blocked).toBe("#B45309");
});
