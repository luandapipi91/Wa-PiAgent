// GitHub 镜像同步脚本纯函数测试：ls-tree 解析 / 增量条目组装 / 二进制判断。
import { describe, expect, test } from "bun:test";
import {
	buildEntries,
	looksBinary,
	parseLsTreeLine,
	type LsTreeEntry,
} from "./sync-github-mirror";

describe("parseLsTreeLine", () => {
	test("解析标准行：mode/sha/path", () => {
		const e = parseLsTreeLine(
			"100644 blob 9191d97f271952c60a8d3f0695021d7c9a83ae25\tCHANGELOG.md",
		);
		expect(e).toEqual({
			mode: "100644",
			sha: "9191d97f271952c60a8d3f0695021d7c9a83ae25",
			path: "CHANGELOG.md",
		});
	});

	test("路径含多级目录与空格", () => {
		const e = parseLsTreeLine(
			"100644 blob 0123456789abcdef0123456789abcdef01234567\tpackages/frontend/src/a b/c.ts",
		);
		expect(e?.path).toBe("packages/frontend/src/a b/c.ts");
	});

	test("可执行位 100755", () => {
		const e = parseLsTreeLine(
			"100755 blob 0123456789abcdef0123456789abcdef01234567\trun.sh",
		);
		expect(e?.mode).toBe("100755");
	});

	test("非 blob 行（tree/commit）返回 null", () => {
		expect(
			parseLsTreeLine(
				"040000 tree 0123456789abcdef0123456789abcdef01234567\tpackages",
			),
		).toBeNull();
		expect(parseLsTreeLine("garbage")).toBeNull();
		expect(parseLsTreeLine("")).toBeNull();
	});
});

describe("buildEntries", () => {
	const local: LsTreeEntry[] = [
		{ mode: "100644", sha: "aaa", path: "keep.ts" },
		{ mode: "100644", sha: "bbb", path: "new.ts" },
	];

	test("只提交内容变化的文件；未变化的由 base_tree 复用", () => {
		const entries = buildEntries(
			local,
			new Map([
				["keep.ts", "aaa"], // 一致 → 跳过
				["new.ts", "old"], // 内容变了 → 提交
			]),
		);
		expect(entries).toEqual([
			{ path: "new.ts", mode: "100644", type: "blob", sha: "bbb" },
		]);
	});

	test("远端没有的新文件作为 upsert 提交", () => {
		const entries = buildEntries(local, new Map([["keep.ts", "aaa"]]));
		expect(entries).toEqual([
			{ path: "new.ts", mode: "100644", type: "blob", sha: "bbb" },
		]);
	});

	test("远端多余文件删除（sha:null）", () => {
		const entries = buildEntries(
			local,
			new Map([
				["keep.ts", "aaa"],
				["new.ts", "bbb"],
				["gone.ts", "ccc"],
				["also-gone.ts", "ddd"],
			]),
		);
		expect(entries).toEqual([
			{ path: "gone.ts", mode: "100644", type: "blob", sha: null },
			{ path: "also-gone.ts", mode: "100644", type: "blob", sha: null },
		]);
	});

	test("本地与远端完全一致时返回空（不发无谓请求，也避开 GitHub 构树超时）", () => {
		expect(
			buildEntries(
				local,
				new Map([
					["keep.ts", "aaa"],
					["new.ts", "bbb"],
				]),
			),
		).toEqual([]);
	});
});

describe("looksBinary", () => {
	test("含 NUL 字节判定为二进制", () => {
		expect(looksBinary(new Uint8Array([0x69, 0x00, 0x64]))).toBe(true);
	});
	test("纯文本非二进制", () => {
		expect(looksBinary(new Uint8Array([0x69, 0x64, 0x0a]))).toBe(false);
	});
	test("空内容非二进制", () => {
		expect(looksBinary(new Uint8Array([]))).toBe(false);
	});
});
