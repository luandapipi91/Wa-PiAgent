// compaction-guard 部署单测（TDD：先于实现编写）
//
// 与 wa-pi-bridge / wa-pi-tui-host 同款形态：kernel 启动时把扩展源文件复制到
// GENERATED_DIR，pi 子进程经 -e 加载。扩展入口 import "./compaction-guard.ts"，
// 因此纯逻辑模块必须一起部署，保持同目录相对结构。

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	COMPACTION_GUARD_EXTENSION_FILES,
	COMPACTION_GUARD_EXTENSION_NAME,
	deployCompactionGuardExtension,
} from "../src/compaction-guard-deploy.ts";

describe("deployCompactionGuardExtension", () => {
	test("部署入口与纯逻辑模块，返回入口路径", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cmp-guard-"));
		const entry = await deployCompactionGuardExtension(dir);

		expect(entry).toBe(join(dir, `${COMPACTION_GUARD_EXTENSION_NAME}.ts`));
		expect(existsSync(entry)).toBe(true);
		expect(existsSync(join(dir, "compaction-guard-core.ts"))).toBe(true);
	});

	test("部署出去的入口注册了压缩钩子，且相对 import 可解析", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cmp-guard-"));
		const entry = await deployCompactionGuardExtension(dir);
		const source = readFileSync(entry, "utf8");

		expect(source).toContain("session_before_compact");
		expect(source).toContain('from "./compaction-guard-core.ts"');
	});

	test("重复部署幂等（覆盖写）", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cmp-guard-"));
		const first = await deployCompactionGuardExtension(dir);
		const second = await deployCompactionGuardExtension(dir);
		expect(second).toBe(first);
		expect(existsSync(second)).toBe(true);
	});

	test("部署清单包含入口与纯逻辑两个文件", () => {
		expect(COMPACTION_GUARD_EXTENSION_FILES).toHaveLength(2);
		expect(COMPACTION_GUARD_EXTENSION_FILES.map(([, target]) => target)).toEqual([
			`${COMPACTION_GUARD_EXTENSION_NAME}.ts`,
			"compaction-guard-core.ts",
		]);
	});
});
