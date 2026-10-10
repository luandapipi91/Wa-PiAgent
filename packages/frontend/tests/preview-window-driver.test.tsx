// usePreviewWindowDriver × 最小化状态：会话切换后浮动预览窗保持最小化。
//
// 背景 bug（2026-10-10）：预览浮动窗口最小化后切到其他会话再切回，窗口被自动
// 恢复打开。根因：①切走会话窗口被 close 销毁，切回时 open 重建，重建路径不感知
// minimized，首帧 ready 后主进程无条件 show；②driver 发出的 cmd hide 在主进程
// 无对应分支被静默丢弃。本文件锁定前端契约：open 调用必须携带 minimized（主进程
// 据此决定首帧 ready 后是否显示），minimized 变化的 hide/restore 指令照旧下发。
import { test, expect, beforeEach, afterEach } from "bun:test";
import { renderHook, act, cleanup } from "@testing-library/react";
import { usePreviewWindowDriver } from "../src/preview-window-driver";
import { useBrowserStore } from "../src/store/browser";

let openCalls: any[];
let cmdCalls: any[];

afterEach(() => cleanup()); // 卸载 hook，防止上一用例的订阅在新用例 setState 时再触发 open

beforeEach(() => {
	openCalls = [];
	cmdCalls = [];
	(window as any).waPiPreviewWin = {
		open: (payload: any) => {
			openCalls.push(payload);
			return Promise.resolve({ ok: true });
		},
		cmd: (payload: any) => {
			cmdCalls.push(payload);
		},
		act: () => {},
		setSize: () => {},
		onEvent: () => () => {},
	};
	useBrowserStore.setState({
		open: false,
		mode: "split",
		path: null,
		externalUrl: null,
		sessionId: null,
		minimized: false,
		bySession: {},
	});
});

test("最小化状态下开窗（会话切回重建场景）：open 必须携带 minimized=true", () => {
	useBrowserStore.setState({
		open: true,
		mode: "float",
		path: "/tmp/a.html",
		sessionId: "s1",
		minimized: true,
	});
	renderHook(() => usePreviewWindowDriver());
	expect(openCalls).toHaveLength(1);
	expect(openCalls[0].minimized).toBe(true);
});

test("非最小化开窗：open 携带 minimized=false（首帧 ready 正常显示）", () => {
	useBrowserStore.setState({
		open: true,
		mode: "float",
		path: "/tmp/a.html",
		sessionId: "s1",
		minimized: false,
	});
	renderHook(() => usePreviewWindowDriver());
	expect(openCalls).toHaveLength(1);
	expect(openCalls[0].minimized).toBe(false);
});

test("minimized=true：下发 cmd hide（主窗口渲染气泡）", () => {
	useBrowserStore.setState({
		open: true,
		mode: "float",
		path: "/tmp/a.html",
		sessionId: "s1",
		minimized: true,
	});
	renderHook(() => usePreviewWindowDriver());
	expect(cmdCalls).toContainEqual({ type: "hide" });
});

test("点气泡恢复（minimized true→false）：下发 cmd restore", () => {
	useBrowserStore.setState({
		open: true,
		mode: "float",
		path: "/tmp/a.html",
		sessionId: "s1",
		minimized: true,
	});
	renderHook(() => usePreviewWindowDriver());
	act(() => {
		useBrowserStore.getState().setMinimized(false);
	});
	expect(cmdCalls).toContainEqual({ type: "restore" });
});
