// validateMcpServer：MCP 服务器配置的字段级校验（规格 §8）。
// 这是纯函数、跨包共用，kernel 的写入层与前端表单都依赖它返回的错误字段做定位。
import { describe, expect, test } from "bun:test";
import { validateMcpServer } from "../src/mcp";

/** 只取错误的 field 列表，便于断言"错在哪个字段" */
const fields = (input: Parameters<typeof validateMcpServer>[0]) =>
	validateMcpServer(input).map((e) => e.field);

describe("validateMcpServer", () => {
	test("合法配置 → 无错误（stdio / http / streamable-http）", () => {
		expect(fields({ name: "srv-1", type: "stdio", command: "npx" })).toEqual([]);
		expect(fields({ name: "srv_1", type: "http", url: "https://x/mcp" })).toEqual([]);
		expect(
			fields({ name: "srv1", type: "streamable-http", url: "https://x/mcp" }),
		).toEqual([]);
		// 不写 type 时按 command/url 推断，同样合法
		expect(fields({ name: "srv1", command: "npx" })).toEqual([]);
		expect(fields({ name: "srv1", url: "https://x/mcp" })).toEqual([]);
	});

	test("服务器名含非法字符（空格/感叹号/中文/空）→ name 字段错误", () => {
		for (const name of ["bad name!", "服务器", "", "a/b"]) {
			expect(fields({ name, command: "x" })).toEqual(["name"]);
		}
	});

	test("command 与 url 同时提供 → url 字段错误（互斥）", () => {
		expect(
			fields({ name: "s", command: "a", url: "https://x/mcp" }),
		).toEqual(["url"]);
	});

	test("command 与 url 都缺 → command 字段错误", () => {
		expect(fields({ name: "s" })).toEqual(["command"]);
		// 空串等同于缺省
		expect(fields({ name: "s", command: "", url: "" })).toEqual(["command"]);
	});

	test("type 与 transport 不匹配 → type 字段错误", () => {
		// 声明 http 系却给了 command
		expect(fields({ name: "s", type: "http", command: "npx" })).toEqual(["type"]);
		expect(
			fields({ name: "s", type: "streamable-http", command: "npx" }),
		).toEqual(["type"]);
		// 声明 stdio 却只给了 url
		expect(fields({ name: "s", type: "stdio", url: "https://x/mcp" })).toEqual([
			"command",
		]);
	});

	test("timeout 非正数或非有限 → timeout 字段错误", () => {
		for (const timeout of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(fields({ name: "s", command: "x", timeout })).toEqual(["timeout"]);
		}
		expect(fields({ name: "s", command: "x", timeout: 45 })).toEqual([]);
	});
});
