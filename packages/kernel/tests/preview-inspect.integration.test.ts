// 必须在任何 kernel/shared 代码 import 之前设置 WA_PI_DIR（同 preview-route.integration.test.ts 的说明）
import { test, expect, afterAll } from "bun:test";
import { rm, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

const ORIG_ENV = {
	WA_PI_DIR: process.env.WA_PI_DIR,
	HTTP_PROXY: process.env.HTTP_PROXY,
	HTTPS_PROXY: process.env.HTTPS_PROXY,
	http_proxy: process.env.http_proxy,
	https_proxy: process.env.https_proxy,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	PI_EXPERIMENTAL: process.env.PI_EXPERIMENTAL,
};

const TMP_ROOT = await mkdtemp(join(tmpdir(), "wa-pi-inspect-"));
process.env.WA_PI_DIR = TMP_ROOT;

const { startKernel } = await import("../src/index");

// 预置 projects.json：让 /preview 与 /api/preview-locate 的 allowlist 放行 TMP_ROOT
await writeFile(
	join(TMP_ROOT, "projects.json"),
	JSON.stringify({
		projects: [{ id: "inspect-test", name: "t", cwd: TMP_ROOT, createdAt: 0 }],
		sessions: [],
	}),
);

const HTML = [
	"<!DOCTYPE html>",
	"<html>",
	"<head><title>t</title></head>",
	"<body>",
	'<div id="card">',
	"  <p>hello</p>",
	"</div>",
	"</body>",
	"</html>",
].join("\n");
await writeFile(join(TMP_ROOT, "index.html"), HTML);
await writeFile(join(TMP_ROOT, "app.js"), "console.log(1)");
// 大文件护栏用例：>10MB 的 html（注入与定位都应跳过解析）
const BIG_HTML =
	"<!DOCTYPE html><html><head></head><body>" +
	"x".repeat(11 * 1024 * 1024) +
	"</body></html>";
await writeFile(join(TMP_ROOT, "big.html"), BIG_HTML);

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
				reject(new Error("no port"));
			}
		});
	});
}

const port = await getFreePort();
const kernel = await startKernel({ port });
const BASE = `http://127.0.0.1:${port}`;
const ENC = encodeURIComponent(TMP_ROOT);

afterAll(async () => {
	await kernel.stop();
	for (const [k, v] of Object.entries(ORIG_ENV)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	await rm(TMP_ROOT, { recursive: true, force: true });
});

test("GET /preview/*.html 注入 inspect 脚本", async () => {
	const r = await fetch(`${BASE}/preview/${ENC}/index.html`);
	expect(r.status).toBe(200);
	const body = await r.text();
	expect(body).toContain('<script src="/preview-inspect.js"></script>');
});

test("GET /preview/*.js 不注入", async () => {
	const r = await fetch(`${BASE}/preview/${ENC}/app.js`);
	expect(r.status).toBe(200);
	expect(await r.text()).not.toContain("preview-inspect.js");
});

test("GET /preview-inspect.js 返回脚本", async () => {
	const r = await fetch(`${BASE}/preview-inspect.js`);
	expect(r.status).toBe(200);
	expect(r.headers.get("content-type")).toContain("text/javascript");
	expect(await r.text()).toContain("hiagent:element-picked");
});

test("GET /api/preview-locate 正常定位", async () => {
	const selector = encodeURIComponent("html > body:nth-of-type(1) > div#card");
	const r = await fetch(
		`${BASE}/api/preview-locate?path=${encodeURIComponent(join(TMP_ROOT, "index.html"))}&selector=${selector}`,
	);
	expect(r.status).toBe(200);
	expect(await r.json()).toEqual({ startLine: 5, endLine: 7 });
});

test("GET /api/preview-locate 缺参 400", async () => {
	const r = await fetch(`${BASE}/api/preview-locate?path=x`);
	expect(r.status).toBe(400);
});

test("GET /api/preview-locate 项目外路径 403", async () => {
	const r = await fetch(
		`${BASE}/api/preview-locate?path=${encodeURIComponent(join(tmpdir(), "outside-x.html"))}&selector=html`,
	);
	expect(r.status).toBe(403);
});

test("GET /api/preview-locate 文件不存在 404", async () => {
	const r = await fetch(
		`${BASE}/api/preview-locate?path=${encodeURIComponent(join(TMP_ROOT, "nope.html"))}&selector=html`,
	);
	expect(r.status).toBe(404);
});

test("GET /api/preview-locate 元素定位不到返回 nulls", async () => {
	const selector = encodeURIComponent("html > body:nth-of-type(1) > ul:nth-of-type(1)");
	const r = await fetch(
		`${BASE}/api/preview-locate?path=${encodeURIComponent(join(TMP_ROOT, "index.html"))}&selector=${selector}`,
	);
	expect(r.status).toBe(200);
	expect(await r.json()).toEqual({ startLine: null, endLine: null });
});

test("GET /api/preview-locate 非 html 扩展名 400", async () => {
	const r = await fetch(
		`${BASE}/api/preview-locate?path=${encodeURIComponent(join(TMP_ROOT, "app.js"))}&selector=html`,
	);
	expect(r.status).toBe(400);
	expect(await r.json()).toEqual({ error: "bad_request" });
});

test("GET /preview 大文件（>10MB）跳过注入原样直出", async () => {
	const r = await fetch(`${BASE}/preview/${ENC}/big.html`);
	expect(r.status).toBe(200);
	expect(await r.text()).not.toContain("preview-inspect.js");
});

test("GET /api/preview-locate 大文件（>10MB）降级 nulls", async () => {
	const r = await fetch(
		`${BASE}/api/preview-locate?path=${encodeURIComponent(join(TMP_ROOT, "big.html"))}&selector=html`,
	);
	expect(r.status).toBe(200);
	expect(await r.json()).toEqual({ startLine: null, endLine: null });
});
