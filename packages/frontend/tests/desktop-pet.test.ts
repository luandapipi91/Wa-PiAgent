// 桌面宠物前端桥：浏览器（无 Electron 桥）静默降级；有桥时转发 setEnabled / celebrate / 订阅事件。
import { beforeEach, expect, test } from "bun:test";
import {
	celebrateDesktopPet,
	onDesktopPetEvent,
	setDesktopPetEnabled,
} from "../src/util/desktop-pet";

const calls: any[] = [];

function installBridge() {
	calls.length = 0;
	(window as any).waPiPet = {
		setEnabled: (v: boolean) => calls.push(["setEnabled", v]),
		celebrate: () => calls.push(["celebrate"]),
		onEvent: (cb: (p: any) => void) => {
			calls.push(["onEvent"]);
			(window as any).__petEmit = cb;
			return () => calls.push(["off"]);
		},
	};
}

beforeEach(() => {
	delete (window as any).waPiPet;
	delete (window as any).__petEmit;
});

test("无 Electron 桥（浏览器 dev）：三个入口都不抛异常且不产生调用", () => {
	expect(() => setDesktopPetEnabled(true)).not.toThrow();
	expect(() => celebrateDesktopPet()).not.toThrow();
	expect(() => onDesktopPetEvent(() => {})()).not.toThrow();
	expect(calls).toHaveLength(0);
});

test("setDesktopPetEnabled：把布尔值透传给主进程", () => {
	installBridge();
	setDesktopPetEnabled(false);
	setDesktopPetEnabled(true);
	expect(calls).toEqual([
		["setEnabled", false],
		["setEnabled", true],
	]);
});

test("celebrateDesktopPet：转发庆祝指令", () => {
	installBridge();
	celebrateDesktopPet();
	expect(calls).toEqual([["celebrate"]]);
});

test("onDesktopPetEvent：收到 closed 事件回调，解绑函数可调用", () => {
	installBridge();
	let closed = 0;
	const off = onDesktopPetEvent((payload) => {
		if (payload?.type === "closed") closed += 1;
	});
	(window as any).__petEmit({ type: "closed" });
	expect(closed).toBe(1);
	(window as any).__petEmit({ type: "other" });
	expect(closed).toBe(1);
	off();
	expect(calls).toContainEqual(["off"]);
});
