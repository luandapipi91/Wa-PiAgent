// 知识库 markdown 副本 API 层端到端冒烟（任务 12 收尾）：
// 真实 kernel HTTP 服务（REST 建库 → 异步索引管线 → SSE 广播路径）+ 真实 embedding 模型
// （WA_PI_MODEL_DIR 指向预置模型；缺失时 embedder 现场从 hf-mirror 下载，ready 轮询需放宽），
// 索引就绪后在测试进程内调 searchKnowledge / readKnowledge（与 agent 工具同函数；
// 每库 db WAL 模式，服务进程持写连接、本进程只读查询，跨进程并发安全）断言全链路指向副本。
//
// 为什么走 API 层而非真浏览器（简报退路）：本 worktree 的 playwright-core@1.65.0 需要
// chromium-1254（本机仅 1234/1248，需下载浏览器二进制）；且检索/读取断言无 UI 通路
// （REST 无 search/read 端点、前端无检索界面），真浏览器增量仅为既有 smoke spec 已覆盖
// 的建库流程。UI 链路由 knowledge-e2e-smoke.spec.ts 单独覆盖。
//
// 夹具（tests/fixtures/knowledge-convert/，真实样本）：
//   · docx-altchunk.docx —— altChunk 引用 MHT 的真实导出 docx（MHT 正文含「查询对象」，
//     含 1 个 image part）→ 走 md 副本转换 + 图片外联 _assets
//   · pdf-scanned.pdf —— 真实扫描件 → 验证混合源目录索引不炸（转换/降级路径在真实服务走通）
//   · 使用指南.md —— 测试写入的原生 md（passthrough 副本；用独立主题词避免与检索词混淆）
//
// 查询向量注入 fake（embedQueryFn）：Bun 1.4.4 在本进程跑过 onnx 推理后，退出阶段
// onnxruntime 全局清理会 C++ panic（Abort trap 6，已知运行时 bug，显式 unload 也不避开）
// ——测试进程零 onnx 是唯一能干净退出的形态。语义真实性保留在索引侧：服务进程用真模型
// embedDocuments 落库；查询侧命中由 hybrid 检索的 BM25 词法锚定保证（中文 bigram 强命中）。
// 断言核心（hit.filePath .md 结尾 / 文件存在 / 副本内容）不依赖语义分数。
import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { Database } from "bun:sqlite";
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KB_SCHEMA_SQL, type KbContext } from "../src/knowledge/index";
import { mirrorDirFor } from "../src/knowledge/mirror";
import { KnowledgeStore } from "../src/knowledge/store";
import { readKnowledge } from "../src/knowledge/read";
import { searchKnowledge } from "../src/knowledge/search";
import { EMBED_DIM } from "../src/memory/embedder";

const FIX = join(import.meta.dir, "fixtures/knowledge-convert");
// 预置模型目录（Xenova/bge-base-zh-v1.5 q8）；不存在则 kernel 现场从 hf-mirror 下载到
// WA_PI_DIR/models（首次多等几分钟）。可用 WA_PI_E2E_MODEL_DIR 覆盖。
const MODEL_DIR =
	process.env.WA_PI_E2E_MODEL_DIR || "/tmp/wa-pi-mdmirror-models/models";
// 服务端口：高位随机段避免与本机真实 kernel（9776）冲突；可用 WA_PI_E2E_PORT 固定。
const PORT = Number(process.env.WA_PI_E2E_PORT) || 18000 + (process.pid % 2000);

const BASE = `http://127.0.0.1:${PORT}`;

/** 确定性 fake 查询向量：避开测试进程内 onnx 推理（见文件头）；BM25 词法锚定保证命中 */
const fakeQueryEmbed = async () => new Uint8Array(EMBED_DIM).fill(128);

async function api(method: string, path: string, body?: unknown): Promise<any> {
	const res = await fetch(`${BASE}${path}`, {
		method,
		headers: body !== undefined ? { "content-type": "application/json" } : undefined,
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	const data = (await res.json().catch(() => ({}))) as any;
	if (!res.ok) {
		throw new Error(`REST ${method} ${path} 失败(${res.status}): ${JSON.stringify(data)}`);
	}
	return data;
}

/** REST 轮询直到条件满足 */
async function pollRest<T>(
	fn: () => Promise<T | undefined | null | false>,
	timeoutMs: number,
	intervalMs = 500,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() > deadline) throw new Error("pollRest 超时");
		await new Promise((r) => setTimeout(r, intervalMs));
	}
}

let waPiDir = "";
let srcDir = "";
let kernel: ChildProcess | null = null;
let reg: Database | null = null;
let ctx: KbContext | null = null;
let kbId = "";

/** mirror 目录下递归收集 _assets 外联图片文件 */
function collectAssetImages(mirrorDir: string): string[] {
	const assets = join(mirrorDir, "_assets");
	if (!existsSync(assets)) return [];
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const p = join(dir, name);
			let isDir = false;
			try {
				isDir = readdirSync(p).length >= 0;
			} catch {
				isDir = false; // 文件（ENOTDIR）
			}
			if (isDir) walk(p);
			else out.push(p);
		}
	};
	walk(assets);
	return out;
}

/** kernel 服务日志追加落盘（失败静默——日志不影响断言） */
function appendSafe(path: string, chunk: Buffer | string): void {
	try {
		appendFileSync(path, chunk);
	} catch {
		/* 忽略 */
	}
}

afterEach(async () => {
	// 清理（AGENTS.md 产物规则）：删库（级联清 mirror）→ 杀 kernel（进程组）→ 删临时目录
	if (kbId) {
		await api("DELETE", `/api/knowledge/${encodeURIComponent(kbId)}`).catch(() => {});
		kbId = "";
	}
	if (kernel) {
		try {
			process.kill(-kernel.pid!, "SIGTERM");
		} catch {
			kernel.kill("SIGTERM");
		}
		kernel = null;
	}
	if (reg) {
		reg.close();
		reg = null;
	}
	ctx = null;
	for (const dir of [waPiDir, srcDir]) {
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
	waPiDir = "";
	srcDir = "";
});

test(
	"md mirror API 层端到端：REST 建库 → 真实索引就绪 → 检索/读取指向副本",
	async () => {
		// 首次含模型加载推理（q8 约 50s）+ 索引；模型已预置时 1-2 分钟
		// ── 源目录：docx(altChunk+图) + pdf(扫描件) + md(passthrough) ──
		srcDir = mkdtempSync(join(tmpdir(), "kb-mdmirror-src-"));
		copyFileSync(join(FIX, "docx-altchunk.docx"), join(srcDir, "docx-altchunk.docx"));
		copyFileSync(join(FIX, "pdf-scanned.pdf"), join(srcDir, "pdf-scanned.pdf"));
		writeFileSync(
			join(srcDir, "使用指南.md"),
			[
				"# 使用指南",
				"",
				"昆仑云控制台的退货流程：登录后进入订单页，选择需退货的订单提交申请，",
				"客服审核通过后原路退款，三个工作日内到账。",
				"",
			].join("\n"),
			"utf8",
		);

		// ── spawn 真实 kernel HTTP 服务（隔离 WA_PI_DIR + 独立端口 + 预置模型）──
		waPiDir = mkdtempSync(join(tmpdir(), "kb-mdmirror-wapi-"));
		const logPath = join(waPiDir, "kernel.log");
		kernel = spawn("bun", ["run", "src/desktop-server.ts"], {
			cwd: join(import.meta.dir, ".."),
			env: {
				...process.env,
				WA_PI_DIR: waPiDir,
				WA_PI_WS_PORT: String(PORT),
				WA_PI_SKIP_AGENT_SEED: "1",
				WA_PI_MODEL_DIR: MODEL_DIR,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		kernel.stdout?.on("data", (c) => appendSafe(logPath, c));
		kernel.stderr?.on("data", (c) => appendSafe(logPath, c));

		// 探活（HTTP /api/projects）
		await pollRest(async () => {
			try {
				const res = await fetch(`${BASE}/api/projects`, { signal: AbortSignal.timeout(800) });
				return res.ok;
			} catch {
				return false;
			}
		}, 15_000);

		// 测试进程内打开登记库（schema 由 kernel 服务启动时建好，这里幂等补跑兜底；
		// WAL 下多进程安全）——检索/读取与 agent 工具同函数走真实数据
		reg = new Database(join(waPiDir, "knowledge.db"));
		reg.run(KB_SCHEMA_SQL);
		const store = new KnowledgeStore(reg, waPiDir);
		ctx = { store, waPiDir, sse: () => {} };

		// ── REST 建库（真实 HTTP 入口；索引异步，进度走 SSE 不进响应体）──
		const created = await api("POST", "/api/knowledge", {
			folderPath: srcDir,
			name: "镜像E2E库",
		});
		kbId = created?.kb?.id as string;
		expect(kbId, "创建返回 kb.id").toBeTruthy();

		// ── 等索引终态 ready（真实模型推理 + 转换管线）──
		const ready = await pollRest(async () => {
			const data = await api("GET", "/api/knowledge");
			const found = (data?.kbs ?? []).find((k: any) => k.id === kbId);
			if (found?.status === "failed") {
				throw new Error(`索引失败：${found.lastError ?? "（无 lastError）"}（日志 ${logPath}）`);
			}
			return found?.status === "ready" ? found : undefined;
		}, 240_000);

		// ── 断言 ①：镜像统计（docx 转 md 成功 + 图片外联；md passthrough 计入）──
		const meta = ready.mirrorMeta;
		expect(meta, "ready 后携带 mirrorMeta").toBeTruthy();
		expect(meta.converted).toBeGreaterThanOrEqual(2); // docx 副本 + md 副本
		expect(meta.images).toBeGreaterThanOrEqual(1); // docx MHT 的 image part 外联

		// ── 断言 ②：mirror 目录文件系统——副本 md 存在、含源正文、_assets 图片存在 ──
		const mirrorDir = mirrorDirFor(waPiDir, kbId);
		const docxMd = join(mirrorDir, "docx-altchunk.docx.md");
		expect(existsSync(docxMd), `docx 副本存在：${docxMd}`).toBe(true);
		const docxMdText = readFileSync(docxMd, "utf8");
		expect(docxMdText).toContain("查询对象"); // altChunk MHT 正文进了副本
		const passthroughMd = join(mirrorDir, "使用指南.md.md"); // 副本统一 srcRel + ".md"
		expect(existsSync(passthroughMd), "md passthrough 副本存在").toBe(true);
		const images = collectAssetImages(mirrorDir);
		expect(images.length, "_assets 下外联图片 ≥1").toBeGreaterThanOrEqual(1);
		expect(images.every((p) => existsSync(p))).toBe(true);

		// ── 断言 ③：检索命中指向副本（与 agent knowledge_search 工具同函数）──
		const searchRes = await searchKnowledge(ctx!, [kbId], "查询对象", {
			embedQueryFn: fakeQueryEmbed,
		});
		expect(searchRes.results.length, "检索「查询对象」有命中").toBeGreaterThan(0);
		const mdHits = searchRes.results.filter((h) => h.filePath.endsWith(".md"));
		expect(mdHits.length, "命中里有 filePath 以 .md 结尾的副本").toBeGreaterThan(0);
		// docx 副本命中（fixtures 原生内容，非测试写入——转换副本确实进了索引）
		const docxHit = mdHits.find((h) => h.filePath === "docx-altchunk.docx.md");
		expect(docxHit, "检索命中 docx 转换副本").toBeTruthy();
		for (const h of mdHits) {
			const abs = h.filePathAbs ?? join(ready.folderPath as string, h.filePath);
			expect(existsSync(abs), `hit 文件存在：${abs}`).toBe(true);
		}

		// ── 断言 ④：knowledge_read 副本全文（与 agent knowledge_read 工具同函数）──
		const read = await readKnowledge(ctx!, [kbId], { filePath: docxHit!.filePath });
		expect(read.found, "按副本路径读回成功").toBe(true);
		expect(read.content).toContain("查询对象"); // markdown 全文含源正文
		// filePathAbs 指向 mirror 副本且真实存在（T9 行为：读取通道回传副本绝对路径）
		expect(read.filePathAbs, "回传副本绝对路径").toBeTruthy();
		expect(read.filePathAbs!.endsWith(".md")).toBe(true);
		expect(existsSync(read.filePathAbs!), "回传副本路径真实存在").toBe(true);

		// ── 扫描件混入不炸库：pdf 无论走转换还是降级，库整体 ready（上面已等到位）；
		// 原生 md 的 passthrough 副本同样可检索 ──
		const mdSearch = await searchKnowledge(ctx!, [kbId], "退货流程", {
			embedQueryFn: fakeQueryEmbed,
		});
		const passthroughHit = mdSearch.results.find((h) => h.filePath === "使用指南.md.md");
		expect(passthroughHit, "原生 md passthrough 副本可检索").toBeTruthy();
	},
	300_000,
);
