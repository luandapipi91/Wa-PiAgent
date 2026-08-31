import { test, expect } from "bun:test";
import {
	KernelError,
	toKernelPayload,
	type KernelErrorPayload,
} from "../src/kernel-errors";

test("KernelError 携带 code/params/detail，toKernelPayload 输出稳定结构", () => {
	const e = new KernelError("session.notFound", { id: "s1" });
	expect(e.code).toBe("session.notFound");
	expect(e.params).toEqual({ id: "s1" });
	expect(e.detail).toBeUndefined();
	const p: KernelErrorPayload = toKernelPayload(e);
	expect(p).toEqual({ code: "session.notFound", params: { id: "s1" } });
});

test("detail 承载技术细节，params 值强制字符串化", () => {
	const e = new KernelError("fs.tooLarge", { max: 10 }, "size=20971520");
	const p = toKernelPayload(e);
	expect(p.params).toEqual({ max: "10" });
	expect(p.detail).toBe("size=20971520");
});

test("普通 Error 不属于 KernelError（toKernelPayload 返回 null 交由调用方兜底）", () => {
	expect(toKernelPayload(new Error("plain"))).toBeNull();
});
