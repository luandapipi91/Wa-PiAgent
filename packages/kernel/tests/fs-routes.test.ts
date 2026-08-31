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

	it("放行主流代码文件（.sh/.bash/.zsh/.go/.py/.rs/.java/.kt/.swift/.cs/.rb/.php/.sql/.toml/.scala）", async () => {
		// 这些扩展名的 Bun 兕底 mime 多为 application/*（非 text/*），须由 getMimeType
		// 显式映射为 text/x-* 才能过白名单——否则文件预览报「不支持的文件类型」
		const files = [
			"deploy.sh",
			"run.bash",
			"run.zsh",
			"main.go",
			"app.py",
			"lib.rs",
			"App.java",
			"Main.kt",
			"Main.kts",
			"View.swift",
			"Program.cs",
			"app.rb",
			"index.php",
			"query.sql",
			"config.toml",
			"Main.scala",
			"app.cjs",
		];
		for (const f of files) {
			writeFileSync(join(root, f), "// preview");
			const r = await checkPreviewable(join(root, f));
			expect(r.ok ? "" : `${f}: ${r.reason}`).toBe("");
			expect(r.ok).toBe(true);
		}
	});

	it("拒绝二进制不可预览文件（exe/zip，头部含 NUL 被喷探判为二进制）", async () => {
		// 真实文件头：exe = MZ + DOS header（含 NUL）；zip = PK\x03\x04 + 版本字段（含 NUL）
		writeFileSync(
			join(root, "a.exe"),
			Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]),
		);
		writeFileSync(
			join(root, "b.zip"),
			Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]),
		);
		for (const f of ["a.exe", "b.zip"]) {
			const r = await checkPreviewable(join(root, f));
			expect(r.ok).toBe(false);
			expect(r.ok ? "" : r.reason).toMatch(/二进制文件不支持预览/);
		}
	});

	it("扩展名未识别但内容为文本 → 兑底纯文本放行（dotfile/无扩展名）", async () => {
		// 产品决策：不支持的类型只要内容是文本就按纯文本打开（Git 同款喷探：头部含 NUL 判二进制）
		// 覆盖三类兑底场景：dotfile（extname 返回空、映射表天然失效）、无扩展名、未映射扩展名
		writeFileSync(join(root, ".gitignore"), "node_modules/\n");
		writeFileSync(join(root, "Makefile"), "build:\n\techo ok\n");
		writeFileSync(join(root, "LICENSE"), "MIT License\n");
		writeFileSync(join(root, "notes"), "中文纯文本内容");
		for (const f of [".gitignore", "Makefile", "LICENSE", "notes"]) {
			const r = await checkPreviewable(join(root, f));
			expect(r.ok ? "" : `${f}: ${r.reason}`).toBe("");
			expect(r.ok).toBe(true);
		}
	});

	it("内容含 NUL 的真二进制（即使扩展名未识别）→ 拒绝", async () => {
		// 喷探策略下 exe/zip 真实头部含 NUL 仍拒绝；无扩展名二进制同样拒绝
		writeFileSync(
			join(root, "payload"),
			Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]),
		);
		writeFileSync(
			join(root, "archive"),
			Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]),
		);
		for (const f of ["payload", "archive"]) {
			const r = await checkPreviewable(join(root, f));
			expect(r.ok).toBe(false);
		}
	});

	it("拒绝超过 5MB 的大文件（4MB 边界内放行）", async () => {
		const big = Buffer.alloc(5 * 1024 * 1024 + 1);
		writeFileSync(join(root, "big.txt"), big);
		const r = await checkPreviewable(join(root, "big.txt"));
		expect(r.ok).toBe(false);
		expect(r.ok ? "" : r.reason).toMatch(/文件过大/);
		// 边界内：4MB 文本放行（锁定上限调整后的行为）
		writeFileSync(join(root, "mid.txt"), Buffer.alloc(4 * 1024 * 1024));
		const r2 = await checkPreviewable(join(root, "mid.txt"));
		expect(r2.ok ? "" : `mid.txt: ${r2.reason}`).toBe("");
		expect(r2.ok).toBe(true);
	});

	it("拒绝不存在的文件", async () => {
		const r = await checkPreviewable(join(root, "nope.txt"));
		expect(r.ok).toBe(false);
		expect(r.ok ? "" : r.reason).toMatch(/无法获取文件信息/);
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

describe("defaultOpenCommand（系统默认应用打开命令选择）", () => {
	it("按平台返回 open/start/xdg-open", () => {
		const { defaultOpenCommand } = require("../src/routes/fs");
		expect(defaultOpenCommand("darwin")).toBe("open");
		expect(defaultOpenCommand("win32")).toBe("start");
		expect(defaultOpenCommand("linux")).toBe("xdg-open");
	});
});
