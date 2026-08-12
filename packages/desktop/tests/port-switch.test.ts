// port-switch.cjs 单元测试。
// 需求：端口自愈失败时「换端口启动」——从固定端口的下一个端口开始找可用端口。
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
