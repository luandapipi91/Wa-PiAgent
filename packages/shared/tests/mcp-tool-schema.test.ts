// toolParamsFromSchema：MCP 工具 inputSchema（JSON Schema）→ 参数摘要（TDD 先红）。
//
// 背景：MCP 的 tools/list 响应本来带着 description 与 inputSchema，此前探测器只取了
// name，导致「查看工具」弹窗只能显示工具名。参数摘要的转换规则放在 shared，
// kernel（探测器）与后续任何消费者共用同一份实现。
import { describe, expect, test } from "bun:test";
import { toolParamsFromSchema } from "../src/mcp";

describe("toolParamsFromSchema", () => {
	test("properties + required → 逐参数给 name/type/description/required", () => {
		expect(
			toolParamsFromSchema({
				type: "object",
				properties: {
					name: { type: "string" },
					port: { type: "integer", description: "端口号" },
				},
				required: ["name"],
			}),
		).toEqual([
			{ name: "name", type: "string", required: true },
			{ name: "port", type: "integer", description: "端口号", required: false },
		]);
	});

	test("参数顺序跟随 properties 声明顺序（不重排，UI 与 schema 一致）", () => {
		const params = toolParamsFromSchema({
			type: "object",
			properties: {
				zeta: { type: "string" },
				alpha: { type: "number" },
			},
		});
		expect(params?.map((p) => p.name)).toEqual(["zeta", "alpha"]);
	});

	test("type 为联合数组时拼成可读文本", () => {
		expect(
			toolParamsFromSchema({
				type: "object",
				properties: { session: { type: ["string", "null"] } },
			}),
		).toEqual([{ name: "session", type: "string | null", required: false }]);
	});

	test("无 type 的参数不虚构类型：type 缺省为空串（调用方决定是否展示）", () => {
		expect(
			toolParamsFromSchema({
				type: "object",
				properties: { any: { description: "任意值" } },
			}),
		).toEqual([{ name: "any", type: "", description: "任意值", required: false }]);
	});

	test("非字符串 description 忽略（不把对象塞进 UI）", () => {
		expect(
			toolParamsFromSchema({
				type: "object",
				properties: { x: { type: "string", description: { bad: true } } },
			}),
		).toEqual([{ name: "x", type: "string", required: false }]);
	});

	test("拿不到 properties → undefined（不虚构空参数块）", () => {
		expect(toolParamsFromSchema(undefined)).toBeUndefined();
		expect(toolParamsFromSchema(null)).toBeUndefined();
		expect(toolParamsFromSchema("nope")).toBeUndefined();
		expect(toolParamsFromSchema({})).toBeUndefined();
		expect(toolParamsFromSchema({ type: "object" })).toBeUndefined();
		expect(toolParamsFromSchema({ type: "object", properties: {} })).toBeUndefined();
		expect(toolParamsFromSchema({ type: "object", properties: [] })).toBeUndefined();
	});

	test("required 非字符串元素忽略，不污染必填判定", () => {
		expect(
			toolParamsFromSchema({
				type: "object",
				properties: { a: { type: "string" }, b: { type: "string" } },
				required: ["a", 42, null],
			}),
		).toEqual([
			{ name: "a", type: "string", required: true },
			{ name: "b", type: "string", required: false },
		]);
	});
});
