import type { AgentStatus } from "@wa-pi/shared";

// WaPi Light 浅色调色板：idle 用成功绿（空闲=正常）、thinking 用靛蓝强调、blocked 用警告橙
export const STATUS_COLORS: Record<AgentStatus, string> = {
  idle: "#34A853",      // success — 空闲绿
  thinking: "#5B5BD6",  // accent — 靛蓝强调
  blocked: "#B45309",   // warning — 警告橙
};
