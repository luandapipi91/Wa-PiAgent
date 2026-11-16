// 主进程 .cjs 语法门（2026-11-16 事故：main.cjs 删弹窗时误删 if 块闭合花括号，
// `try {` 未闭合直接接 `} catch (e)`，语法错误 —— 但 tsc 只查 TS、其他测试不加载
// main.cjs，打包后才在用户机器上「A JavaScript error occurred in the main process」。
// 本用例对所有 src/**/*.cjs 做语法校验，把这类语法错拦在发版前。
// 实现：一次 node 进程内 new vm.Script 编译全部文件（比逐个 node --check 快一个量级）。
import { test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const SRC = join(import.meta.dir, "..", "src");

function collectCjs(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) collectCjs(p, out);
		else if (name.endsWith(".cjs")) out.push(p);
	}
	return out;
}

test("主进程 .cjs 文件全部通过语法校验（语法错误不得进安装包）", () => {
	const files = collectCjs(SRC);
	expect(files.length).toBeGreaterThan(0);
	const broken: string[] = [];
	for (const f of files) {
		const code = readFileSync(f, "utf8");
		try {
			// 只编译不执行：语法错误（如 try 未闭合）在此抛出
			new vm.Script(code, { filename: f });
		} catch (e) {
			broken.push(`${f}: ${(e as Error).message}`);
		}
	}
	expect(broken).toEqual([]);
});
