// port-switch.cjs 单元测试。
// 需求：端口自愈失败时「换端口启动」——从固定端口的下一个端口开始找可用端口。
// 另验证 main.cjs 的端口解析优先级逻辑（--wa-pi-port 参数 > env > 默认）。
import { test, expect, mock } from "bun:test";
import { pickSwitchPort } from "../src/util/port-switch.cjs";

test("pickSwitchPort: 从 basePort+1 开始找可用端口", async () => {
	const findAvailablePort = mock(async (start: number) =>
		start === 9779 ? 9779 : null,
	);
	const port = await pickSwitchPort(9778, { findAvailablePort });
	expect(findAvailablePort).toHaveBeenCalledWith(9779);
	expect(port).toBe(9779);
});

test("pickSwitchPort: 找不到可用端口 → null", async () => {
	const findAvailablePort = mock(async () => null);
	const port = await pickSwitchPort(9778, { findAvailablePort });
	expect(port).toBeNull();
});

// 模拟 main.cjs 的 FIXED_PORT 解析优先级：--wa-pi-port 参数 > env > 默认 9778
// （不 import main.cjs——顶层 require electron 有副作用，直接复刻解析逻辑）
function resolveFixedPort(argv: string[], env: Record<string, string>) {
	const PORT_ARG = argv.find((a) => a.startsWith("--wa-pi-port="));
	return PORT_ARG
		? Number(PORT_ARG.split("=")[1])
		: Number(env.WA_PI_WS_PORT) > 0
			? Number(env.WA_PI_WS_PORT)
			: 9778;
}

test("resolveFixedPort: 有 --wa-pi-port 参数 → 用参数值（换端口启动后生效）", () => {
	expect(resolveFixedPort(["--wa-pi-port=9779"], {})).toBe(9779);
	expect(resolveFixedPort(["--wa-pi-port=9780"], { WA_PI_WS_PORT: "9778" })).toBe(
		9780,
	);
});

test("resolveFixedPort: 无参数但有 env → 用 env", () => {
	expect(resolveFixedPort([], { WA_PI_WS_PORT: "9779" })).toBe(9779);
});

test("resolveFixedPort: 都无 → 默认 9778", () => {
	expect(resolveFixedPort([], {})).toBe(9778);
});

test("resolveFixedPort: 重复 relaunch 后只认最新参数（旧值被过滤）", () => {
	// 第二次 relaunch 前会过滤旧 --wa-pi-port，但若未过滤（回归），find 取第一个
	// 此处验证过滤逻辑的必要性：残留两个参数时 find 取第一个旧值
	const argv = ["--wa-pi-port=9779", "--wa-pi-port=9780"];
	expect(resolveFixedPort(argv, {})).toBe(9779); // 未过滤则取旧值（bug）
	// 正确做法：过滤后只留最新
	const clean = argv.filter((a) => a !== "--wa-pi-port=9779");
	expect(resolveFixedPort(clean, {})).toBe(9780);
});
