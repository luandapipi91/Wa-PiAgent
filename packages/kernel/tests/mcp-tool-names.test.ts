// MCP 工具名复刻测试（规格 F4/F7）。
//
// 白名单是**精确匹配**：名字与 pi 实际注册的工具名不一致时，pi 找不到该工具却不报错
// （静默失效）。pi 的名字不是朴素拼接：非 `[A-Za-z0-9_]` 字符替换为 `_`（**`-` 也算**，
// 0.99.2 起与 Codex 对齐）、超 64 字符或与其它 MCP 工具撞名时退化为
// `截断前缀_<sha256(server\0tool) 前 8 位>`。本文件逐条锁住这些规则——
// 期望值由 pi 源码公式独立算出（不 import 生产实现），故实现漂移会被抓住。
//
// pi 1.0.4 起 `--tools` 白名单支持 `*` 通配（含 `mcp__` 条目才过滤 MCP 工具），
// 受限 agent 白名单改用服务器粒度通配（`mcpServerPatternsOf`，见文件末尾 describe）；
// 精确名枚举（`mcpToolNamesOf`）仍服务于 UI 工具清单（真实注册名展示）。
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { McpServerReport } from "../src/mcp-admin.ts";
import {
  createMcpToolName,
  mcpServerPatternsOf,
  mcpToolNamesOf,
} from "../src/mcp-tool-names.ts";

/** pi 的工具名上限：64 个 [A-Za-z0-9_-] 字符 */
const MAX = 64;

/**
 * pi 源码公式（`dist/extensions/mcp/tools.js:28-52`）的独立实现，用作期望值。
 *
 * sanitize 的字符集是 `[A-Za-z0-9_]`——**`-` 也算非法字符**（pi 0.99.2 起与 Codex 对齐）。
 * 这个正则必须与生产实现分开维护：两边一起写错就拓不到漂移。
 */
function piFormula(server: string, tool: string): { plain: string; hashed: string } {
  const plain = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
  const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
  return { plain, hashed: `${plain.slice(0, MAX - hash.length - 1)}_${hash}` };
}

function report(over: Partial<McpServerReport> & { name: string }): McpServerReport {
  return {
    scope: "global",
    enabled: true,
    exposure: "direct",
    state: "connected",
    tools: [],
    ...over,
  };
}

describe("createMcpToolName：与 pi 的命名规则一致（F4）", () => {
  test("普通名：sanitize 后不截断", () => {
    expect(createMcpToolName("dbx", "query")).toBe("mcp__dbx__query");
  });

  test("非法字符（空格 / 点 / 中文）替换为 `_`", () => {
    expect(createMcpToolName("my srv", "a.b c")).toBe("mcp__my_srv__a_b_c");
    // 与公式独立对齐：非法字符都被换掉，且没触发 hash
    const { plain, hashed } = piFormula("我的 服务", "查 询");
    expect(createMcpToolName("我的 服务", "查 询")).toBe(plain);
    expect(createMcpToolName("我的 服务", "查 询")).not.toBe(hashed);
  });

  test("含 `-` 的 server / 工具名：`-` 也换成 `_`（pi 0.99.2 起与 Codex 对齐）", () => {
    // 这是最容易静默失效的一类：`mcp__chrome-devtools__take-screenshot` 实际注册成
    // `mcp__chrome_devtools__take_screenshot`，白名单里写前者时 pi 不报错、直接不注册该工具。
    expect(createMcpToolName("chrome-devtools", "take-screenshot")).toBe(
      "mcp__chrome_devtools__take_screenshot",
    );
    expect(createMcpToolName("wa-pi-stdio-script-only", "echo")).toBe(
      "mcp__wa_pi_stdio_script_only__echo",
    );
    expect(createMcpToolName("chrome-devtools", "take-screenshot")).toBe(
      piFormula("chrome-devtools", "take-screenshot").plain,
    );
  });

  test("恰好 64 字符：原样注册（不截断、不加 hash）", () => {
    const tool = "y".repeat(56); // 8 + 56 = 64
    expect(`mcp__s__${tool}`.length).toBe(MAX);
    expect(createMcpToolName("s", tool)).toBe(`mcp__s__${tool}`);
  });

  test("超过 64 字符：截断 + `_` + sha256 前 8 位，长度恒为 64", () => {
    const tool = "y".repeat(57); // 65
    const { plain, hashed } = piFormula("s", tool);
    expect(plain.length).toBe(65);
    expect(createMcpToolName("s", tool)).toBe(hashed);
    expect(createMcpToolName("s", tool).length).toBe(MAX);
    expect(createMcpToolName("s", tool)).not.toBe(plain);
  });

  test("名字被占（isTaken）：同样退化为 hash 变体", () => {
    const { hashed } = piFormula("dbx", "query");
    expect(createMcpToolName("dbx", "query", () => true)).toBe(hashed);
    // isTaken 只对简式名询问一次；返回 false 时保持简式名
    expect(createMcpToolName("dbx", "query", () => false)).toBe("mcp__dbx__query");
  });
});

describe("mcpToolNamesOf：枚举 pi 会注册出的工具名", () => {
  test("已连服务器的工具名全部枚举，不按 exposure 过滤（命名 mcp__<server>__<tool>）", () => {
    const names = mcpToolNamesOf([
      report({ name: "dbx", tools: ["query", "list"] }),
      report({ name: "codemode_srv", exposure: "codemode", tools: ["get_profile"] }),
      report({ name: "deferred_srv", exposure: "deferred", tools: ["search_docs"] }),
      report({
        name: "codemode_deferred_srv",
        exposure: "codemode-deferred",
        tools: ["ghost"],
      }),
    ]);
    for (const name of [
      "mcp__dbx__query",
      "mcp__dbx__list",
      "mcp__codemode_srv__get_profile",
      "mcp__deferred_srv__search_docs",
      "mcp__codemode_deferred_srv__ghost",
    ]) {
      expect(names).toContain(name);
    }
  });

  test("exposure 缺省（pi 报 codemode）的 server：工具名进清单，且一并放行 codemode 入口", () => {
    // pi 的 report.exposure = config.exposure ?? "codemode"（dist/extensions/mcp/cli.js 的 list）：
    // 未写 exposure 的 server 就是这一档；白名单里没有 codemode 时它的工具一个都调不到
    const names = mcpToolNamesOf([
      report({ name: "new_srv", exposure: "codemode", tools: ["get_profile"] }),
    ]);
    expect(names).toContain("mcp__new_srv__get_profile");
    expect(names).toContain("codemode");
  });

  test("codemode-deferred：入口同为 codemode（pi 对这两档都激活 codemode）", () => {
    const names = mcpToolNamesOf([
      report({ name: "s", exposure: "codemode-deferred", tools: ["t"] }),
    ]);
    expect(names).toContain("mcp__s__t");
    expect(names).toContain("codemode");
    expect(names).not.toContain("tool_search");
  });

  test("deferred：工具名进清单，且一并放行 tool_search 入口", () => {
    const names = mcpToolNamesOf([
      report({ name: "s", exposure: "deferred", tools: ["search_docs"] }),
    ]);
    expect(names).toContain("mcp__s__search_docs");
    expect(names).toContain("tool_search");
    expect(names).not.toContain("codemode");
  });

  test("全是 direct 时不白给入口工具", () => {
    expect(mcpToolNamesOf([report({ name: "dbx", tools: ["query"] })])).toEqual([
      "mcp__dbx__query",
    ]);
  });

  test("hidden 无入口：工具名仍列出（多列无害），但不放行任何入口工具", () => {
    const names = mcpToolNamesOf([
      report({ name: "s", exposure: "hidden", tools: ["t"] }),
    ]);
    expect(names).toContain("mcp__s__t");
    expect(names).not.toContain("codemode");
    expect(names).not.toContain("tool_search");
  });

  test("未连上 / 已停用的服务器：工具名与入口工具都不放行（pi 连不上就没注册）", () => {
    const names = mcpToolNamesOf([
      report({ name: "failed_srv", state: "failed", exposure: "codemode", tools: ["x"] }),
      report({
        name: "off_srv",
        enabled: false,
        state: "disabled",
        exposure: "codemode",
        tools: ["nope"],
      }),
      report({ name: "auth_srv", state: "needs-auth", exposure: "deferred", tools: ["y"] }),
    ]);
    expect(names).toEqual([]);
  });

  test("含非法字符的工具名：按 pi 的 sanitize 规则进清单", () => {
    const names = mcpToolNamesOf([report({ name: "my srv", tools: ["a.b c"] })]);
    expect(names).toEqual(["mcp__my_srv__a_b_c"]);
  });

  test("含 `-` 的服务器：清单里是 `_` 形态（写错就静默失效）", () => {
    const names = mcpToolNamesOf([
      report({ name: "chrome-devtools", tools: ["take-screenshot"] }),
    ]);
    expect(names).toEqual(["mcp__chrome_devtools__take_screenshot"]);
  });

  test("`-` 与 `_` 的工具名 sanitize 后撞名（a-b 与 a_b）：同样都放行", () => {
    const names = mcpToolNamesOf([report({ name: "dbx", tools: ["a-b", "a_b"] })]);
    expect(new Set(names)).toEqual(
      new Set([
        piFormula("dbx", "a-b").plain,
        piFormula("dbx", "a-b").hashed,
        piFormula("dbx", "a_b").hashed,
      ]),
    );
  });

  test("超长（>64）工具名：清单里是 hash 变体，与 pi 公式逐字一致", () => {
    const tool = "x".repeat(57);
    const { hashed } = piFormula("s", tool);
    const names = mcpToolNamesOf([report({ name: "s", tools: [tool] })]);
    expect(names).toEqual([hashed]);
    expect(names).not.toContain(`mcp__s__${tool}`);
  });

  test("同 server 内 sanitize 撞名（a.b 与 a_b）：简式名与两个 hash 变体都放行", () => {
    const names = mcpToolNamesOf([report({ name: "dbx", tools: ["a.b", "a_b"] })]);
    // 简式名归谁取决于 pi 的注册顺序（单次快照不可判定）→ 两个变体都列，漏列才是 bug
    expect(new Set(names)).toEqual(
      new Set([
        piFormula("dbx", "a.b").plain,
        piFormula("dbx", "a.b").hashed,
        piFormula("dbx", "a_b").hashed,
      ]),
    );
  });

  test("跨 server 撞名（a/b__c 与 a__b/c 同为 mcp__a__b__c）：同样都放行", () => {
    const names = mcpToolNamesOf([
      report({ name: "a", tools: ["b__c"] }),
      report({ name: "a__b", tools: ["c"] }),
    ]);
    expect(new Set(names)).toEqual(
      new Set([
        piFormula("a", "b__c").plain,
        piFormula("a", "b__c").hashed,
        piFormula("a__b", "c").hashed,
      ]),
    );
  });

  test("未撞名的普通工具不因邻居撞名被牵连（简式名保持唯一）", () => {
    const names = mcpToolNamesOf([
      report({ name: "dbx", tools: ["a.b", "a_b", "plain"] }),
    ]);
    expect(names).toContain("mcp__dbx__plain");
    expect(names).not.toContain(piFormula("dbx", "plain").hashed);
  });

  test("同一 (server, tool) 重复上报只产出一条", () => {
    const names = mcpToolNamesOf([
      report({ name: "dbx", tools: ["q"] }),
      report({ name: "dbx", tools: ["q"] }),
    ]);
    expect(names).toEqual(["mcp__dbx__q"]);
  });
});

// -----------------------------------------------------------------------------
// mcpServerPatternsOf：受限 agent 白名单用的服务器粒度通配（pi 1.0.4 语义）。
//
// pi 1.0.4 起 `--tools` 含任何 `mcp__` 前缀条目即进入 MCP 硬过滤，条目按
// 精确名（Set）或 `*` 通配（正则）匹配注册名。服务器粒度通配 `mcp__<server>__*`
// 的优势：前缀恒定 → 天然覆盖超长/撞名的 hash 退化名（前缀不变），枚举竞态
// （工具清单未就绪）也不再漏放行。POC 实测（pi 1.0.4，direct 曝光）：
//   - `mcp__poc-mcp-server__*`（未 sanitize）→ 不匹配（注册名是 `poc_mcp_server`）
//   - `mcp__poc_mcp_server__*` → echo+ping 全部 declare
//   - `mcp__poc_mcp_server__echo` → 只有 echo declare
//   - `--tools read`（无 mcp__ 条目）→ MCP 工具不 declare
//   - `--no-mcp --tools read` → 同上
// -----------------------------------------------------------------------------

/** 模式期望值的独立实现：与 pi 的 sanitize 规则一致（0.99.2 起 `-` 也替换） */
function patternFor(server: string): string {
  return `mcp__${server.replace(/[^A-Za-z0-9_]/g, "_")}__*`;
}

describe("mcpServerPatternsOf：白名单用的服务器粒度通配（pi 1.0.4）", () => {
  test("connected 服务器输出 mcp__<server>__* 模式，direct 曝光无入口工具", () => {
    expect(
      mcpServerPatternsOf([report({ name: "dbx", tools: ["query", "list"] })]),
    ).toEqual(["mcp__dbx__*"]);
  });

  test("server 名含 `-`：模式必须用 sanitize 后的名字（POC：原名匹配不到）", () => {
    const patterns = mcpServerPatternsOf([
      report({ name: "chrome-devtools", tools: ["take-screenshot"] }),
    ]);
    expect(patterns).toEqual([patternFor("chrome-devtools")]);
    expect(patterns[0]).toBe("mcp__chrome_devtools__*");
    expect(patterns[0]).not.toContain("chrome-devtools");
  });

  test("server 名含空格 / 中文 / 点：同样 sanitize 为 `_`", () => {
    const patterns = mcpServerPatternsOf([
      report({ name: "my srv.x", tools: [] }),
      report({ name: "我的服务", tools: [] }),
    ]);
    expect(patterns).toEqual([patternFor("my srv.x"), patternFor("我的服务")]);
  });

  test("未连上 / 已停用 / 需登录的服务器：不输出模式也不输出入口（与枚举口径一致）", () => {
    const patterns = mcpServerPatternsOf([
      report({ name: "failed_srv", state: "failed", exposure: "codemode" }),
      report({
        name: "off_srv",
        enabled: false,
        state: "disabled",
        exposure: "codemode",
      }),
      report({ name: "auth_srv", state: "needs-auth", exposure: "deferred" }),
    ]);
    expect(patterns).toEqual([]);
  });

  test("codemode 曝光：模式 + codemode 入口殿后", () => {
    expect(
      mcpServerPatternsOf([
        report({ name: "new_srv", exposure: "codemode", tools: ["get_profile"] }),
      ]),
    ).toEqual(["mcp__new_srv__*", "codemode"]);
  });

  test("codemode-deferred：入口同为 codemode（pi 对这两档都激活 codemode）", () => {
    expect(
      mcpServerPatternsOf([
        report({ name: "s", exposure: "codemode-deferred", tools: ["t"] }),
      ]),
    ).toEqual(["mcp__s__*", "codemode"]);
  });

  test("deferred 曝光：模式 + tool_search 入口殿后", () => {
    expect(
      mcpServerPatternsOf([
        report({ name: "s", exposure: "deferred", tools: ["search_docs"] }),
      ]),
    ).toEqual(["mcp__s__*", "tool_search"]);
  });

  test("hidden 曝光：模式多列无害，但不放行任何入口工具", () => {
    expect(
      mcpServerPatternsOf([report({ name: "s", exposure: "hidden", tools: ["t"] })]),
    ).toEqual(["mcp__s__*"]);
  });

  test("多台非 direct 服务器共享同一入口：入口去重只出一个", () => {
    const patterns = mcpServerPatternsOf([
      report({ name: "a", exposure: "codemode", tools: ["t1"] }),
      report({ name: "b", exposure: "codemode", tools: ["t2"] }),
      report({ name: "c", exposure: "deferred", tools: ["t3"] }),
    ]);
    expect(patterns).toEqual([
      "mcp__a__*",
      "mcp__b__*",
      "mcp__c__*",
      "codemode",
      "tool_search",
    ]);
  });

  test("同一服务器重复上报：模式只产出一条", () => {
    expect(
      mcpServerPatternsOf([
        report({ name: "dbx", tools: ["q"] }),
        report({ name: "dbx", tools: ["q"] }),
      ]),
    ).toEqual(["mcp__dbx__*"]);
  });

  test("空报告：空数组", () => {
    expect(mcpServerPatternsOf([])).toEqual([]);
  });
});
