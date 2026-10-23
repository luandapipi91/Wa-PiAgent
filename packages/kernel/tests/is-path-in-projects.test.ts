import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPathInProjects } from "../src/ws-server";

const root = mkdtempSync(join(tmpdir(), "locate-root-"));
writeFileSync(join(root, "index.html"), "<h1>hi</h1>");
const projects = [{ cwd: root }];

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

test("项目内存在的文件返回 exists 且为 realpath", () => {
	const target = join(root, "index.html");
	const r = isPathInProjects(target, projects);
	expect(r).toEqual({ kind: "exists", path: realpathSync(target) });
});

test("项目内不存在的路径返回 missing（路由走 404 而非 403）", () => {
	expect(isPathInProjects(join(root, "no-such-file.html"), projects)).toEqual({
		kind: "missing",
	});
});

test("项目外路径返回 forbidden（相对路径同样拒绝）", () => {
	// tmpdir 是 root 的父级，本身在项目之外
	expect(isPathInProjects(tmpdir(), projects).kind).toBe("forbidden");
	expect(isPathInProjects("relative/path.html", projects).kind).toBe(
		"forbidden",
	);
});
