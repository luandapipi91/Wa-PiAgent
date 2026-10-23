// vanilla SQLite dylib 解析与切换的行为锁定。
// 端到端用例仿 model-gate 模式：环境不具备（无 dylib）时 skip 并打印原因。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
	buildDylibCandidates,
	ensureCustomSqlite,
	resolveFromCandidates,
	resolveSqliteDylibPath,
} from "../src/memory/sqlite-library";

// 端到端依赖真实 dylib；本机经 scripts/build-sqlite-dylib.ts 产出。
// 与 embedding 模型门同理：环境不具备不是失败，但声明了来源却加载失败必须红。
const dylibAvailable = resolveSqliteDylibPath() !== null;

describe("buildDylibCandidates", () => {
	test("env 指定时排首位，assets 固定兜底", () => {
		process.env.WA_PI_SQLITE_DYLIB = "/tmp/fake-from-env.dylib";
		try {
			const candidates = buildDylibCandidates();
			expect(candidates[0]).toBe("/tmp/fake-from-env.dylib");
			expect(candidates.some((p) => p.endsWith(join("assets", "sqlite", "libsqlite3.dylib")))).toBe(true);
		} finally {
			delete process.env.WA_PI_SQLITE_DYLIB;
		}
	});

	test("env 未指定时仅 assets 兜底一项", () => {
		delete process.env.WA_PI_SQLITE_DYLIB;
		const candidates = buildDylibCandidates();
		expect(candidates.length).toBe(1);
		expect(candidates[0].endsWith(join("assets", "sqlite", "libsqlite3.dylib"))).toBe(true);
	});
});

describe("resolveFromCandidates", () => {
	test("空列表返回 null", () => {
		expect(resolveFromCandidates([])).toBe(null);
	});

	test("全部不存在返回 null", () => {
		expect(resolveFromCandidates(["/nonexistent/a.dylib", "/nonexistent/b.dylib"])).toBe(null);
	});

	test("返回首个存在的路径", () => {
		const dir = mkdtempSync(join(tmpdir(), "dylib-resolve-"));
		try {
			const first = join(dir, "first.dylib");
			writeFileSync(first, "");
			expect(resolveFromCandidates(["/nonexistent/a.dylib", first, join(dir, "second.dylib")])).toBe(first);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("resolveSqliteDylibPath", () => {
	test("env 指向存在的文件时优先生效", () => {
		const dir = mkdtempSync(join(tmpdir(), "dylib-env-"));
		try {
			const fromEnv = join(dir, "from-env.dylib");
			writeFileSync(fromEnv, "");
			process.env.WA_PI_SQLITE_DYLIB = fromEnv;
			expect(resolveSqliteDylibPath()).toBe(fromEnv);
		} finally {
			delete process.env.WA_PI_SQLITE_DYLIB;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("ensureCustomSqlite（端到端）", () => {
	test("真机：切换成功且 sqlite-vector 扩展可加载", () => {
		if (!dylibAvailable) {
			console.warn("跳过：vanilla SQLite dylib 不存在（跑 bun run scripts/build-sqlite-dylib.ts 产出）");
			return;
		}
		// db.ts 模块加载时已调用过，幂等返回缓存结果
		expect(ensureCustomSqlite()).toBe(true);
		// 行为断言：切换后新建连接真的能加载扩展（否则 setCustomSQLite 没生效）
		const { Database } = require("bun:sqlite");
		const { getExtensionPath } = require("@sqliteai/sqlite-vector");
		const db = new Database(":memory:");
		try {
			db.loadExtension(getExtensionPath());
			const v = (db.query("select vector_version() v").get() as any).v;
			expect(v).toMatch(/^\d+\.\d+\.\d+/);
		} finally {
			db.close();
		}
	});

	test("幂等：多次调用返回同一结果", () => {
		expect(ensureCustomSqlite()).toBe(ensureCustomSqlite());
	});

	test("同 worker 二调被拒时不误报：以扩展探针为准", () => {
		if (!dylibAvailable) {
			console.warn("跳过：vanilla SQLite dylib 不存在（跑 bun run scripts/build-sqlite-dylib.ts 产出）");
			return;
		}
		// 模拟 isolate/并行下「preload 重跑、setCustomSQLite 二调被拒」的现场：
		// 状态被污染成 false，但进程内切换其实早已生效（首个真调用已成功）。
		(globalThis as any)["__wa_pi_custom_sqlite"] = false;
		try {
			expect(ensureCustomSqlite()).toBe(true);
		} finally {
			// 恢复真实状态，不影响后续用例
			(globalThis as any)["__wa_pi_custom_sqlite"] = true;
		}
	});
});
