// 列表批量探测的超时分档回归测试：
// http 类握手毫秒级 → 3s 截止；stdio 类要 spawn 子进程（npx 冷启动实测 4~5s）→ 放宽到 10s。
// 缺陷背景：统一 3s 把 Context7（npx 启动）误判成「握手超时或进程提前退出」，而 pi（60s）是好的。
import { describe, expect, test } from "bun:test";
import { probeTimeoutFor, PROBE_TIMEOUT_HTTP_MS, PROBE_TIMEOUT_STDIO_MS } from "../routes/mcp";

describe("probeTimeoutFor：按传输类型分档", () => {
  test("http 类（type:http / streamable-http / 缺省按 url 推断）→ 3s", () => {
    expect(PROBE_TIMEOUT_HTTP_MS).toBe(3000);
    expect(PROBE_TIMEOUT_STDIO_MS).toBe(10000);
    expect(probeTimeoutFor({ name: "a", type: "http", url: "http://x/mcp" })).toBe(3000);
    expect(probeTimeoutFor({ name: "a", type: "streamable-http", url: "http://x/mcp" })).toBe(3000);
    expect(probeTimeoutFor({ name: "a", url: "http://x/mcp" })).toBe(3000);
  });

  test("stdio 类（type:stdio / 缺省按 command 推断）→ 10s（覆盖 npx 冷启动）", () => {
    expect(probeTimeoutFor({ name: "c7", type: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp@latest"] })).toBe(10000);
    expect(probeTimeoutFor({ name: "dbx", command: "/Users/co/.dbx/bin/dbx-mcp" })).toBe(10000);
  });
});
