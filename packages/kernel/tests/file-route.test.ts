import { test, expect, afterAll } from "bun:test";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	symlinkSync,
	rmSync,
	realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMediaFile } from "../src/ws-server";

// realpath 白名单需要真实文件系统：临时目录里建项目结构
const ROOT = mkdtempSync(join(tmpdir(), "wa-pi-media-file-"));
const PROJ = join(ROOT, "proj");
mkdirSync(join(PROJ, ".wa-pi", "uploads"), { recursive: true });
writeFileSync(join(PROJ, "pic.png"), "png-bytes");
writeFileSync(join(PROJ, ".wa-pi", "uploads", "a.webm"), "webm-bytes");
writeFileSync(join(ROOT, "outside.txt"), "outside");

const projects = [{ cwd: PROJ }];
const u = (p: string) =>
	new URL("http://x/file?path=" + encodeURIComponent(p));

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

test("项目工作区内任意文件放行（返回 realpath）", () => {
	expect(resolveMediaFile(u(join(PROJ, "pic.png")), projects)).toBe(
		realpathSync(join(PROJ, "pic.png")),
	);
});

test(".wa-pi/uploads 作为项目子集自然兼容", () => {
	const f = join(PROJ, ".wa-pi", "uploads", "a.webm");
	expect(resolveMediaFile(u(f), projects)).toBe(realpathSync(f));
});

test("路径穿越（..）到项目外被拒", () => {
	expect(
		resolveMediaFile(u(join(PROJ, "..", "outside.txt")), projects),
	).toBeNull();
});

test("项目外绝对路径被拒", () => {
	expect(resolveMediaFile(u(join(ROOT, "outside.txt")), projects)).toBeNull();
});

test("缺少 path 参数返回 null", () => {
	expect(resolveMediaFile(new URL("http://x/file"), projects)).toBeNull();
});

test("项目内但文件不存在返回 null（路由据此回 403/404）", () => {
	expect(
		resolveMediaFile(u(join(PROJ, "not-exists.png")), projects),
	).toBeNull();
});

test("符号链接逃逸项目被拒（realpath 前缀校验）", () => {
	const link = join(PROJ, "escape-link");
	try {
		symlinkSync(join(ROOT, "outside.txt"), link);
	} catch {
		// Windows 无开发者模式/权限时 symlink 创建失败：跳过本用例
		return;
	}
	expect(resolveMediaFile(u(link), projects)).toBeNull();
});

test("项目内 symlink 指向项目内文件放行", () => {
	const link = join(PROJ, "inner-link.png");
	try {
		symlinkSync(join(PROJ, "pic.png"), link);
	} catch {
		return; // 同上：无权限跳过
	}
	expect(resolveMediaFile(u(link), projects)).toBe(realpathSync(join(PROJ, "pic.png")));
});
