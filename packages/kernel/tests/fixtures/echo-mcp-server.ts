// tests/fixtures/echo-mcp-server.ts — 最小 stdio MCP 服务器，作为连接测试的固定件。
// 通过 stdin/stdout 与 StdioClientTransport 握手，暴露两个工具，供 testConnection/listTools 测试真实连接。

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "echo-test", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echoes the given text",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", description: "Text to echo" } },
        required: ["text"],
      },
    },
    {
      name: "ping",
      description: "Returns pong",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{ type: "text", text: `ok:${request.params.name}` }],
}));

await server.connect(new StdioServerTransport());
