#!/usr/bin/env bun
// 子代理落盘的真实冒烟（真起 pi 子进程，不 mock；跑一次约 30-60 秒、消耗少量 token）。
//
// 验证 6 件事：
//   ① sessionFile 不存在时，pi 新建文件并写入首行（含 cwd —— resume 依赖它）
//   ② sessionFile 已存在时，pi 读回历史并往后追加（而非截断重建）
//   ③ 历史是真的被读回来了（记忆复述法：第一轮记 7391，第二轮问它）
//   ④ 转录含 thinking 原文
//   ⑤ 转录含 toolCall / toolResult
//   ⑥ 失败即非零退出（可挂进任务收尾检查）
//
// 用法：bun run packages/kernel/scripts/smoke-subagent-session.ts
// 产物：<仓库>/.superpowers/smoke/subagent-session/（本地临时，.superpowers/ 已入库忽略）；
//       越界写入的检查在脚本外部做（对比 ~/.pi/agent 的 sessions/、projects.json、telemetry）。
import { existsSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { WA_PI_DIR, GENERATED_DIR, SUBAGENT_TYPES } from "@wa-pi/shared";
import { runSubagentAgent } from "../src/subagent-runner";
import { ProviderStore } from "../src/provider-store";
import { ensureProviderExtensionRegistered } from "../src/provider-extension";
import { readBuiltinAgentPrompt } from "../src/subagent-info";

// 相对本 checkout 定位（而非写死绝对路径）：在 worktree 里跑也不会落到主工作区
const POC_DIR = join(
	import.meta.dir,
	"..",
	"..",
	"..",
	".superpowers",
	"smoke",
	"subagent-session",
);
const SESSION_FILE = join(POC_DIR, "a0000001.jsonl");
const MEMO = "7391";

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
		thinkingNonEmpty: asstBlocks.filter(
			(b) => b.type === "thinking" && String(b.thinking ?? "").trim(),
		).length,
		text: asstBlocks.filter((b) => b.type === "text").length,
		toolCall: allBlocks.filter((b) => b.type === "toolCall").length,
		toolResult: msgs.filter((e) => e.message?.role === "toolResult").length,
	};
}

async function main() {
	await mkdir(POC_DIR, { recursive: true });
	console.log(`产物目录（隔离）: ${POC_DIR}`);

	// ── provider 同步 + 子代理 config（等价内置 Explore）──
	const store = new ProviderStore();
	const providers = (await store.load()) as any[];
	await ensureProviderExtensionRegistered(store);
	const p = providers[0]!;
	const builtin = SUBAGENT_TYPES.find((t) => t.name === "Explore")!;
	const config: any = {
		name: builtin.name,
		description: builtin.description,
		systemPrompt: await readBuiltinAgentPrompt(join(WA_PI_DIR, "agents"), builtin.name),
		model: `${p.slug}/${p.models[0].id}`,
		thinking: "medium",
		tools: ["read", "bash", "grep", "find", "ls"],
		skills: [],
		skillsAllOff: true,
	};
	const providerExt = join(GENERATED_DIR, "provider-extension.ts");
	// 与生产 spawn 同构（agent-manager）：子进程只带 provider-extension；
	// MCP 由 pi 内置扩展（builtin:mcp，默认加载）在子进程内自行注册，不再注入第三方 adapter。
	const extensionPaths = [
		...(existsSync(providerExt) ? [providerExt] : []),
	];
	console.log(`model=${config.model}  extensions=${extensionPaths.length}`);

	// ===== ROUND 1：sessionFile 不存在 =====
	console.log("\n===== ROUND 1（sessionFile 不存在）=====");
	console.log("run 前 existsSync =", existsSync(SESSION_FILE));
	const t0 = Date.now();
	const r1 = await runSubagentAgent(
		config,
		`记住这个数字：${MEMO}。只回复“已记住”，不要做其它事。`,
		process.cwd(),
		{ sessionFile: SESSION_FILE, extensionPaths },
	);
	console.log(`isError=${r1.isError} elapsed=${Date.now() - t0}ms`);
	console.log("返回文本:", JSON.stringify(r1.text.slice(0, 120)));
	console.log("run 后 existsSync =", existsSync(SESSION_FILE));

	const raw1 = await readFile(SESSION_FILE, "utf8");
	const size1 = (await stat(SESSION_FILE)).size;
	const lines1 = raw1.split("\n").filter(Boolean);
	console.log("首行:", lines1[0]);
	console.log("轮1 统计:", JSON.stringify(blockStats(raw1)));

	// ===== ROUND 2：同 sessionFile，验证历史读回 + 追加 =====
	console.log("\n===== ROUND 2（同 sessionFile，验证读回与追加）=====");
	const r2 = await runSubagentAgent(
		config,
		"我刚才给你的那个四位数是多少？只回数字。",
		process.cwd(),
		{ sessionFile: SESSION_FILE, extensionPaths },
	);
	console.log(`isError=${r2.isError}`);
	console.log("返回文本:", JSON.stringify(r2.text.slice(0, 120)));

	const raw2 = await readFile(SESSION_FILE, "utf8");
	const size2 = (await stat(SESSION_FILE)).size;
	const lines2 = raw2.split("\n").filter(Boolean);

	console.log("\n===== 结论 =====");
	console.log(
		`① 新建 + 首行带 cwd: ${lines1[0]?.includes('"cwd"') ? "✅" : "❌"}  ${String(lines1[0]).slice(0, 140)}`,
	);
	console.log(
		`② 追加而非重建: ${lines1.length}→${lines2.length} 行, ${size1}→${size2} 字节  ${lines2.length > lines1.length ? "✅" : "❌"}`,
	);
	console.log(
		`③ 历史读回（复述 ${MEMO}）: ${r2.text.includes(MEMO) ? "✅ 复述成功" : "❌ 未复述"}`,
	);

	// ===== ROUND 3：要求用工具的任务，验证 toolCall / toolResult 落盘 =====
	console.log("\n===== ROUND 3（要求工具调用）=====");
	const r3 = await runSubagentAgent(
		config,
		"用 ls 工具列出 E:/workspace/Wa-Pi/packages 下的子目录名，原样回报，不要解释。",
		process.cwd(),
		{ sessionFile: SESSION_FILE, extensionPaths },
	);
	console.log(`isError=${r3.isError} text=${JSON.stringify(r3.text.slice(0, 120))}`);
	const raw3 = await readFile(SESSION_FILE, "utf8");
	const s3 = blockStats(raw3);
	console.log(`⑤ 工具调用落盘: toolCall=${s3.toolCall} toolResult=${s3.toolResult} ${s3.toolCall > 0 && s3.toolResult > 0 ? "✅" : "❌"}`);
	console.log(`⑥ 思考落盘（累计）: thinking=${s3.thinking} thinkingNonEmpty=${s3.thinkingNonEmpty} ${s3.thinking > 0 ? "✅" : "❌"}`);

	console.log(`④ 转录内容块（总计）: ${JSON.stringify(s3)}`);
	console.log(`   文件: ${SESSION_FILE}`);

	const ok =
		lines1[0]?.includes('"cwd"') === true &&
		lines2.length > lines1.length &&
		r2.text.includes(MEMO) &&
		s3.toolCall > 0 &&
		s3.toolResult > 0 &&
		s3.thinking > 0;
	console.log(ok ? "\n✅ 冒烟通过" : "\n❌ 冒烟未通过");
	if (!ok) process.exit(1);
}

main().catch((e) => {
	console.error("FAILED:", e);
	process.exit(1);
});
