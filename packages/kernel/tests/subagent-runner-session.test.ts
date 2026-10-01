import { describe, expect, test } from "bun:test";
import { buildSubagentPiArgs } from "../src/subagent-runner";

// 子代理落盘开关（规格 §5）：sessionFile 存在 → --session；否则回退 --no-session。
// 真实冒烟见 scripts/smoke-subagent-session.ts（真起 pi 子进程验证 pi 行为）。
describe("子代理 pi 参数：落盘开关", () => {
	test("传 sessionFile 时用 --session，且不再出现 --no-session", () => {
		const args = buildSubagentPiArgs({
			sessionFile: "C:/tmp/subagents/sid/a3f8c1d0.jsonl",
			config: { name: "Explore", tools: [], model: null, thinking: null },
		});
		expect(args).toContain("--session");
		expect(args[args.indexOf("--session") + 1]).toBe(
			"C:/tmp/subagents/sid/a3f8c1d0.jsonl",
		);
		expect(args).not.toContain("--no-session");
	});

	test("未传 sessionFile 时回退 --no-session（防御式，正常调用路径必传）", () => {
		const args = buildSubagentPiArgs({
			config: { name: "Explore", tools: [], model: null, thinking: null },
		});
		expect(args).toContain("--no-session");
		expect(args).not.toContain("--session");
	});

	test("落盘与工具白名单共存：--session 与 --tools 同时出现", () => {
		const args = buildSubagentPiArgs({
			sessionFile: "C:/tmp/x.jsonl",
			config: { name: "Explore", tools: ["read", "grep"], model: null, thinking: null },
		});
		expect(args).toContain("--session");
		expect(args[args.indexOf("--tools") + 1]).toBe("read,grep");
	});

	test("子代理仍不带技能自动发现（--no-skills 常驻）", () => {
		const args = buildSubagentPiArgs({
			sessionFile: "C:/tmp/x.jsonl",
			config: { name: "Explore", tools: [], model: null, thinking: null },
		});
		expect(args).toContain("--no-skills");
	});

	test("model 原样透传为 'provider/modelId'，不落盘时也一样", () => {
		const args = buildSubagentPiArgs({
			sessionFile: "C:/tmp/x.jsonl",
			config: {
				name: "Explore",
				tools: [],
				model: "deepseek/deepseek-v4-flash",
				thinking: null,
			},
		});
		expect(args[args.indexOf("--model") + 1]).toBe("deepseek/deepseek-v4-flash");
	});
});
