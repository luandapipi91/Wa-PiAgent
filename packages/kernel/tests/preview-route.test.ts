import { test, expect, afterAll } from "bun:test";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	rmSync,
	realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { resolvePreviewPath } from "../src/ws-server";

const root = mkdtempSync(join(tmpdir(), "preview-root-"));
mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(join(root, "dist", "index.html"), "<h1>hi</h1>");
writeFileSync(join(root, "dist", "app.js"), "console.log(1)");

const enc = encodeURIComponent(root);
// allowlist 预置：只放行 root 项目目录内的请求
const projects = [{ cwd: root }];

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

test("解析正常 html 文件", () => {
	const r = resolvePreviewPath(`/preview/${enc}/dist/index.html`, projects);
	expect(r.ok).toBe(true);
	// realpathSync 会解析 /var → /private/var 等链接，比较真实路径而非 join 拼接
	if (r.ok) expect(r.path).toBe(realpathSync(join(root, "dist", "index.html")));
});

test("解析子目录相对资源", () => {
	const r = resolvePreviewPath(`/preview/${enc}/dist/app.js`, projects);
	expect(r.ok).toBe(true);
	if (r.ok) expect(r.path).toBe(realpathSync(join(root, "dist", "app.js")));
});

test("中文/空格文件名解析 ok（前端编码、服务端解码配对）", () => {
	const cnFile = join(root, "dist", "报告 2026.html");
	writeFileSync(cnFile, "<h1>中文</h1>");
	const r = resolvePreviewPath(
		`/preview/${enc}/dist/${encodeURIComponent("报告 2026.html")}`,
		projects,
	);
	expect(r.ok).toBe(true);
	if (r.ok) expect(r.path).toBe(realpathSync(cnFile));
});

test(".. 穿越返回 forbidden", () => {
	// 目标必须真实存在于 root 之外：realpath 越界才会被 forbidden 拦截
	// （指向 root 内不存在路径会先因 ENOENT 返回 notfound）
	const outside = join(root, "..", `escape-${basename(root)}.txt`);
	writeFileSync(outside, "secret");
	try {
		const r = resolvePreviewPath(
			`/preview/${enc}/../escape-${basename(root)}.txt`,
			projects,
		);
		expect(r).toEqual({ ok: false, reason: "forbidden" });
	} finally {
		rmSync(outside, { force: true });
	}
});

test("非绝对路径根返回 forbidden", () => {
	const r = resolvePreviewPath(
		`/preview/${encodeURIComponent("relative/path")}/index.html`,
		projects,
	);
	expect(r).toEqual({ ok: false, reason: "forbidden" });
});

test("解码失败返回 forbidden", () => {
	const r = resolvePreviewPath("/preview/%E0%A4%A/dist/x.html", projects);
	expect(r).toEqual({ ok: false, reason: "forbidden" });
});

test("文件不存在返回 notfound", () => {
	const r = resolvePreviewPath(`/preview/${enc}/dist/nope.html`, projects);
	expect(r).toEqual({ ok: false, reason: "notfound" });
});

test("空相对路径（目录索引）返回 forbidden", () => {
	const r = resolvePreviewPath(`/preview/${enc}`, projects);
	expect(r).toEqual({ ok: false, reason: "forbidden" });
});

test("root 不在任何项目内返回 forbidden（防任意路径读取）", () => {
	// 用另一个非项目目录模拟 /etc 等任意绝对路径根：
	// 文件真实存在、root 也是绝对路径，唯一被拦的原因是 allowlist。
	const other = mkdtempSync(join(tmpdir(), "preview-other-"));
	writeFileSync(join(other, "x.txt"), "secret");
	try {
		const r = resolvePreviewPath(
			`/preview/${encodeURIComponent(other)}/x.txt`,
			projects,
		);
		expect(r).toEqual({ ok: false, reason: "forbidden" });
	} finally {
		rmSync(other, { recursive: true, force: true });
	}
});
