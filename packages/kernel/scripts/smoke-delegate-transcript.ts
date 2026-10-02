#!/usr/bin/env bun
// 任务 5 真实冒烟：delegate 全链路（真起 pi 子进程，不 mock 任何环节）。
//
// 链路：makeDelegateTool → makeSpawnFn → subagent-runner → `pi --mode rpc --session <jsonl>`。
// 首轮（默认）验证（缺一不可，任一不过即非零退出）：
//   ① 返回文本是 XML，且 <agent_id> 能正则出 a + 8 位 hex
//   ② <transcript> 指向的 jsonl 真实存在且非空
//   ③ details.subagents[0].status === "completed"
//   ④ meta.status === "completed"、meta.agentId 与返回一致、meta.usage.total > 0
//   ⑤ jsonl 里含 thinking + toolCall + text 三类块
//
// 任务 6 续聊冒烟（--resume <agentId>）：验证 pi 真的把历史读回来了（记忆复述法）。
//   ① <resumed>true</resumed> 且 <agent_id> 与续聊目标一致
//   ② <transcript> 与首轮同一份 jsonl
//   ③ meta.resumeCount === 1 且 status === completed
//   ④ 同一份 jsonl 被追加（--min-lines 传首轮行数，断言行数 > 该值）
//   ⑤ --expect <子串>：返回文本复述出首轮记忆（如那个四位数）
//
// 用法：
//   bun run packages/kernel/scripts/smoke-delegate-transcript.ts
//   bun run packages/kernel/scripts/smoke-delegate-transcript.ts --task "记住这个数字：7391…"
//   bun run packages/kernel/scripts/smoke-delegate-transcript.ts --resume a1b2c3d4e \
//     --task "我给你的那个四位数是多少？只回数字。" --expect 7391 --min-lines 5
//
// 注意：真实调用模型（约 30-60 秒、消耗少量 token）。产物**不落真实 WA_PI_DIR**：
//       仅本进程把 process.env.WA_PI_DIR 指向 <仓库>/.superpowers/smoke/delegate-transcript/，
//       转录与 meta 落在该目录的 subagents/<SID>/ 下（跑完可整目录删除，不入库）。
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { SubagentDetails } from "@wa-pi/shared";
import { GENERATED_DIR, SUBAGENT_TYPES, WA_PI_DIR } from "@wa-pi/shared";
import { makeDelegateTool, makeSpawnFn } from "../src/delegate-tool";
import { mcpAdapterExtensionPath } from "../src/extensions";
import { ensureProviderExtensionRegistered } from "../src/provider-extension";
import { ProviderStore } from "../src/provider-store";
import { readMeta, jsonlPath } from "../src/subagent-instance-store";
import { readBuiltinAgentPrompt } from "../src/subagent-info";
import type { WaPiSpawnConfig } from "../src/subagent-runner";

/** 冒烟用的父会话 id：落盘目录固定为 <SMOKE_DIR>/subagents/s-smoke/ */
const SID = "s-smoke";

/** 隔离的产物目录（.superpowers/ 已在 .gitignore 里，不污染真实 WA_PI_DIR，也不入库） */
const SMOKE_DIR = join(
	import.meta.dir,
	"..",
	"..",
	"..",
	".superpowers",
	"smoke",
	"delegate-transcript",
);

/** 首轮默认任务（要求真调工具，才能让转录里三类块齐全） */
const DEFAULT_TASK =
	"列出 packages 目录，一句话说明每个包。必须调用工具。";

/** CLI 取值：--flag value（未给出返回 undefined） */
function argOf(flag: string): string | undefined {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

/** 转录块统计（与任务 3 的冒烟同款：数 thinking / toolCall / text 三类块） */
function blockStats(raw: string) {
	const lines = raw.split("\n").filter(Boolean);
	const entries = lines.map((l) => JSON.parse(l));
	const msgs = entries.filter((e) => e.type === "message");
	const allBlocks = msgs.flatMap((e) => (e.message?.content ?? []) as any[]);
	const asstBlocks = msgs
		.filter((e) => e.message?.role === "assistant")
		.flatMap((e) => (e.message.content ?? []) as any[]);
	return {
		lines: lines.length,
		messages: msgs.length,
		thinking: asstBlocks.filter((b) => b.type === "thinking").length,
		text: asstBlocks.filter((b) => b.type === "text").length,
		toolCall: allBlocks.filter((b) => b.type === "toolCall").length,
		toolResult: msgs.filter((e) => e.message?.role === "toolResult").length,
	};
}

async function main() {
	// 隔离产物：subagent-instance-store 与 delegate-tool 的快照目录都是**调用时**读
	// process.env.WA_PI_DIR（不在真实目录留孤儿）；shared 的 WA_PI_DIR 常量在模块加载时已
	// 固定，因此 agents/prompts/providers 仍指向真实配置，只有本次冒烟的落盘被改道。
	process.env.WA_PI_DIR = SMOKE_DIR;

	// ── provider-extension 同步（与 agent-manager 的 ensureExtension 同路径）──
	const store = new ProviderStore();
	await ensureProviderExtensionRegistered(store);
	const providers = (await store.load()) as any[];
	const p = providers[0]!;
	const providerExt = join(GENERATED_DIR, "provider-extension.ts");
	const mcp = mcpAdapterExtensionPath();

	// ── 内置 Explore 配置（等价 agent-manager 的 resolveSpawnConfig 内置分支）──
	const builtin = SUBAGENT_TYPES.find((t) => t.name === "Explore")!;
	const model = `${p.slug}/${p.models[0].id}`;
	const resolveConfig = async (name: string): Promise<WaPiSpawnConfig | null> => {
		if (name !== builtin.name) return null;
		return {
			name: builtin.name,
			description: builtin.description,
			systemPrompt: await readBuiltinAgentPrompt(
				join(WA_PI_DIR, "agents"),
				builtin.name,
			),
			model,
			thinking: "medium",
			tools: ["read", "bash", "grep", "find", "ls"],
			skills: [],
			skillsAllOff: true,
		};
	};

	const spawn = makeSpawnFn({
		resolveConfig,
		cwd: process.cwd(),
		extensionPaths: [
			...(existsSync(providerExt) ? [providerExt] : []),
			...(mcp ? [mcp] : []),
		],
	});
	const tool = makeDelegateTool({ askTo: [], sessionId: SID, spawn });

	// 任务 6 续聊冒烟：--resume <agentId> 续聊既有实例；--task 覆盖本轮任务；
	// --expect <子串> 断言返回文本含该子串（记忆复述）；--min-lines 断言 jsonl 行数下界（追加而非重建）
	const resumeId = argOf("--resume");
	const resumeMode = resumeId !== undefined;
	const task =
		argOf("--task") ??
		(resumeMode ? "我给你的那个四位数是多少？只回数字。" : DEFAULT_TASK);
	const expectText = argOf("--expect");
	const minLines = Number(argOf("--min-lines") ?? "0");
	console.log(
		`model=${model}  WA_PI_DIR=${WA_PI_DIR}  smokeDir=${SMOKE_DIR}  mode=${resumeMode ? `resume ${resumeId}` : "首轮"}`,
	);

	const t0 = Date.now();
	const r = await tool.execute("call_smoke", {
		tasks: [
			{
				agent: "Explore",
				task,
				...(resumeId ? { resume: resumeId } : {}),
			},
		],
	});
	const elapsed = Date.now() - t0;

	// ── 返回文本与 details ──
	const text = r.content[0].text;
	const agentId = /<agent_id>(a[0-9a-f]{8})<\/agent_id>/.exec(text)?.[1];
	const transcript = /<transcript>([^<]+)<\/transcript>/.exec(text)?.[1];
	const details = r.details as SubagentDetails;

	console.log(`\n耗时 ${elapsed}ms  isError=${r.isError}`);
	console.log("\n返回文本:\n", text.slice(0, 400));
	console.log("\nagentId:", agentId, "\ntranscript:", transcript);
	console.log("\ndetails:", JSON.stringify(details, null, 2).slice(0, 600));
	console.log(
		"\ndetails.subagents[0].jsonlPath:",
		details?.subagents?.[0]?.jsonlPath ?? "（无）",
	);

	// ── 转录文件与块统计 ──
	let fileOk = false;
	let stats: ReturnType<typeof blockStats> | null = null;
	if (transcript) {
		fileOk =
			existsSync(transcript) && (await stat(transcript)).size > 0;
		if (fileOk) stats = blockStats(await readFile(transcript, "utf8"));
	}
	console.log(
		`\n转录文件存在且非空: ${fileOk ? "✅" : "❌"} ${transcript ?? "（未给出路径）"}`,
	);
	if (stats) console.log("转录块统计:", JSON.stringify(stats));

	// ── meta（身份与终态）──
	const meta = agentId ? await readMeta(SID, agentId) : null;
	console.log("\nmeta:", JSON.stringify(meta, null, 2));

	// ── 逐条裁定（缺一不可）──
	const checks: Array<[string, boolean]> = resumeMode
		? [
				[
					"① 返回块 <resumed>true</resumed> 且 <agent_id> 与续聊目标一致",
					text.includes("<resumed>true</resumed>") && agentId === resumeId,
				],
				[
					"② <transcript> 与首轮同一份 jsonl",
					transcript === jsonlPath(SID, resumeId!),
				],
				[
					"③ meta.resumeCount === 1 且 status === completed",
					meta?.resumeCount === 1 && meta?.status === "completed",
				],
				[
					`④ 同一份 jsonl 被追加（行数 > ${minLines}）`,
					fileOk && (stats?.lines ?? 0) > minLines,
				],
				...(expectText
					? ([
							[
								`⑤ 返回文本复述出上一轮上下文（含「${expectText}」）`,
								text.includes(expectText),
							],
						] as Array<[string, boolean]>)
					: []),
			]
		: [
				[
					"① 返回文本是 XML 且 <agent_id> 为 a + 8 位 hex",
					typeof agentId === "string" &&
						text.startsWith("<subagent>") &&
						text.endsWith("</subagent>"),
				],
				["② <transcript> 指向的 jsonl 存在且非空", fileOk],
				[
					"③ details.subagents[0].status === completed",
					details?.subagents?.[0]?.status === "completed",
				],
				[
					"⑥ details.subagents[0].jsonlPath 与 <transcript> 一致且文件存在（前端门控的数据源）",
					details?.subagents?.[0]?.jsonlPath !== "" &&
						details?.subagents?.[0]?.jsonlPath === transcript &&
						fileOk,
				],
				[
					"④ meta 终态 + agentId 一致 + usage.total > 0",
					meta?.status === "completed" &&
						meta?.agentId === agentId &&
						(meta?.usage?.total ?? 0) > 0,
				],
				[
					"⑤ 转录含 thinking + toolCall + text 三类块",
					(stats?.thinking ?? 0) > 0 &&
						(stats?.toolCall ?? 0) > 0 &&
						(stats?.text ?? 0) > 0,
				],
			];
	console.log("");
	for (const [label, ok] of checks) console.log(`${ok ? "✅" : "❌"} ${label}`);
	const allOk = checks.every(([, ok]) => ok);
	console.log(allOk ? "\n✅ 冒烟通过" : "\n❌ 冒烟未通过");
	if (!allOk) process.exit(1);
}

main().catch((e) => {
	console.error("FAILED:", e);
	process.exit(1);
});
