import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

const { ToastContainer } = await import("../src/components/ui/Toast");
const { useToastStore } = await import("../src/store/toast");

// useToastStore 是进程级单例，跨测试文件共享；每个用例自给自足，前置清空避免污染
beforeEach(() => useToastStore.setState({ toasts: [] }));
afterEach(() => {
	useToastStore.setState({ toasts: [] });
	cleanup();
});

test("无 toast 时不渲染容器", () => {
	render(<ToastContainer />);
	expect(screen.queryByTestId("toast-container")).toBeNull();
});

test("toast 容器位于顶部水平居中、向下 10vh 处", () => {
	useToastStore.setState({
		toasts: [{ id: "t1", message: "出错了", type: "error" }],
	});
	render(<ToastContainer />);
	const container = screen.getByTestId("toast-container");
	// 水平居中：左 50% + 自身左移一半
	expect(container.className).toContain("left-1/2");
	expect(container.className).toContain("-translate-x-1/2");
	// 垂直位置：距顶部 10vh
	expect(container.style.top).toBe("10vh");
});

test("error toast 渲染消息且点击可关闭", () => {
	useToastStore.setState({
		toasts: [{ id: "t1", message: "保存失败", type: "error" }],
	});
	render(<ToastContainer />);
	expect(screen.getByText("保存失败")).toBeTruthy();
	screen.getByText("保存失败").click();
	// 点击后该 toast 从 store 移除
	expect(useToastStore.getState().toasts).toHaveLength(0);
});
