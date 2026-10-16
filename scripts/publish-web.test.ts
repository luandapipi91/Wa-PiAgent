import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFiles, contentTypeFor } from "./publish-web.ts";

describe("contentTypeFor", () => {
	test("html/css/js 映射到可内联渲染的 MIME", () => {
		expect(contentTypeFor("index.html")).toBe("text/html; charset=utf-8");
		expect(contentTypeFor("style.css")).toBe("text/css; charset=utf-8");
		expect(contentTypeFor("app.js")).toBe("text/javascript; charset=utf-8");
	});

	test("图片与字体映射正确", () => {
		expect(contentTypeFor("logo.svg")).toBe("image/svg+xml");
		expect(contentTypeFor("pic.PNG")).toBe("image/png"); // 大小写不敏感
		expect(contentTypeFor("font.woff2")).toBe("font/woff2");
	});

	test("无扩展名 / 未知扩展名回落 octet-stream", () => {
		expect(contentTypeFor("CNAME")).toBe("application/octet-stream");
		expect(contentTypeFor("a.unknown")).toBe("application/octet-stream");
	});
});

describe("collectFiles", () => {
	test("递归收集文件，key 为相对根的 POSIX 路径且稳定排序", () => {
		const dir = mkdtempSync(join(tmpdir(), "publish-web-test-"));
		try {
			writeFileSync(join(dir, "index.html"), "<html></html>");
			mkdirSync(join(dir, "assets"));
			writeFileSync(join(dir, "assets", "a.png"), "png");
			mkdirSync(join(dir, "assets", "sub"));
			writeFileSync(join(dir, "assets", "sub", "b.css"), "css");

			const files = collectFiles(dir);
			expect(files.map((f) => f.key)).toEqual([
				"assets/a.png",
				"assets/sub/b.css",
				"index.html",
			]);
			expect(files[0].path).toBe(join(dir, "assets", "a.png"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("以 base 指定根时 key 相对 base 计算", () => {
		const root = mkdtempSync(join(tmpdir(), "publish-web-test-"));
		const site = join(root, "website");
		mkdirSync(site);
		writeFileSync(join(site, "index.html"), "x");
		try {
			const files = collectFiles(site, site);
			expect(files).toHaveLength(1);
			expect(files[0].key).toBe("index.html");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
