/**
 * resolveSpawnTargets 优先级链单元测试
 *
 * 验证委派 spawn 时 model/thinking 的取值优先级（规格 §6.3）：
 * - 会话级委派覆盖（delegateModel/delegateThinking）有值时最高优先，覆盖
 *   override / agentConfig / current；
 * - null=跟随（未设置/显式重置）：内置 subagent 走 override → current；
 *   命名 agent 的 model 走 agentConfig.model → currentModel，thinking 只走
 *   agentConfig.thinking（不回退 currentThinking，钉住现状不回归）。
 * delegate 为 null 的行是任务 1「null=重置为跟随」写入路径的消费面。
 */
import { describe, expect, test } from "bun:test";
import type { ThinkingLevel } from "@wa-pi/shared";
import { resolveSpawnTargets } from "../agent-manager";

// 矩阵基线：全空输入（delegate/override/agentConfig/current 全部为 null=跟随）
const baseInput = {
	isNamedAgent: false,
	override: null as
		| { model?: string | null; thinking?: ThinkingLevel | null }
		| null,
	agentConfig: null as
		| { model?: string | null; thinking?: ThinkingLevel | null }
		| null,
	currentModel: null as string | null,
	currentThinking: null as ThinkingLevel | null,
	delegateModel: null as string | null,
	delegateThinking: null as ThinkingLevel | null,
};

describe("resolveSpawnTargets 内置 subagent 分支", () => {
	test("delegateModel 有值时无论 override.model/currentModel 是什么都返回它", () => {
		expect(
			resolveSpawnTargets({
				...baseInput,
				delegateModel: "d/m",
				override: { model: "o/m" },
				currentModel: "cur/m",
			}).model,
		).toBe("d/m");
		expect(
			resolveSpawnTargets({
				...baseInput,
				delegateModel: "d/m",
				currentModel: "cur/m",
			}).model,
		).toBe("d/m");
	});

	test("delegateThinking 有值时无论 override.thinking/currentThinking 是什么都返回它", () => {
		expect(
			resolveSpawnTargets({
				...baseInput,
				delegateThinking: "high",
				override: { thinking: "max" },
				currentThinking: "default",
			}).thinking,
		).toBe("high");
		expect(
			resolveSpawnTargets({
				...baseInput,
				delegateThinking: "high",
				currentThinking: "default",
			}).thinking,
		).toBe("high");
	});

	test("delegate=null 时 model 走 override.model → currentModel → null（现状行为）", () => {
		expect(
			resolveSpawnTargets({
				...baseInput,
				override: { model: "o/m" },
				currentModel: "cur/m",
			}).model,
		).toBe("o/m");
		expect(
			resolveSpawnTargets({ ...baseInput, currentModel: "cur/m" }).model,
		).toBe("cur/m");
		expect(resolveSpawnTargets({ ...baseInput }).model).toBe(null);
	});

	test("delegate=null 时 thinking 走 override.thinking → currentThinking → null（现状行为）", () => {
		expect(
			resolveSpawnTargets({
				...baseInput,
				override: { thinking: "max" },
				currentThinking: "default",
			}).thinking,
		).toBe("max");
		expect(
			resolveSpawnTargets({
				...baseInput,
				currentThinking: "default",
			}).thinking,
		).toBe("default");
		expect(resolveSpawnTargets({ ...baseInput }).thinking).toBe(null);
	});
});

describe("resolveSpawnTargets 命名 agent 分支", () => {
	test("delegateModel 有值时无论 agentConfig.model/currentModel 是什么都返回它", () => {
		expect(
			resolveSpawnTargets({
				...baseInput,
				isNamedAgent: true,
				delegateModel: "d/m",
				agentConfig: { model: "cfg/m" },
				currentModel: "cur/m",
			}).model,
		).toBe("d/m");
	});

	test("delegate=null 时 model 走 agentConfig.model → currentModel → null（现状行为）", () => {
		expect(
			resolveSpawnTargets({
				...baseInput,
				isNamedAgent: true,
				agentConfig: { model: "cfg/m" },
				currentModel: "cur/m",
			}).model,
		).toBe("cfg/m");
		expect(
			resolveSpawnTargets({
				...baseInput,
				isNamedAgent: true,
				currentModel: "cur/m",
			}).model,
		).toBe("cur/m");
		expect(
			resolveSpawnTargets({ ...baseInput, isNamedAgent: true }).model,
		).toBe(null);
	});

	test("delegate=null 时 thinking 只走 agentConfig.thinking；agentConfig.thinking=null 且 currentThinking='max' 仍返回 null（不回退，钉住现状）", () => {
		expect(
			resolveSpawnTargets({
				...baseInput,
				isNamedAgent: true,
				agentConfig: { thinking: "max" },
				currentThinking: "default",
			}).thinking,
		).toBe("max");
		expect(
			resolveSpawnTargets({
				...baseInput,
				isNamedAgent: true,
				agentConfig: { thinking: null },
				currentThinking: "max",
			}).thinking,
		).toBe(null);
	});

	test("delegateThinking 有值时覆盖 agentConfig.thinking（'high' 压过 'max'，行为变更点）", () => {
		expect(
			resolveSpawnTargets({
				...baseInput,
				isNamedAgent: true,
				delegateThinking: "high",
				agentConfig: { thinking: "max" },
			}).thinking,
		).toBe("high");
	});
});

describe("resolveSpawnTargets 全空输入", () => {
	test("全部为空 → { model: null, thinking: null }", () => {
		expect(resolveSpawnTargets({ ...baseInput })).toEqual({
			model: null,
			thinking: null,
		});
		expect(
			resolveSpawnTargets({
				...baseInput,
				isNamedAgent: true,
				agentConfig: {},
			}),
		).toEqual({ model: null, thinking: null });
	});
});
