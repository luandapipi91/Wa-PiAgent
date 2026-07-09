import type { AgentStatus } from "@hiagent/shared";

// HiAgent Light 浅色调色板：idle 用次文字灰、thinking 用靛蓝强调、blocked 用警告橙
export const STATUS_COLORS: Record<AgentStatus, string> = {
  idle: "#A1A1A6",      // text-tertiary — 次要灰
  thinking: "#5B5BD6",  // accent — 靛蓝强调
  blocked: "#B45309",   // warning — 警告橙
};
