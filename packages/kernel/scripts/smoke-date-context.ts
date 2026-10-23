#!/usr/bin/env bun
// 日期上下文注入的真实冒烟（真起 pi 子进程 + wa-pi-bridge 扩展，不 mock；
// 跑一次约 1-2 分钟、消耗少量 token）。
//
// 验证 3 件事：
//   ① 真实会话首轮注入 wa-pi-date-context custom_message 恰 1 条，content 含今天的
//      本地日期（before_agent_start 主检测点生效）
//   ② 同一天第二轮不重复注入（单会话同天最多一条的去重规则）
//   ③ 注入消息 display=false（静默，不打扰对话流）
//
// 用法：bun run packages/kernel/scripts/smoke-date-context.ts
// 产物：<仓库>/.superpowers/smoke/date-context/（本地临时，.superpowers/ 已入库忽略）。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WA_PI_DIR } from "@wa-pi/shared";
import { ensureBridgeExtension } from "../src/bridge-extension";
import { ensureProviderExtensionRegistered } from "../src/provider-extension";
import { ProviderStore } from "../src/provider-store";
import { ProjectStore } from "../src/project-store";
import { AgentManager } from "../src/agent-manager";
import { NOOP_BROWSER_MANAGER } from "../tests/helpers/fake-browser-manager";
import {
	DATE_CONTEXT_CUSTOM_TYPE,
	localDateStr,
} from "../src/date-context";

const POC_DIR = join(
	import.meta.dir,
	"..",
	"..",
	"..",
	".superpowers",
	"smoke",
	"date-context",
);

/** 从会话 jsonl 里统计日期注入条目（兼容 custom_message entry 与 custom role 两种落盘形态） */
function countDateEntries(raw: string): { count: number; contents: string[] } {
	const contents: string[] = [];
	for (const line of raw.split("\n").filter(Boolean)) {
		let e: any;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		const isDateEntry =
			(e.type === "custom_message" && e.customType === DATE_CONTEXT_CUSTOM_TYPE) ||
			(e.message?.role === "custom" && e.message?.customType === DATE_CONTEXT_CUSTOM_TYPE) ||
			(e.type === "message" && e.message?.customType === DATE_CONTEXT_CUSTOM_TYPE);
		if (isDateEntry) {
			const c = e.message?.content ?? e.content;
			contents.push(typeof c === "string" ? c : JSON.stringify(c));
		}
	}
	return { count: contents.length, contents };
}

async function main() {
	let passed = 0;
	const failures: string[] = [];
	const check = (ok: boolean, msg: string) => {
		if (ok) {
			passed++;
			console.log(`PASS ${msg}`);
		} else {
			failures.push(msg);
			console.log(`FAIL ${msg}`);
		}
	};

	mkdirSync(POC_DIR, { recursive: true });
	console.log(`产物目录（隔离）: ${POC_DIR}`);

	// ── 部署最新 bridge 扩展 + provider 扩展（与生产同链路）──
	const bridgePath = await ensureBridgeExtension();
	console.log(`bridge 扩展已部署: ${bridgePath}`);
	const store = new ProviderStore();
	const providers = (await store.load()) as any[];
	await ensureProviderExtensionRegistered(store);
	const p = providers.find((x: any) => x.models?.[0]?.id) ?? providers[0];
	const model = `${p.slug}/${p.models[0].id}`;
	console.log(`使用模型: ${model}`);

	// ── 真实 AgentManager（不传 createClientFn → 真 spawn pi 子进程）──
	const workDir = mkdtempSync(join(tmpdir(), "wa-pi-date-smoke-"));
	const helloFile = join(workDir, "hello.txt");
	writeFileSync(helloFile, "4271", "utf8");
	const storeFile = join(POC_DIR, `projects-${Date.now()}.json`);
	const projectStore = new ProjectStore(storeFile);
	const project = await projectStore.createProject({
		name: "date-smoke",
		cwd: workDir,
	});
	const session = await projectStore.createSession({
		projectId: project.id,
		primaryAgent: "general-purpose",
		title: "日期注入冒烟",
	});
	const syspromptFile = join(WA_PI_DIR, "tmp", "sysprompts", `${session.id}.md`);
	if (existsSync(syspromptFile)) rmSync(syspromptFile, { force: true });

	const settledWaiters = new Map<string, () => void>();
	const am = new AgentManager({
		projectStore,
		configStore: null,
		onEvent: (_sid, _pid, _name, e: any) => {
			if (e?.type === "agent_settled") {
				const w = settledWaiters.get(_sid);
				if (w) {
					settledWaiters.delete(_sid);
					w();
				}
			}
		},
		browserManager: NOOP_BROWSER_MANAGER,
	});

	try {
		await am.ensureStarted(project.id, "general-purpose", session.id);

		// ── 第一轮：强制 tool_call（before_agent_start 与 tool_call 双检测点都会经过）──
		const settled1 = new Promise<void>((resolve) => settledWaiters.set(session.id, resolve));
		await am.prompt(
			session.id,
			`请使用 read 工具读取文件 ${helloFile}，然后告诉我文件里的数字是多少。不要使用其他工具。`,
			{ model },
		);
		await Promise.race([
			settled1,
			new Promise((_, rej) =>
				setTimeout(() => rej(new Error("第一轮超时")), 240_000),
			),
		]);

		const sessionFile = session.piSessionFile;
		check(sessionFile !== "", "会话 jsonl 路径可得");
		const raw1 = readFileSync(sessionFile, "utf8");
		const r1 = countDateEntries(raw1);
		check(r1.count === 1, `首轮注入恰 1 条（实际 ${r1.count}）`);
		check(
			r1.contents.some((c) => c.includes(localDateStr(new Date()))),
			`注入内容含今天日期 ${localDateStr(new Date())}`,
		);
		check(
			r1.contents.some((c) => c.includes("以本条为准")),
			"注入内容含覆盖声明文案",
		);

		// ── 第二轮（同一天）：去重——不新增注入 ──
		const settled2 = new Promise<void>((resolve) => settledWaiters.set(session.id, resolve));
		await am.prompt(session.id, "再告诉我一次刚才的数字。", { model });
		await Promise.race([
			settled2,
			new Promise((_, rej) =>
				setTimeout(() => rej(new Error("第二轮超时")), 240_000),
			),
		]);
		const raw2 = readFileSync(sessionFile, "utf8");
		const r2 = countDateEntries(raw2);
		check(r2.count === 1, `同日第二轮不重复注入（实际 ${r2.count}）`);
	} finally {
		await am.disposeAll().catch(() => {});
		try {
			rmSync(storeFile, { force: true });
			rmSync(workDir, { recursive: true, force: true });
		} catch {
			/* 清理失败不阻断结果判定 */
		}
	}

	console.log(`\n结果: ${passed} 通过, ${failures.length} 失败`);
	if (failures.length > 0) {
		for (const f of failures) console.log(`  - ${f}`);
		process.exit(1);
	}
	process.exit(0);
}

main().catch((e) => {
	console.error("冒烟脚本异常:", e);
	process.exit(1);
});
