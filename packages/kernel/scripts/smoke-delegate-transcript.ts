#!/usr/bin/env bun
// 任务 5 真实冒烟：delegate 全链路（真起 pi 子进程，不 mock 任何环节）。
//
// 链路：makeDelegateTool → makeSpawnFn → subagent-runner → `pi --mode rpc --session <jsonl>`。
// 验证（缺一不可，任一不过即非零退出）：
//   ① 返回文本是 XML，且 <agent_id> 能正则出 a + 8 位 hex
//   ② <transcript> 指向的 jsonl 真实存在且非空
//   ③ details.subagents[0].status === "completed"
//   ④ meta.status === "completed"、meta.agentId 与返回一致、meta.usage.total > 0
//   ⑤ jsonl 里含 thinking + toolCall + text 三类块
//
// 用法：bun run packages/kernel/scripts/smoke-delegate-transcript.ts
// 注意：真实调用模型（约 30-60 秒、消耗少量 token），并写入正式 WA_PI_DIR 的
//       subagents/s-smoke/（父会话 id 固定 s-smoke，便于识别与清理；任务 6 会补 --resume 模式）。
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { SubagentDetails } from "@wa-pi/shared";
import { GENERATED_DIR, SUBAGENT_TYPES, WA_PI_DIR } from "@wa-pi/shared";
import { makeDelegateTool, makeSpawnFn } from "../src/delegate-tool";
import { mcpAdapterExtensionPath } from "../src/extensions";
import { ensureProviderExtensionRegistered } from "../src/provider-extension";
import { ProviderStore } from "../src/provider-store";
import { readMeta } from "../src/subagent-instance-store";
import { readBuiltinAgentPrompt } from "../src/subagent-info";
import type { WaPiSpawnConfig } from "../src/subagent-runner";

/** 冒烟用的父会话 id：落盘目录固定为 <WA_PI_DIR>/subagents/s-smoke/ */
const SID = "s-smoke";

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
	console.log(`model=${model}  WA_PI_DIR=${WA_PI_DIR}`);

	const t0 = Date.now();
	const r = await tool.execute("call_smoke", {
		tasks: [
			{
				agent: "Explore",
				task: "列出 packages 目录，一句话说明每个包。必须调用工具。",
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
	const checks: Array<[string, boolean]> = [
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
