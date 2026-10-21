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
    // 真实 pi 形态（真 pi 用例见 tests/mcp-admin-spawn.test.ts；0.99.1 与 1.0.0 实测同形）：
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
    expect(await admin.isSignedIn("srv", "https://mcp.example.com/sse")).toBe(true);
    expect(await admin.isSignedIn("srv", "https://other.example.com/sse")).toBe(false);
  });

  test("文件不存在 → false（不抛错）", async () => {
    const dir = await tempDir();
    expect(await adminFor(dir).isSignedIn("srv", "https://mcp.example.com/sse")).toBe(false);
  });

  test("文件损坏 / 形状非法 → false（不抛错）", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "mcp-auth.json"), "{ not json", "utf8");
    expect(await adminFor(dir).isSignedIn("srv", "https://mcp.example.com/sse")).toBe(false);
    // 合法 JSON 但不是「键 → 凭据」的 map
    await writeFile(join(dir, "mcp-auth.json"), JSON.stringify(["nope"]), "utf8");
    expect(await adminFor(dir).isSignedIn("srv", "https://mcp.example.com/sse")).toBe(false);
  });

  test("同名于原型链的键不算命中", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, "mcp-auth.json"),
      JSON.stringify({ toString: { tokens: {} }, "mcp__srv|toString": { tokens: {} } }),
      "utf8",
    );
    expect(await adminFor(dir).isSignedIn("srv", "https://mcp.example.com/sse")).toBe(false);
  });

  test("server URL 不是合法 URL → false（无从判断，按未登录处理）", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "mcp-auth.json"), JSON.stringify({}), "utf8");
    expect(await adminFor(dir).isSignedIn("srv", "toString")).toBe(false);
    expect(await adminFor(dir).isSignedIn("srv", "")).toBe(false);
  });

  test("pi 1.0.0 的新键 `<命名空间>|<URL>` 能认出来（F19）", async () => {
    // 1.0.0 起 pi 把键换成 `mcp__<server 名，- 换 _>|<String(new URL(url))>`：
    // 只按 URL 查会一律判成未登录 → 登录成功后界面仍显示「未登录」。
    const dir = await tempDir();
    await writeFile(
      join(dir, "mcp-auth.json"),
      JSON.stringify({ "mcp__my_srv|https://mcp.example.com/sse": { tokens: {} } }),
      "utf8",
    );
    const admin = adminFor(dir);
    expect(await admin.isSignedIn("my_srv", "https://mcp.example.com/sse")).toBe(true);
    // URL 未规范化（主机名大小写 / 默认端口）也要能对上
    expect(await admin.isSignedIn("my_srv", "https://MCP.example.com:443/sse")).toBe(true);
    // 同 URL 的另一台 server 不算命中：命名空间进了键，就是为了各存各的凭据
    expect(await admin.isSignedIn("other_srv", "https://mcp.example.com/sse")).toBe(false);
  });

  test("server 名里的 `-` 按 pi 的命名空间规则换成 `_`", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, "mcp-auth.json"),
      JSON.stringify({ "mcp__chrome_devtools|https://mcp.example.com/sse": { tokens: {} } }),
      "utf8",
    );
    expect(
      await adminFor(dir).isSignedIn("chrome-devtools", "https://mcp.example.com/sse"),
    ).toBe(true);
  });

  test("迁移期新旧键并存：任一种在盘上就算已登录", async () => {
    // pi 的迁移是惰性的（只在加载某台 server 时才把旧键搬成新键），
    // 盘上随时可能是「新旧并存」或「只有旧键」——两种都不能判成未登录。
    const dir = await tempDir();
    await writeFile(
      join(dir, "mcp-auth.json"),
      JSON.stringify({
        "https://mcp.example.com/sse": { tokens: {} },
        "mcp__another_srv|https://another.example.com/sse": { tokens: {} },
      }),
      "utf8",
    );
    const admin = adminFor(dir);
    expect(await admin.isSignedIn("srv", "https://mcp.example.com/sse")).toBe(true);
    expect(await admin.isSignedIn("another_srv", "https://another.example.com/sse")).toBe(true);
  });

  test("按 pi 的规范化键比对：盘上 https://host/ ←→ 传入 https://host（F19 回归）", async () => {
    // pi 存的是 String(new URL(url))：主机名小写、默认端口省略、无路径 URL 补尾斜杠。
    // 拿配置里原样的字符串去查会漏判成「未登录」→ 登录按钮重复出现 / 登出按钮消失。
    const dir = await tempDir();
    await writeFile(
      join(dir, "mcp-auth.json"),
      JSON.stringify({ "https://host/": { tokens: {} } }),
      "utf8",
    );
    const admin = adminFor(dir);
    expect(await admin.isSignedIn("srv", "https://host")).toBe(true);
    expect(await admin.isSignedIn("srv", "https://HOST:443")).toBe(true);
    expect(await admin.isSignedIn("srv", "https://host/other")).toBe(false);
  });

  test("盘上的键未规范化（手工编辑）也能匹配：两边都过一遍规范化", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, "mcp-auth.json"),
      JSON.stringify({ "https://HOST": { tokens: {} } }),
      "utf8",
    );
    expect(await adminFor(dir).isSignedIn("srv", "https://host/")).toBe(true);
  });
});
