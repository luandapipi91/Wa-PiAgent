// 内置扩展禁用守卫（settings.json.extensions）：
// pi 内置 llama.cpp 扩展加载时无条件 registerProvider，会把本地 llama.cpp provider
// 注入 wa-pi 的 provider 列表；用 `-builtin:llama.cpp` 覆盖模式禁用。此处断言守卫
// 的**行为**：既补上禁用项，又保留用户已有 extensions 条目。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BUILTIN_EXTENSION_DISABLES,
	ensureBuiltinExtensionDisables,
	withBuiltinExtensionDisables,
} from "../settings-store";

let dir: string;
let file: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "wa-pi-builtin-ext-"));
	file = join(dir, "settings.json");
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("withBuiltinExtensionDisables", () => {
	test("已有用户条目 → 追加禁用项且不覆盖/不去重用户条目", () => {
		const out = withBuiltinExtensionDisables([
			"./my-local-extension.ts",
			"-builtin:codemode",
		]);
		expect(out).toContain("-builtin:llama.cpp");
		// 用户原有条目必须原样保留（顺序也不变）
		expect(out).toEqual([
			"./my-local-extension.ts",
			"-builtin:codemode",
			"-builtin:llama.cpp",
		]);
	});

	test("未配置 / 非数组 / 脏数据 → 只返回禁用项", () => {
		expect(withBuiltinExtensionDisables(undefined)).toEqual([
			...BUILTIN_EXTENSION_DISABLES,
		]);
		expect(withBuiltinExtensionDisables("not-an-array")).toEqual([
			...BUILTIN_EXTENSION_DISABLES,
		]);
		// 数组里的非字符串项丢弃，字符串项保留
		expect(withBuiltinExtensionDisables([42, null, "./keep.ts"])).toEqual([
			"./keep.ts",
			"-builtin:llama.cpp",
		]);
	});

	test("已含禁用项 → 不重复追加（幂等）", () => {
		const existing = ["-builtin:llama.cpp", "./keep.ts"];
		expect(withBuiltinExtensionDisables(existing)).toEqual(existing);
	});
});

describe("ensureBuiltinExtensionDisables（落盘守卫）", () => {
	test("保留用户条目与其他字段，并补上禁用项", async () => {
		await writeFile(
			file,
			JSON.stringify({
				retry: { maxRetries: 5 },
				extensions: ["./user-extension.ts"],
			}),
			"utf8",
		);

		await expect(ensureBuiltinExtensionDisables(file)).resolves.toBe(
			"written",
		);

		const raw = JSON.parse(await readFile(file, "utf8"));
		expect(raw.extensions).toContain("./user-extension.ts");
		expect(raw.extensions).toContain("-builtin:llama.cpp");
		// read-modify-write：其他字段不能被抹掉
		expect(raw.retry).toEqual({ maxRetries: 5 });
	});

	test("未配置 extensions → 写入禁用项", async () => {
		await writeFile(file, JSON.stringify({}), "utf8");

		await expect(ensureBuiltinExtensionDisables(file)).resolves.toBe(
			"written",
		);
		expect(JSON.parse(await readFile(file, "utf8")).extensions).toEqual([
			"-builtin:llama.cpp",
		]);
	});

	test("重复调用 → kept 且文件内容不变（幂等）", async () => {
		await writeFile(
			file,
			JSON.stringify({ extensions: ["./user-extension.ts"] }),
			"utf8",
		);
		await ensureBuiltinExtensionDisables(file);
		const first = await readFile(file, "utf8");

		await expect(ensureBuiltinExtensionDisables(file)).resolves.toBe("kept");
		expect(await readFile(file, "utf8")).toBe(first);
	});
});
