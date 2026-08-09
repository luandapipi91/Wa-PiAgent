import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPreviewable } from "../src/routes/fs";

describe("checkPreviewable", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "wa-pi-preview-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("放行文本类文件（.txt/.md/.json/.ts）", async () => {
		writeFileSync(join(root, "a.txt"), "hello");
		writeFileSync(join(root, "b.md"), "# hi");
		writeFileSync(join(root, "c.json"), "{}");
		writeFileSync(join(root, "d.ts"), "export const x = 1;");
		for (const f of ["a.txt", "b.md", "c.json", "d.ts"]) {
			const r = await checkPreviewable(join(root, f));
			expect(r.ok).toBe(true);
		}
	});

	it("放行图片类文件（png/jpg/gif/svg）", async () => {
		// 写入最小合法字节即可，checkPreviewable 不校验内容，仅按扩展名 mime + size 判定
		writeFileSync(join(root, "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
		writeFileSync(join(root, "b.jpg"), Buffer.from([0xff, 0xd8, 0xff]));
		writeFileSync(join(root, "c.gif"), "GIF89a");
		writeFileSync(join(root, "d.svg"), "<svg/>");
		for (const f of ["a.png", "b.jpg", "c.gif", "d.svg"]) {
			const r = await checkPreviewable(join(root, f));
			expect(r.ok).toBe(true);
		}
	});

	it("拒绝二进制不可预览文件（exe/zip）", async () => {
		writeFileSync(join(root, "a.exe"), "MZ");
		writeFileSync(join(root, "b.zip"), "PK");
		for (const f of ["a.exe", "b.zip"]) {
			const r = await checkPreviewable(join(root, f));
			expect(r.ok).toBe(false);
			expect(!r.ok ? r.reason : "").toMatch(/不支持的文件类型/);
		}
	});

	it("拒绝超过 3MB 的大文件", async () => {
		const big = Buffer.alloc(3 * 1024 * 1024 + 1);
		writeFileSync(join(root, "big.txt"), big);
		const r = await checkPreviewable(join(root, "big.txt"));
		expect(r.ok).toBe(false);
		expect(!r.ok ? r.reason : "").toMatch(/文件过大/);
	});

	it("拒绝不存在的文件", async () => {
		const r = await checkPreviewable(join(root, "nope.txt"));
		expect(r.ok).toBe(false);
		expect(!r.ok ? r.reason : "").toMatch(/无法获取文件信息/);
	});
});

describe("list-dir dotfile 过滤", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "wa-pi-listdir-"));
		writeFileSync(join(root, ".gitignore"), "");
		mkdirSync(join(root, ".git"));
		writeFileSync(join(root, "readme.md"), "");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("showHidden 缺省/为假时过滤点开头项", async () => {
		const { listDir } = await import("../src/routes/fs");
		const r = await listDir(root, false);
		expect(r.map((e) => e.name).sort()).toEqual(["readme.md"]);
	});

	it("showHidden=true 时返回点开头项（.git/.gitignore）", async () => {
		const { listDir } = await import("../src/routes/fs");
		const r = await listDir(root, true);
		expect(r.map((e) => e.name).sort()).toEqual([
			".git",
			".gitignore",
			"readme.md",
		]);
	});
});
