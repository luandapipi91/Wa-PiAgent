// 必须在任何 kernel/shared 代码 import 之前设置 WA_PI_DIR：
// packages/shared/src/constants.ts 在模块加载时从 env 读取 WA_PI_DIR，
// 一旦确定便不可改。ESM 静态 import 会被提升，所以这里用动态 import()
// 把 env 设置放在第一个 kernel 模块加载之前，确保 startKernel 写入的是测试临时目录
// 而非真实 ~/.wa-pi。
import { test, expect, afterAll } from "bun:test";
import { rm, mkdir, writeFile, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { createServer } from "node:net";

// 保存原始 env：startKernel/本文件会修改 process.env（WA_PI_DIR、HTTP_PROXY 等），
// bun test --isolate 只隔离 global object 不隔离 process.env，不恢复会污染同一
// worker 进程后续测试文件（后续测试的 fetch 会走死代理/错误 WA_PI_DIR）。
const ORIG_ENV = {
	WA_PI_DIR: process.env.WA_PI_DIR,
	HTTP_PROXY: process.env.HTTP_PROXY,
	HTTPS_PROXY: process.env.HTTPS_PROXY,
	http_proxy: process.env.http_proxy,
	https_proxy: process.env.https_proxy,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	PI_EXPERIMENTAL: process.env.PI_EXPERIMENTAL,
};

const TMP_ROOT = await mkdtemp(join(tmpdir(), "wa-pi-preview-"));
process.env.WA_PI_DIR = TMP_ROOT;

const { startKernel } = await import("../src/index");

// 预置 projects.json：让 /preview 的 allowlist 放行 TMP_ROOT 内的请求
// （ensureSystemProject 是追加式写入，不会覆盖本文件）
await writeFile(
	join(TMP_ROOT, "projects.json"),
	JSON.stringify({
		projects: [{ id: "preview-test", name: "t", cwd: TMP_ROOT, createdAt: 0 }],
		sessions: [],
	}),
);

// root 之外的「机密文件」：验证 symlink 逃逸出 root 被 forbidden 拦截。
// 不能用 /preview/<enc>/../x 这类路径做 HTTP 穿越用例——WHATWG URL 会把
// .. 与 %2E%2E 段规范化掉，服务端根本收不到 ..，真实 HTTP 下的越权只能靠链接。
const OUTSIDE_SECRET = join(
	tmpdir(),
	`preview-secret-${basename(TMP_ROOT)}.txt`,
);

// 获取一个临时空闲端口供 startKernel 使用，避免与正在运行的 wa-pi（9776）冲突。
// 接受 listen(0) → close → 复用端口之间的微小竞争窗口（测试可接受）。
function getFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const s = createServer();
		s.unref();
		s.on("error", reject);
		s.listen(0, () => {
			const addr = s.address();
			if (addr && typeof addr === "object") {
				const p = addr.port;
				s.close(() => resolve(p));
			} else {
				s.close();
				reject(new Error("无法获取空闲端口"));
			}
		});
	});
}

let usedPort = 0;
let stopHandle: (() => Promise<void>) | null = null;

afterAll(async () => {
	// 尽力关 server，避免端口残留（关闭失败不阻塞清理）
	try {
		if (stopHandle) await stopHandle();
	} catch {
		/* 忽略关闭失败 */
	}
	// 恢复被污染的 env（Bun 的代理变量 delete 清不掉，统一赋回原值或空串）
	process.env.WA_PI_DIR = ORIG_ENV.WA_PI_DIR ?? "";
	process.env.HTTP_PROXY = ORIG_ENV.HTTP_PROXY ?? "";
	process.env.HTTPS_PROXY = ORIG_ENV.HTTPS_PROXY ?? "";
	process.env.http_proxy = ORIG_ENV.http_proxy ?? "";
	process.env.https_proxy = ORIG_ENV.https_proxy ?? "";
	process.env.PI_CODING_AGENT_DIR = ORIG_ENV.PI_CODING_AGENT_DIR ?? "";
	process.env.PI_EXPERIMENTAL = ORIG_ENV.PI_EXPERIMENTAL ?? "";
	await rm(TMP_ROOT, { recursive: true, force: true });
	await rm(OUTSIDE_SECRET, { recursive: true, force: true });
});

// happy-dom（root 测试环境的全局 preload）会替换 globalThis.fetch，
// 其底层 Node HTTP 解析器无法解析本 server 的响应(HPE_UNEXPECTED_CONTENT_LENGTH)。
// 本测试只在原生 fetch 环境下有意义（如 `cd packages/kernel && bun test`，
// 或 build.ts 测试钩子里单独从 kernel 目录跑）。happy-dom 下自跳过。
const HAPPY_DOM_ACTIVE =
	typeof (globalThis as any).document !== "undefined" ||
	typeof (globalThis as any).window !== "undefined";
const maybeTest: typeof test = HAPPY_DOM_ACTIVE
	? (test.skip as typeof test)
	: test;

maybeTest(
	"preview 路由：正常文件 200 + text/html、链接逃逸 403、不存在 404",
	async () => {
		await mkdir(`${TMP_ROOT}/dist`, { recursive: true });
		await writeFile(`${TMP_ROOT}/dist/index.html`, "<h1>hi</h1>");
		await writeFile(OUTSIDE_SECRET, "top-secret");
		await symlink(OUTSIDE_SECRET, `${TMP_ROOT}/escape`);
		const enc = encodeURIComponent(TMP_ROOT);
		const freePort = await getFreePort();
		const started = await startKernel({ port: freePort });
		usedPort = started.port;
		stopHandle = started.stop;
		const base = `http://127.0.0.1:${usedPort}`;

		// 1) 正常文件：200 + text/html
		const ok = await fetch(`${base}/preview/${enc}/dist/index.html`);
		expect(ok.status).toBe(200);
		expect(ok.headers.get("content-type")).toBe("text/html");
		expect(await ok.text()).toBe("<h1>hi</h1>");

		// 2) symlink 逃逸出 root：403
		const esc = await fetch(`${base}/preview/${enc}/escape`);
		expect(esc.status).toBe(403);

		// 3) 不存在：404
		const miss = await fetch(`${base}/preview/${enc}/dist/nope.html`);
		expect(miss.status).toBe(404);

		// 4) root 指向非项目目录（不在 projects.json 列表）：403
		const outsideDir = join(tmpdir(), `not-a-project-${basename(TMP_ROOT)}`);
		await mkdir(outsideDir, { recursive: true });
		await writeFile(join(outsideDir, "x.txt"), "secret");
		try {
			const outsideEnc = encodeURIComponent(outsideDir);
			const out = await fetch(`${base}/preview/${outsideEnc}/x.txt`);
			expect(out.status).toBe(403);
		} finally {
			await rm(outsideDir, { recursive: true, force: true });
		}
	},
);
