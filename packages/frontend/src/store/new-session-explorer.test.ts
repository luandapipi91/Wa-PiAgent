// new-session-explorer store 单元测试（第一层）：toggle 切换 + 持久化到 localStorage。
import { test, expect, beforeEach } from "bun:test";
import { useNewSessionExplorerStore } from "./new-session-explorer";

beforeEach(() => {
	localStorage.clear();
	useNewSessionExplorerStore.setState({ open: false, width: 320 });
});

test("toggle 切换 open 并持久化到 localStorage", () => {
	useNewSessionExplorerStore.getState().toggle();
	expect(useNewSessionExplorerStore.getState().open).toBe(true);
	expect(localStorage.getItem("wa-pi:new-session-explorer-open")).toBe("1");

	useNewSessionExplorerStore.getState().toggle();
	expect(useNewSessionExplorerStore.getState().open).toBe(false);
	expect(localStorage.getItem("wa-pi:new-session-explorer-open")).toBe("0");
});

test("setWidth 更新宽度并持久化到 localStorage", () => {
	useNewSessionExplorerStore.getState().setWidth(280);
	expect(useNewSessionExplorerStore.getState().width).toBe(280);
	expect(localStorage.getItem("wa-pi:new-session-explorer-width")).toBe("280");
});
