// 内置 agent-browser MCP 的定义（唯一来源）。
//
// 条目物化进全局 mcp.json 才能被 pi 看到；除 enabled 外的字段由 ensure 每次启动纠正，
// 因此这里只描述"目标状态"，不做持久化。
import type { McpServerConfig } from "@wa-pi/shared";
import { BUILTIN_MCP_NAME } from "@wa-pi/shared";

export const BUILTIN_MCP_DESCRIPTION = "浏览器自动化（agent-browser）";

/** 内置条目目标状态（command 由调用方解析出的平台二进制路径填入） */
export function builtinAgentBrowserEntry(
  command: string,
): McpServerConfig & { description: string } {
  return {
    name: BUILTIN_MCP_NAME,
    type: "stdio",
    command,
    args: ["mcp"],
    exposure: "direct",
    env: {
      // pi 在启动 MCP 子进程时按自身 process.env 展开；kernel spawn pi 时写入该变量
      AGENT_BROWSER_SESSION: "${WA_PI_BROWSER_SESSION}",
      AGENT_BROWSER_IDLE_TIMEOUT_MS: "600000",
    },
    description: BUILTIN_MCP_DESCRIPTION,
  };
}
