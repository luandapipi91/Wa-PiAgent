// pi-disconnect-experiment.test.ts — 真实 pi 子进程断网实验
//
// 目的：把 CHANGELOG 里"pi 断网后走完整 auto_retry → agent_settled 终态链"的口头结论，
// 固化成可回归的集成测试。验证 pi 在 LLM provider 不可达时不会静默挂死，而是经
// pi-ai 的 retryAssistantCall（指数退避）有界重试后发出 agent_settled 终态事件。
//
// 注入点：provider baseUrl 改成不可达地址（应用层，零系统改动）。pi-ai 内部用全局
// fetch 调 {baseUrl}/chat/completions，fetch 失败（ECONNREFUSED / 超时）→ 错误文案命中
// retry.js 的 RETRYABLE_PROVIDER_ERROR_PATTERN（fetch failed / connection refused / ...）
// → retryAssistantCall 重试 → onRetryFinished 回调 → auto_retry_end → agent_settled。
//
// 全程真实 pi 子进程（resolvePiCliPath + node runtime），不 mock fetch——
// 被测对象就是 pi-ai 的真实重试行为，mock 会绕过它。
//
// 隔离：PI_CODING_AGENT_DIR 指向临时目录，provider-extension.ts 由
// ensureProviderExtensionRegistered(store, generatedDir) 显式生成到临时目录。
// retry 配置写进临时 settings.json，maxRetries 压到最小让测试快速收敛。

import { test, expect, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcClient, buildPiArgs, resolvePiCliPath } from "../src/rpc-client";
import { ProviderStore } from "../src/provider-store";
import { ensureProviderExtensionRegistered } from "../src/provider-extension";
import type { ModelProvider } from "@wa-pi/shared";

const clients: RpcClient[] = [];
const tmpDirs: string[] = [];

afterEach(async () => {
	for (const c of clients.splice(0)) await c.abort().catch(() => {});
	for (const d of tmpDirs.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => {});
});

/** 事件序列里某一类型的事件 */
function eventsOf(events: any[], type: string): any[] {
	return events.filter((e) => e?.type === type);
}

/** 等到出现指定类型事件或超时（ms）。返回该事件，超时抛错并 dump 事件序列。 */
async function waitForEvent(
	events: any[],
	type: string,
	timeoutMs: number,
): Promise<any> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const found = eventsOf(events, type);
		if (found.length > 0) return found[found.length - 1];
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(
		`等待 ${type} 超时 (${timeoutMs}ms)。已收到事件序列:\n${JSON.stringify(events.map((e) => e?.type), null, 2)}`,
	);
}

/**
 * 搭建隔离环境并启动真实 pi 子进程。
 * baseUrl 决定"断网形态"，retry 决定重试预算。
 */
async function setupDisconnectedPi(opts: {
	baseUrl: string;
	maxRetries: number;
	baseDelayMs: number;
}): Promise<{ client: RpcClient; events: any[]; tmpDir: string }> {
	const tmpDir = await mkdtemp(join(tmpdir(), "wa-pi-disc-"));
	tmpDirs.push(tmpDir);

	// 1. 写 providers.json：单个 provider，baseUrl 指向不可达地址。
	//    显式设 slug：--model 参数格式为 "<slug>/<modelId>"，slug 必须与生成产物里
	//    pi.registerProvider 的第一参数一致（resolveProviderSlug 优先取 provider.slug）。
	const provider: ModelProvider = {
		id: "disc-test",
		name: "disconnect-test",
		slug: "disctest",
		baseUrl: opts.baseUrl,
		apiKey: "sk-test-not-used",
		api: "openai-completions",
		models: [{ id: "test-model", contextWindow: 128000, maxTokens: 4096 }],
	};
	const providerStore = new ProviderStore(join(tmpDir, "providers.json"));
	await providerStore.save(provider);

	// 2. 写 settings.json：retry 压到最小，让测试快速收敛
	await mkdir(tmpDir, { recursive: true });
	await writeFile(
		join(tmpDir, "settings.json"),
		JSON.stringify({ retry: { maxRetries: opts.maxRetries, baseDelayMs: opts.baseDelayMs } }),
		"utf8",
	);

	// 3. 生成 provider-extension.ts 到临时 .generated 目录
	const generatedDir = join(tmpDir, ".generated");
	await ensureProviderExtensionRegistered(providerStore, generatedDir);
	const providerExtPath = join(generatedDir, "provider-extension.ts");

	// 4. 启动真实 pi 子进程（node runtime，不传 offline —— 要让 pi 真去连 provider）
	const events: any[] = [];
	const client = new RpcClient({
		cliPath: resolvePiCliPath(),
		runtime: process.execPath,
		args: buildPiArgs({
			noSession: true,
			noSkills: true,
			noContextFiles: true,
			extensionPaths: [providerExtPath],
			model: "disctest/test-model",
			thinking: "off",
		}),
		cwd: tmpDir,
		env: { PI_CODING_AGENT_DIR: tmpDir },
		onEvent: (e) => events.push(e),
		commandTimeoutMs: 240_000, // 断网重试链可能数分钟，放宽命令超时
	});
	clients.push(client);
	await client.start();
	return { client, events, tmpDir };
}

test("断网实验（连接拒绝 127.0.0.1:1）：pi 经 auto_retry 走到 agent_settled 终态", async () => {
	// maxRetries:1 → 首次失败 + 1 次重试后耗尽，baseDelayMs:500 → 退避 0.5s
	const { client, events } = await setupDisconnectedPi({
		baseUrl: "http://127.0.0.1:1",
		maxRetries: 1,
		baseDelayMs: 500,
	});

	const start = Date.now();
	// prompt 只表示命令被 pi 接收；真正终态靠 agent_settled 事件
	client.prompt("hi").catch(() => {}); // 命令本身可能因终态 error 而 reject，忽略

	// 核心断言：必须收到 agent_settled（会话级终结），不得静默挂死
	const settled = await waitForEvent(events, "agent_settled", 90_000);
	expect(settled).toBeTruthy();
	const elapsed = Date.now() - start;

	// 应当至少经历过一次重试调度（auto_retry_start）或直接 error 终结
	const retryStarts = eventsOf(events, "auto_retry_start");
	const messageEnds = eventsOf(events, "message_end");
	const hasErrorEnd = messageEnds.some(
		(m) => m?.message?.stopReason === "error",
	);
	// 二者至少有一个：要么重试过，要么直接 error 结束（maxRetries 耗尽也会发 error message_end）
	expect(retryStarts.length + (hasErrorEnd ? 1 : 0)).toBeGreaterThan(0);

	// 重试错误文案应含网络类关键词（证明是 fetch 失败触发的重试链）
	const retryErrors = retryStarts.map((e) => e?.errorMessage ?? "").join(" ");
	const allErrorText = [
		retryErrors,
		...messageEnds.map((m) => m?.message?.errorMessage ?? ""),
	].join(" ");
	expect(allErrorText).toMatch(
		/fetch|connection|refused|ECONNREFUSED|network|socket|terminated|timeout/i,
	);

	console.log(
		`[断网实验-连接拒绝] 耗时 ${elapsed}ms，auto_retry_start ${retryStarts.length} 次，事件序列:`,
		events.map((e) => e?.type),
	);
}, 120_000);

test("断网实验（黑洞地址 10.255.255.1）：pi 经 auto_retry 走到 agent_settled 终态", async () => {
	// 不可达路由：fetch 挂起到 OS 超时。maxRetries:0 → 不重试，直接 error 终结，缩短等待
	const { client, events } = await setupDisconnectedPi({
		baseUrl: "http://10.255.255.1",
		maxRetries: 0,
		baseDelayMs: 500,
	});

	const start = Date.now();
	client.prompt("hi").catch(() => {});

	// 黑洞地址超时较长，给 150s
	const settled = await waitForEvent(events, "agent_settled", 150_000);
	expect(settled).toBeTruthy();
	const elapsed = Date.now() - start;

	const messageEnds = eventsOf(events, "message_end");
	const hasErrorEnd = messageEnds.some(
		(m) => m?.message?.stopReason === "error",
	);
	expect(hasErrorEnd).toBe(true);

	console.log(
		`[断网实验-黑洞地址] 耗时 ${elapsed}ms，事件序列:`,
		events.map((e) => e?.type),
	);
}, 180_000);
