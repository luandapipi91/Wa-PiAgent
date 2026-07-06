import { test, expect } from "vitest";
import { agentEmoji, agentGradient } from "../src/theme/agents";
import { STATUS_COLORS } from "../src/theme/colors";

test("agentEmoji 4 角色", () => {
  expect(agentEmoji("product")).toBe("📋");
  expect(agentEmoji("dev")).toBe("⚙️");
});

test("agentGradient 含两色", () => {
  expect(agentGradient("dev")).toContain("#fab387");
  expect(agentGradient("dev")).toContain("#f38ba8");
});

test("STATUS_COLORS 三态", () => {
  expect(STATUS_COLORS.blocked).toBe("#fab387");
});
