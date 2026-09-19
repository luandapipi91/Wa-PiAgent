#!/usr/bin/env bun
// eval-prompt-budget.ts — 委派相关提示词 token 预算测量（goal ②的「测量脚本为准」）
//
// 测量范围（与 goal ②一致）：
//   ① DELEGATE_DESCRIPTION（delegate 工具描述）
//   ② FLEET_DESCRIPTION（fleet 工具描述）
//   ③ 系统提示词中委派描述部分 = delegate-mechanism 段 + delegate-roster 注入段（## Available Subagents）
//
// 口径：CJK 字符（含中文标点/全角）≈1 token，其余 4 字符 ≈1 token。
//
// 用法：
//   bun run scripts/eval-prompt-budget.ts            # 默认预算 600，超预算退出码 1
//   bun run scripts/eval-prompt-budget.ts --budget 700
//   bun run scripts/eval-prompt-budget.ts --json     # 机器可读输出
//
// 说明：roster 用 buildDelegateRoster([], {}, <agentsDir>) 的口径（内置 general-purpose/Explore/Plan），
// 与 eval-delegate-trigger 的组合方式一致；生产若配置了命名智能体，roster 段会随各智能体的简介/hints 增长。

import { join } from "node:path";
import { PROMPTS_FILE, WA_PI_DIR } from "@wa-pi/shared";
import {
	DELEGATE_DESCRIPTION,
	FLEET_DESCRIPTION,
} from "@wa-pi/shared/tool-schemas";
import {
	ensurePromptsConfig,
	loadPromptSegments,
	DEFAULT_PROMPT_SEGMENTS,
	DEFAULT_DELEGATE_MECHANISM_PROMPT,
} from "../src/system-prompt";
import { buildDelegateRoster } from "../src/delegate-tool";

/** token 估算口径：CJK≈1 tok、其余 4 字符≈1 tok */
export function estTokens(s: string): number {
	if (!s) return 0;
	const cjk = (s.match(/[\u4e00-\u9fff\u3000-\u303f\uff01-\uff5e]/g) || [])
		.length;
	return Math.round(cjk + (s.length - cjk) / 4);
}

const argv = process.argv.slice(2);
const jsonOut = argv.includes("--json");
let budget = 600;
const bi = argv.indexOf("--budget");
if (bi >= 0 && argv[bi + 1]) budget = parseInt(argv[bi + 1]!, 10);

await ensurePromptsConfig(PROMPTS_FILE);
const segments =
	(await loadPromptSegments(PROMPTS_FILE)) ?? DEFAULT_PROMPT_SEGMENTS;
const mechanism =
	segments.find((s) => s.id === "delegate-mechanism")?.content ??
	DEFAULT_DELEGATE_MECHANISM_PROMPT;
const roster = buildDelegateRoster([], {}, join(WA_PI_DIR, "agents"));

const parts = {
	delegate: estTokens(DELEGATE_DESCRIPTION),
	fleet: estTokens(FLEET_DESCRIPTION),
	mechanism: estTokens(mechanism),
	roster: estTokens(roster),
};
const total = parts.delegate + parts.fleet + parts.mechanism + parts.roster;

if (jsonOut) {
	console.log(
		JSON.stringify(
			{
				budget,
				parts,
				total,
				ok: total <= budget,
				chars: {
					delegate: DELEGATE_DESCRIPTION.length,
					fleet: FLEET_DESCRIPTION.length,
					mechanism: mechanism.length,
					roster: roster.length,
				},
			},
			null,
			2,
		),
	);
} else {
	console.log("=== 委派相关提示词 token 预算（口径：CJK≈1、其余 4 字符≈1）===");
	console.log(`DELEGATE_DESCRIPTION : ${parts.delegate} tok`);
	console.log(`FLEET_DESCRIPTION    : ${parts.fleet} tok`);
	console.log(`系统·delegate-mechanism: ${parts.mechanism} tok`);
	console.log(`系统·delegate-roster   : ${parts.roster} tok`);
	console.log(`合计                  : ${total} tok（预算 ${budget}）`);
	console.log(total <= budget ? "✓ 未超预算" : `✗ 超预算 ${total - budget} tok`);
}

process.exit(total <= budget ? 0 : 1);
