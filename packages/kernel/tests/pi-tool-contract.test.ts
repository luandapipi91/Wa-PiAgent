// pi 工具结果契约回执测试（真 pi，锁 pi 1.5.2，供后续升级比对）。
//
// 思路：不经真 LLM——本地起一个假 OpenAI SSE 服务器（openai-completions 协议），
// 第一轮固定返回一批 tool calls，pi 真实执行内置工具后，从 RPC 事件流抓
// tool_execution_end 的原始 result，逐条锁五条上游契约：
//   1. grep 的 glob 以 path 参数为基准（而非 pi 启动目录）
//   2. grep 上下文行格式：匹配行 "<path>:<no>: <text>"、上下文行 "<path>-<no>- <text>"
//   3. find limit: 0 → 恰好 1 条结果 + limit 提示行
//   4. edit 多段修改 → details.diff 含 ≥2 条省略行，且 parseEditDiff 行号单调递增
//   5. read 尾部提示逐字文案（含 offset 越界的 isError 分支）
//
// 全部断言语义以 pi 1.5.2 探针实测为准（探针输出样例见 task-3-report.md），
// 与 pi 1.5.2 默认工具集相关：DEFAULT_TOOL_NAMES 只有 read/bash/edit/write，
// grep/find 必须经 --tools 白名单显式开启，spawn 参数不可省。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// parseEditDiff 是 frontend 对 pi diff 格式的解析器（kernel 无此导出）；
// 跨包 import 锁住「上游 diff 格式 ↔ frontend 解析器」的兼容契约。
import { parseEditDiff } from "../../frontend/src/components/blocks/EditDiffView";
import { ProviderStore } from "../src/provider-store";
import { ensureProviderExtensionRegistered } from "../src/provider-extension";
import { RpcClient, buildPiArgs, resolvePiCliPath, resolvePiRuntime } from "../src/rpc-client";

// ---- 假 OpenAI SSE 响应构造 ----

function sseChunk(delta: any, finish: string | null): string {
	return `data: ${JSON.stringify({
		id: "chatcmpl-contract",
		object: "chat.completion.chunk",
		created: 1700000000,
		model: "test-model",
		choices: [{ index: 0, delta, finish_reason: finish }],
	})}\n\n`;
}

/** tool_execution_end 的文本输出（content 里的 text 块拼接） */
function textOf(e: any): string {
	const blocks = e?.result?.content;
	return Array.isArray(blocks)
		? blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n")
		: "";
}

describe("pi 工具结果契约（真 pi --mode rpc）", () => {
	let baseDir = "";
	let client: RpcClient | null = null;
	let stopServer: (() => void) | null = null;
	let toolEnds: any[] = [];

	// 一次 spawn 跑完 10 个探针调用，全部 test 共享收集结果（bun test 同文件串行执行）。
	beforeAll(async () => {
		baseDir = await mkdtemp(join(tmpdir(), "pi-contract-"));
		const repo = join(baseDir, "repo");
		const nested = join(repo, "nested");
		await mkdir(nested, { recursive: true });

		// needle 铺在 a.ts 与 nested/deep.ts（glob=*.ts 应同时命中二者）；
		// b.md 也含 needle，用于证明 glob 过滤生效。
		await writeFile(join(repo, "a.ts"), "const needle = 1;\nexport default needle;\n");
		await writeFile(join(repo, "b.md"), "# needle in markdown\n");
		await writeFile(join(nested, "deep.ts"), "export const deep = true;\nconst needle = 2;\n");
		// 上下文行夹具：target 居第 5 行，前后各 ≥1 行
		await writeFile(
			join(repo, "ctx.txt"),
			["line1", "line2", "line3", "line4", "the target line", "line6", "line7", "line8"].join("\n") + "\n",
		);
		// 2100 行 + 末尾换行 → pi 计 totalFileLines=2101：默认 2000 行截断出
		// [Showing lines ...]，limit=5 出 [N more lines ...]
		const big = join(repo, "big.txt");
		const bigLines = Array.from({ length: 2100 }, (_, i) => `L${String(i + 1).padStart(4, "0")} content`);
		await writeFile(big, bigLines.join("\n") + "\n");
		// 60KB 单行（> 50KB 上限）→ [Line 1 is ... exceeds ...]
		const huge = join(repo, "huge.txt");
		await writeFile(huge, "X".repeat(60 * 1024) + "\n");
		// 40 行 3 处编辑（间隔 >8 行上下文窗口）→ diff 出 ≥2 条 "  ..." 省略行
		const editMe = join(repo, "edit-me.txt");
		const editLines = Array.from({ length: 40 }, (_, i) => `L${String(i + 1).padStart(2, "0")} original`);
		await writeFile(editMe, editLines.join("\n") + "\n");

		// 第一轮 tool calls：五条契约的探针输入（id 供 pi 关联，内容决定断言特征）
		const toolCalls = [
			{ name: "grep", args: { pattern: "needle", path: repo, glob: "*.ts" } },
			{ name: "grep", args: { pattern: "target", path: repo, glob: "ctx.txt", context: 1 } },
			{ name: "find", args: { pattern: "**/*", path: repo, limit: 0 } },
			{ name: "find", args: { pattern: "**/*.ts", path: repo } },
			{ name: "read", args: { path: big, offset: 1999, limit: 3 } },
			{ name: "read", args: { path: big } },
			{ name: "read", args: { path: big, limit: 5 } },
			{ name: "read", args: { path: huge } },
			{ name: "read", args: { path: big, offset: 5000 } },
			{
				name: "edit",
				args: {
					path: editMe,
					edits: [
						{ oldText: "L05", newText: "E5" },
						{ oldText: "L20", newText: "E20" },
						{ oldText: "L35", newText: "E35" },
					],
				},
			},
		];

		// 假 LLM：第一轮一次性返回全部 tool calls，之后正常收尾
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (!new URL(req.url).pathname.endsWith("/chat/completions")) {
					return new Response("not found", { status: 404 });
				}
				const body = (await req.json()) as any;
				const hasToolResults = (body.messages ?? []).some((m: any) => m.role === "tool");
				if (!hasToolResults) {
					let out = "";
					for (let i = 0; i < toolCalls.length; i++) {
						const tc = toolCalls[i];
						out += sseChunk(
							{
								tool_calls: [
									{ index: i, id: `call_${i + 1}`, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.args) } },
								],
							},
							null,
						);
					}
					out += sseChunk({}, "tool_calls");
					out += "data: [DONE]\n\n";
					return new Response(out, { headers: { "content-type": "text/event-stream" } });
				}
				let out = sseChunk({ content: "probes done" }, null) + sseChunk({}, "stop") + "data: [DONE]\n\n";
				return new Response(out, { headers: { "content-type": "text/event-stream" } });
			},
		});
		stopServer = () => server.stop(true);

		// 注册假 provider（与 pi-disconnect-experiment 同路：providers.json + 生成的扩展）
		const store = new ProviderStore(join(baseDir, "providers.json"));
		await store.save({
			id: "contract",
			name: "contract-provider",
			slug: "contract",
			baseUrl: `http://127.0.0.1:${server.port}/v1`,
			apiKey: "sk-contract",
			api: "openai-completions",
			models: [{ id: "test-model", contextWindow: 128000, maxTokens: 4096 }],
		});
		const generatedDir = join(baseDir, ".generated");
		await ensureProviderExtensionRegistered(store, generatedDir);

		// spawn 真 pi。cwd 用 baseDir（≠ path 参数指向的 repo），verify glob/path 基准不受
		// 启动目录影响；grep/find 不在 pi 1.5.2 默认工具集，必须 --tools 显式白名单。
		const events: any[] = [];
		client = new RpcClient({
			cliPath: resolvePiCliPath(),
			runtime: resolvePiRuntime(),
			args: buildPiArgs({
				noSession: true,
				noSkills: true,
				noContextFiles: true,
				tools: ["read", "grep", "find", "edit"],
				extensionPaths: [join(generatedDir, "provider-extension.ts")],
				model: "contract/test-model",
				thinking: "off",
			}),
			cwd: baseDir,
			env: { PI_CODING_AGENT_DIR: baseDir },
			onEvent: (e) => {
				events.push(e);
				if (e.type === "tool_execution_end") toolEnds.push(e);
			},
			commandTimeoutMs: 120_000,
		});
		await client.start();
		client.prompt("run contract probes").catch(() => {});

		// 终态等 agent_settled（命令 resolve 只表示 pi 收下了 prompt）
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("90s 内未等到 agent_settled")), 90_000);
			const poll = setInterval(() => {
				if (events.some((e) => e.type === "agent_settled")) {
					clearTimeout(timer);
					clearInterval(poll);
					resolve();
				}
			}, 300);
		});
	}, 120_000);

	afterAll(async () => {
		try {
			await client?.dispose();
		} catch {
			/* 进程可能已自行退出 */
		}
		stopServer?.();
		if (baseDir) await rm(baseDir, { recursive: true, force: true });
	}, 30_000);

	/** 按 toolName + 输出特征定位收集到的执行结果（并行完成顺序不定，不能按下标） */
	function findEnd(toolName: string, pred: (text: string, e: any) => boolean): any {
		const hit = toolEnds.find((e) => e.toolName === toolName && pred(textOf(e), e));
		expect(hit).toBeTruthy();
		return hit;
	}

	test("契约 1：grep 的 glob 以 path 参数为基准，路径相对 path 输出（而非 pi 启动目录）", () => {
		// pattern=needle 铺在 a.ts、nested/deep.ts（.ts）与 b.md（.md）。
		const e = findEnd("grep", (text) => text.includes("needle"));
		const text = textOf(e);
		// 命中 path 参数下的 .ts（含子目录递归），路径相对 path 输出
		expect(text).toContain("a.ts:1:");
		expect(text).toContain("nested/deep.ts:");
		// glob 过滤生效：.md 里的 needle 不得出现
		expect(text).not.toContain("b.md");
		// 结果不携带绝对路径，也不以 pi 启动目录为基准（基准若是启动目录，
		// repo/ 前缀或解析失败都会让上面的 toContain 落空）
		expect(text).not.toContain(baseDir);
		expect(text).not.toContain("repo/");
	});

	test("契约 2：grep 上下文行格式——匹配行 path:no: text，上下文行 path-no- text", () => {
		const e = findEnd("grep", (text) => text.includes("target"));
		// ctx.txt 第 5 行命中，context=1 → 逐字锁定三行
		expect(textOf(e).trim()).toBe(
			["ctx.txt-4- line4", "ctx.txt:5: the target line", "ctx.txt-6- line6"].join("\n"),
		);
	});

	test("契约 3：find limit: 0 → 恰好 1 条结果 + limit 提示行", () => {
		const e = findEnd("find", (_text, ev) => ev?.result?.details?.resultLimitReached != null);
		const text = textOf(e);
		const dataLines = text
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0 && !l.startsWith("["));
		// limit=0 仍返回 1 条（repo 下 **/* 实际命中多条，证明是 limit 在截断）
		expect(dataLines).toHaveLength(1);
		expect(e.result.details.resultLimitReached).toBe(1);
		expect(text).toContain("[1 results limit reached. Use limit=2 for more, or refine pattern]");
		// 对照：不带 limit 的 find 命中 >1 条（a.ts + nested/deep.ts），且路径相对 path
		const all = findEnd("find", (text) => !text.includes("limit reached"));
		const allText = textOf(all);
		expect(allText).toContain("a.ts");
		expect(allText).toContain("nested/deep.ts");
		expect(allText).not.toContain(baseDir);
	});

	test("契约 4：edit 多段修改 → details.diff 含 ≥2 条省略行，parseEditDiff 行号单调递增", () => {
		const e = findEnd("edit", (_text, ev) => typeof ev?.result?.details?.diff === "string");
		const diff = e.result.details.diff as string;
		expect(e.isError).toBe(false);
		// 三处编辑真实生效
		expect(diff).toContain("- 5 L05 original");
		expect(diff).toContain("+ 5 E5 original");
		// 间隔 >8 行的上下文段被折叠为省略行（40 行 3 处编辑实测 3 条）
		const gapLines = diff.split("\n").filter((l) => /^\s*\.\.\.$/.test(l));
		expect(gapLines.length).toBeGreaterThanOrEqual(2);

		// frontend 解析器兼容上游 diff 格式：行号双列各自严格递增
		const rows = parseEditDiff(diff);
		expect(rows.length).toBeGreaterThan(0);
		let prevOld = 0;
		let prevNew = 0;
		let gapCount = 0;
		for (const row of rows) {
			if (row.kind === "gap") {
				gapCount++;
				continue;
			}
			if (row.oldNo != null) {
				expect(row.oldNo).toBeGreaterThan(prevOld);
				prevOld = row.oldNo;
			}
			if (row.newNo != null) {
				expect(row.newNo).toBeGreaterThan(prevNew);
				prevNew = row.newNo;
			}
		}
		expect(gapCount).toBeGreaterThanOrEqual(2);
	});

	test("契约 5：read 尾部提示逐字文案（默认截断 / limit 提前停 / 首行超字节 / offset 越界）", () => {
		// 1) 无 offset/limit 读 2101 行文件 → 默认 2000 行截断
		// （谓词按目标文案特征定位：read 的多个结果都含 L0001，完成顺序不定）
		const full = findEnd("read", (text) => text.includes("Showing lines 1-2000 of 2101"));
		expect(textOf(full).endsWith("[Showing lines 1-2000 of 2101. Use offset=2001 to continue.]")).toBe(true);
		// details.truncation 记录截断元数据
		expect(full.result.details.truncation.truncatedBy).toBe("lines");

		// 2) 用户 limit=5 提前停 → N more lines 提示（2101 - 5 = 2096）
		const limited = findEnd("read", (text) => text.includes("[2096 more lines in file. Use offset=6 to continue.]"));
		expect(textOf(limited).startsWith("L0001 content")).toBe(true);

		// 3) offset+limit 窗口 → 同款 more-lines 提示，nextOffset = 窗口末行 + 1
		// （谓词锚定窗口末行 L2001：full 的 2000 行截断输出不含它，避免抓错对象）
		const windowed = findEnd("read", (text) => text.includes("L2001 content"));
		expect(textOf(windowed).endsWith("[100 more lines in file. Use offset=2002 to continue.]")).toBe(true);

		// 4) 首行超 50KB → bash 兜底指引（路径段为绝对路径，锚定骨架）
		const huge = findEnd("read", (text) => text.startsWith("[Line 1 is"));
		expect(textOf(huge)).toMatch(
			/^\[Line 1 is 60\.0KB, exceeds 50\.0KB limit\. Use bash: sed -n '1p' .+ \| head -c 51200\]$/,
		);

		// 5) offset 越界 → isError 结果 + 逐字文案
		const overflow = findEnd("read", (text) => text.includes("beyond end of file"));
		expect(overflow.isError).toBe(true);
		expect(textOf(overflow)).toBe("Offset 5000 is beyond end of file (2101 lines total)");
	});
});
