// MCP 工具名复刻测试（规格 F4/F7）。
//
// 白名单是**精确匹配**：名字与 pi 实际注册的工具名不一致时，pi 找不到该工具却不报错
// （静默失效）。pi 的名字不是朴素拼接：非法字符替换为 `_`、超 64 字符或与其它 MCP 工具
// 撞名时退化为 `截断前缀_<sha256(server\0tool) 前 8 位>`。本文件逐条锁住这些规则——
// 期望值由 pi 源码公式独立算出（不 import 生产实现），故实现漂移会被抓住。
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { McpServerReport } from "../src/mcp-admin.ts";
import { createMcpToolName, mcpToolNamesOf } from "../src/mcp-tool-names.ts";

/** pi 的工具名上限：64 个 [A-Za-z0-9_-] 字符 */
const MAX = 64;

/** pi 源码公式（dist/extensions/mcp/tools.js:28-52）的独立实现，用作期望值 */
function piFormula(server: string, tool: string): { plain: string; hashed: string } {
  const plain = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_");
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
  test("只枚举已连上且 exposure=direct 的服务器工具（命名 mcp__<server>__<tool>）", () => {
    const names = mcpToolNamesOf([
      report({ name: "codemode_srv", exposure: "codemode", tools: ["get_profile"] }),
      report({ name: "failed_srv", state: "failed", tools: [] }),
      report({ name: "off_srv", enabled: false, state: "disabled", tools: ["nope"] }),
      report({ name: "dbx", tools: ["query", "list"] }),
    ]);
    expect(names).toEqual(["mcp__dbx__query", "mcp__dbx__list"]);
  });

  test("含非法字符的工具名：按 pi 的 sanitize 规则进清单", () => {
    const names = mcpToolNamesOf([report({ name: "my srv", tools: ["a.b c"] })]);
    expect(names).toEqual(["mcp__my_srv__a_b_c"]);
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
