import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpFile } from "../mcp-file";
import { createMcpHandlers, type McpHandlers } from "../routes/mcp";

let dir: string;
let handlers: McpHandlers;
const events: unknown[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-builtin-routes-"));
  writeFileSync(
    join(dir, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        "agent-browser": {
          type: "stdio",
          command: "/bin/agent-browser",
          args: ["mcp"],
          enabled: false,
        },
        dbx: { type: "stdio", command: "/bin/dbx", enabled: false },
      },
    }),
  );
  handlers = createMcpHandlers({
    mcpFile: new McpFile({
      globalPath: join(dir, "mcp.json"),
      projectPathFor: async () => join(dir, "project-mcp.json"),
    }),
    cwdForProject: async () => dir,
    adminForCwd: () => ({
      list: async () => ({
        servers: [],
        errors: [],
        commandFailed: false,
        hasProblems: false,
        stale: true,
      }),
      invalidate: () => {},
      cached: () => false,
    }),
    invalidateCaches: () => {},
    broadcast: (e) => events.push(e),
    piSpawn: { runtime: "bun", cliPath: "unused.js", agentDir: dir },
  });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("列表条目带 builtin 标记", async () => {
  const payload = await handlers.list();
  expect(payload.servers.find((s) => s.name === "agent-browser")?.builtin).toBe(true);
  expect(payload.servers.find((s) => s.name === "dbx")?.builtin).toBeUndefined();
});

test("删除内置条目抛 mcp.builtinProtected", async () => {
  await expect(handlers.remove({ serverName: "agent-browser" })).rejects.toMatchObject({
    code: "mcp.builtinProtected",
  });
});

test("启停只改 enabled", async () => {
  await handlers.setEnabled({ serverName: "agent-browser", enabled: true });
  const entry = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8")).mcpServers[
    "agent-browser"
  ];
  expect(entry.enabled).toBeUndefined();
  // list 时的 ensureBuiltin 会把 command 纠正为解析出的真实二进制路径
  expect(typeof entry.command).toBe("string");
  expect(entry.command.length).toBeGreaterThan(0);
});
