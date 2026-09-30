import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpAdmin, parseMcpListOutput } from "../mcp-admin.ts";

async function tempDir() {
  return await mkdtemp(join(tmpdir(), "mcp-admin-"));
}

describe("parseMcpListOutput（规格 F14）", () => {
  test("解析 servers 与 errors", () => {
    const out = parseMcpListOutput(
      JSON.stringify({
        servers: [
          {
            name: "a",
            scope: "global",
            enabled: true,
            exposure: "direct",
            state: "connected",
            tools: ["t1"],
            transport: "x",
          },
          {
            name: "b",
            scope: "global",
            enabled: true,
            exposure: "codemode",
            state: "failed",
            tools: [],
            error: "boom",
          },
        ],
        errors: [],
      }),
      { exitCode: 1 },
    );
    expect(out.servers).toHaveLength(2);
    expect(out.servers[1].state).toBe("failed");
    expect(out.servers[1].error).toBe("boom");
    // 退出码 1 表示"有 server 异常"，不是命令失败（F14）
    expect(out.commandFailed).toBe(false);
    expect(out.hasProblems).toBe(true);
  });

  test("输出不是 JSON 时标记 stale 且不抛错（规格 §8）", () => {
    const out = parseMcpListOutput("not json at all", { exitCode: 0 });
    expect(out.commandFailed).toBe(true);
    expect(out.servers).toEqual([]);
  });

  test("BOM 与非 UTF-8 噪音被剥离", () => {
    const out = parseMcpListOutput(
      "\uFEFF" + JSON.stringify({ servers: [], errors: [] }),
      { exitCode: 0 },
    );
    expect(out.commandFailed).toBe(false);
  });

  test("配置错误（errors[] 非空）也算 hasProblems，但命令本身成功", () => {
    // 真实 pi 的形态：mcp.json 损坏时 servers 为空、errors 里给一行原因、退出码 1
    const out = parseMcpListOutput(
      JSON.stringify({ servers: [], errors: ["mcp.json: JSON Parse error"] }),
      { exitCode: 1 },
    );
    expect(out.commandFailed).toBe(false);
    expect(out.hasProblems).toBe(true);
    expect(out.errors).toEqual(["mcp.json: JSON Parse error"]);
  });

  test("退 0 且全 connected 时无问题", () => {
    const out = parseMcpListOutput(
      JSON.stringify({
        servers: [
          { name: "a", scope: "global", enabled: true, exposure: "direct", state: "connected", tools: [] },
        ],
        errors: [],
      }),
      { exitCode: 0 },
    );
    expect(out.hasProblems).toBe(false);
  });

  test("被停用的 server（state=disabled）不算异常（F14：pi 此时退 0）", () => {
    // 真实 pi 形态（0.99.1 实测，真 pi 用例见 tests/mcp-admin-spawn.test.ts）：
    // enabled:false 的 server 照常出现在 servers[] 里但 state 恒为 "disabled"，pi 退出码 0。
    const out = parseMcpListOutput(
      JSON.stringify({
        servers: [
          { name: "a", scope: "global", enabled: true, exposure: "direct", state: "connected", tools: [] },
          { name: "off", scope: "global", enabled: false, exposure: "codemode", state: "disabled", tools: [] },
        ],
        errors: [],
      }),
      { exitCode: 0 },
    );
    expect(out.hasProblems).toBe(false);
  });

  test("顶层 note（项目未被信任）原样透传（F12/F13）", () => {
    const note =
      "C:\\proj\\.pi\\mcp.json is ignored because the project is not trusted. Start wa-pi in the project to trust it.";
    const out = parseMcpListOutput(
      JSON.stringify({ servers: [], errors: [], note }),
      { exitCode: 0 },
    );
    expect(out.note).toBe(note);

    // 没有 note 时不编造
    expect(
      parseMcpListOutput(JSON.stringify({ servers: [], errors: [] }), { exitCode: 0 }).note,
    ).toBeUndefined();
  });
});

describe("McpAdmin.isSignedIn（F19）", () => {
  /** isSignedIn 只读文件，不会 spawn；runtime/cliPath 用占位值即可 */
  function adminFor(agentDir: string): McpAdmin {
    return new McpAdmin({
      runtime: process.execPath,
      cliPath: join(agentDir, "unused-cli.js"),
      agentDir,
      cwd: agentDir,
    });
  }

  test("mcp-auth.json 含该 URL 的条目 → true，其它 URL → false", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, "mcp-auth.json"),
      JSON.stringify({ "https://mcp.example.com/sse": { tokens: {} } }),
      "utf8",
    );
    const admin = adminFor(dir);
    expect(await admin.isSignedIn("https://mcp.example.com/sse")).toBe(true);
    expect(await admin.isSignedIn("https://other.example.com/sse")).toBe(false);
  });

  test("文件不存在 → false（不抛错）", async () => {
    const dir = await tempDir();
    expect(await adminFor(dir).isSignedIn("https://mcp.example.com/sse")).toBe(false);
  });

  test("文件损坏 / 形状非法 → false（不抛错）", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "mcp-auth.json"), "{ not json", "utf8");
    expect(await adminFor(dir).isSignedIn("https://mcp.example.com/sse")).toBe(false);
    // 合法 JSON 但不是「URL → 凭据」的 map
    await writeFile(join(dir, "mcp-auth.json"), JSON.stringify(["nope"]), "utf8");
    expect(await adminFor(dir).isSignedIn("https://mcp.example.com/sse")).toBe(false);
  });

  test("同名于原型链的键不算命中", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "mcp-auth.json"), JSON.stringify({}), "utf8");
    expect(await adminFor(dir).isSignedIn("toString")).toBe(false);
  });
});
