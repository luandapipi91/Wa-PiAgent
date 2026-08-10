import { test, expect, beforeEach } from "bun:test";
import {
	_setRecordingManager,
	toRecordingErrorMessage,
} from "../src/recording/recorder";

beforeEach(() => {
	// 重置为真实 manager（避免污染其他测试的注入）
	_setRecordingManager(null);
});

test("RecordingManager.start：getUserMedia 权限拒绝 → 抛业务文案（非原始英文）", async () => {
	// mock navigator.mediaDevices.getUserMedia 抛 NotAllowedError
	const orig = navigator.mediaDevices;
	Object.defineProperty(navigator, "mediaDevices", {
		value: {
			getUserMedia: async () => {
				throw new DOMException("Permission denied", "NotAllowedError");
			},
			getDisplayMedia: async () => {
				throw new Error("not called");
			},
		},
		configurable: true,
	});
	try {
		const { getRecordingManager } = await import("../src/recording/recorder");
		await expect(
			getRecordingManager().start({
				source: "mic",
				projectId: "p1",
				sessionId: "s1",
				ownerLabel: "x",
				onTick: () => {},
			}),
		).rejects.toThrow(/权限/);
	} finally {
		Object.defineProperty(navigator, "mediaDevices", {
			value: orig,
			configurable: true,
		});
		_setRecordingManager(null);
	}
});

test("toRecordingErrorMessage 纯函数映射（与集成路径同一实现）", () => {
	const e = new DOMException("denied", "NotAllowedError");
	expect(toRecordingErrorMessage(e)).toContain("权限");
});
