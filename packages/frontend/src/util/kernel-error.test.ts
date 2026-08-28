import { test, expect } from "bun:test";
import { formatKernelError } from "./kernel-error";

test("code → 中文文案 + params 插值；detail 不混入主文案", () => {
	const r = formatKernelError({
		code: "provider.httpStatus",
		params: { status: 401 },
		detail: "invalid key",
	});
	expect(r.main).toContain("401");
	expect(r.main).not.toContain("invalid key");
	expect(r.detail).toBe("invalid key");
});

test("未知 code 兜底 unknown 文案并保留 detail", () => {
	const r = formatKernelError({ code: "future.code", detail: "x" });
	expect(r.main).toContain("未知错误"); // zh 字典 kernelMsg.unknown
	expect(r.detail).toBe("x");
});

test("非结构化 message 走原样展示（兼容旧 kernel）", () => {
	const r = formatKernelError({ message: "老版本错误" });
	expect(r.main).toBe("老版本错误");
});
