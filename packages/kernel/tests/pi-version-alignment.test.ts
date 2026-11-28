// pi 三包版本齐步契约
//
// 背景（pi 1.6.0 升级时确立，1.6.1 沿用）：packages/kernel 同时直接依赖
//   @earendil-works/pi-ai / pi-coding-agent（~ 浮动）与 pi-tui（精确钉住）。
// pi-coding-agent 自身依赖同版本的 pi-tui 与 pi-ai，一旦我们声明的 pi-tui
// 落后一个补丁，node_modules 里会同时存在两份 pi-tui —— 而 tui-host 是
// 直接 `new TuiAltScreen(...)` + 从顶层引 Component 类型，
// 两份类实例混用会让 instanceof / 缓存数组判断失效（1.6.0 升级时踩过，
// 靠「三包齐步」消除）。这里把这条约束固化成断言，防止下次只升一半。
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const KERNEL_PKG = join(import.meta.dirname, "..", "package.json");
const kernelPkg = JSON.parse(readFileSync(KERNEL_PKG, "utf8")) as {
	dependencies: Record<string, string>;
};

/** 从 node_modules 里读某个包实际装出的版本（不经 package exports） */
function installedVersion(pkg: string): string {
	const p = join(
		import.meta.dirname,
		"..",
		"node_modules",
		...pkg.split("/"),
		"package.json",
	);
	return (JSON.parse(readFileSync(p, "utf8")) as { version: string }).version;
}

test("pi 三包声明的 minor 一致（pi-ai / pi-coding-agent 浮动，pi-tui 精确）", () => {
	const ai = kernelPkg.dependencies["@earendil-works/pi-ai"];
	const agent = kernelPkg.dependencies["@earendil-works/pi-coding-agent"];
	const tui = kernelPkg.dependencies["@earendil-works/pi-tui"];
	expect(ai).toBeString();
	expect(agent).toBeString();
	expect(tui).toBeString();
	// pi-tui 必须精确钉住（不留 ~ / ^），否则同一 minor 内也可能装出两份
	expect(tui).toMatch(/^\d+\.\d+\.\d+$/);
	// 三者 minor 必须相同
	const minor = (v: string) => v.replace(/^[~^]/, "").split(".").slice(0, 2).join(".");
	expect(minor(ai)).toBe(minor(tui));
	expect(minor(agent)).toBe(minor(tui));
});

test("实际装出的 pi-tui / pi-ai 精确等于 pi-coding-agent 依赖的版本（不出现双份）", () => {
	const installedTui = installedVersion("@earendil-works/pi-tui");
	const installedAi = installedVersion("@earendil-works/pi-ai");
	const agentPkg = JSON.parse(
		readFileSync(
			join(
				import.meta.dirname,
				"..",
				"node_modules",
				"@earendil-works",
				"pi-coding-agent",
				"package.json",
			),
			"utf8",
		),
	) as { dependencies: Record<string, string> };
	// pi-coding-agent 精确依赖同版本 pi-tui；我们钉的版本与它一致才不会有第二份
	expect(installedTui).toBe(agentPkg.dependencies["@earendil-works/pi-tui"]);
	expect(installedAi).toBe(agentPkg.dependencies["@earendil-works/pi-ai"]);
	// 声明与实际装出的必须一致：否则「声明 1.6.0 + 装出 1.6.1」这种漂移会漏过去，
	// 打包清单写的是声明值、磁盘上是另一个版本，装到用户机器上才暴露。
	expect(kernelPkg.dependencies["@earendil-works/pi-tui"]).toBe(installedTui);
	// ~ 浮动声明取其实装出来的版本必须满足 minor 一致（1.7.x）
	expect(installedAi.startsWith("1.7.")).toBe(true);
});
