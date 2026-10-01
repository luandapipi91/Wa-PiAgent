// 最小 stdio MCP server 夹具（E2E 用）。
//
// 为什么需要真夹具：内置 MCP 化之后，「已连接 / 列出工具」全部由 pi 的
// `pi mcp list --json` 真连服务器得出（kernel 侧 McpAdmin 只读这一份状态），
// 旧的 `command: "echo"` 根本不是 MCP server，pi 连不上、永远拿不到 connected。
//
// 协议要点（对齐 @earendil-works/pi-mcp 的 StdioTransport / McpClient）：
//   - 传输：**换行分隔的 JSON-RPC 2.0**（stdout 每行一条消息；不是 Content-Length 帧）
//   - initialize 的结果必须带 protocolVersion(string) / capabilities(object) /
//     serverInfo{name,version}(string)，且 protocolVersion 必须在客户端支持列表内
//     （2025-11-25 / 2025-06-18 / 2025-03-26 / 2024-11-05）——故这里原样回显客户端请求的版本
//   - tools/list 的条目会被 isTool 过滤：必须带 name(string) + inputSchema(object)
//   - tools/call 的结果允许只有 structuredContent（缺 content 时 SDK 补 []）
//   - resources/list、resources/templates/list 只被 pi 用来统计，返回空表即可
//   - 通知（无 id，如 notifications/initialized）不回包
//
// 零第三方依赖：只用 node/bun 的 process.stdin / process.stdout，故 `bun <file>` 即可启动。
const SERVER_INFO = { name: "poc-mcp-server", version: "1.0.0" };
const SUPPORTED = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const TOOLS = [
  {
    name: "echo",
    description: "原样回显 text 参数（夹具用）",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "要回显的文本" } },
      required: ["text"],
    },
  },
  {
    name: "ping",
    description: "健康检查，返回 pong（夹具用）",
    inputSchema: { type: "object", properties: {} },
  },
];

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function ok(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

const METHOD_NOT_FOUND = -32601;

function handle(message) {
  const { id, method, params } = message;
  // 通知（无 id）不需要回包；notifications/initialized 之类到此为止
  const isNotification = id === undefined || id === null;
  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      ok(id, {
        protocolVersion: SUPPORTED.includes(requested)
          ? requested
          : SUPPORTED[SUPPORTED.length - 1],
        // 只声明 tools：pi 会据此决定要不要调 tools/list
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;
    }
    case "ping":
      ok(id, {});
      return;
    case "tools/list":
      ok(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (name === "echo") {
        const payload = { echo: String(args.text ?? "") };
        ok(id, {
          content: [{ type: "text", text: `pong-poc:${JSON.stringify(payload)}` }],
          structuredContent: payload,
        });
        return;
      }
      if (name === "ping") {
        ok(id, {
          content: [{ type: "text", text: "pong-poc" }],
          structuredContent: { pong: true },
        });
        return;
      }
      fail(id, -32602, `unknown tool: ${String(name)}`);
      return;
    }
    // pi 连上后会统计资源数；不支持就明确回「方法未实现」（客户端按空表处理）
    case "resources/list":
    case "resources/templates/list":
    case "prompts/list":
      if (isNotification) return;
      fail(id, METHOD_NOT_FOUND, `method not supported: ${String(method)}`);
      return;
    default:
      if (isNotification) return;
      fail(id, METHOD_NOT_FOUND, `method not supported: ${String(method)}`);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      // 非法行忽略（不写 stdout，避免污染 JSON-RPC 流）
      continue;
    }
    try {
      handle(message);
    } catch (err) {
      // 单条请求的异常不得让服务器退出
      if (message?.id !== undefined && message?.id !== null) {
        fail(message.id, -32603, String(err?.message ?? err));
      }
    }
  }
});
// stdin 关闭 = 宿主退出：跟着退出（pi 的 StdioTransport.close() 就是关 stdin）
process.stdin.on("end", () => process.exit(0));
