// fake-mcp-admin.ts —— 测试共享的 McpAdmin 假实现（注入 AgentManager.mcpAdmin）。
//
// AgentManager 构造默认自建真实 McpAdmin，而它会 spawn `pi mcp list --json`（真的去连
// 每一台 MCP server）。不关心 MCP 的既有测试注入本 helper，避免单测起子进程；
// 需要断言枚举结果/调用次数的测试用 makeFakeMcpAdmin(servers) 自建并持有引用。
import type { McpListResult, McpServerReport } from "../../src/mcp-admin";

export interface FakeMcpAdmin {
  /** 下一次 list() 返回的服务器报告（测试可随时改） */
  servers: McpServerReport[];
  /** list() 调用次数（含延时刷新触发的那次） */
  listCalls: number;
  /** invalidate() 调用次数 */
  invalidateCalls: number;
  list(force?: boolean): Promise<McpListResult & { stale: boolean }>;
  invalidate(): void;
}

export function makeFakeMcpAdmin(
  servers: McpServerReport[] = [],
): FakeMcpAdmin {
  const fake: FakeMcpAdmin = {
    servers,
    listCalls: 0,
    invalidateCalls: 0,
    async list() {
      fake.listCalls++;
      return {
        servers: fake.servers,
        errors: [],
        commandFailed: false,
        hasProblems: false,
        stale: false,
      };
    },
    invalidate() {
      fake.invalidateCalls++;
    },
  };
  return fake;
}
