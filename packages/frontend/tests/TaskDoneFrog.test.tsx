// 任务完成青蛙动画组件测试（第二层组件测试）。
import { beforeEach, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { TaskDoneFrog } from "../src/components/ui/TaskDoneFrog";
import { useFrogStore } from "../src/store/frog";
import type { FrogBurst } from "../src/store/frog";

function burst(overrides: Partial<FrogBurst> = {}): FrogBurst {
	return {
		id: 1,
		pose: "sit",
		corner: "bl",
		sessionId: "s1",
		createdAt: Date.now(),
		...overrides,
	};
}

beforeEach(() => {
	useFrogStore.setState({ current: null });
});

test("无 burst 时不渲染", () => {
	render(<TaskDoneFrog />);
	expect(screen.queryByTestId("task-done-frog")).toBeNull();
});

test("有 burst 时渲染青蛙，并标出姿势与聊天区角落", () => {
	useFrogStore.setState({ current: burst({ pose: "sit", corner: "bl" }) });
	render(<TaskDoneFrog />);
	const el = screen.getByTestId("task-done-frog");
	expect(el.getAttribute("data-pose")).toBe("sit");
	expect(el.getAttribute("data-corner")).toBe("bl");
});

test("不同姿势渲染不同形态：wave 有挥手元素，sleep 有闭眼元素", () => {
	useFrogStore.setState({ current: burst({ pose: "wave" }) });
	const { unmount } = render(<TaskDoneFrog />);
	expect(screen.getByTestId("frog-wave-arm")).toBeTruthy();
	unmount();

	useFrogStore.setState({ current: burst({ pose: "sleep" }) });
	render(<TaskDoneFrog />);
	expect(screen.getByTestId("frog-sleep-eyes")).toBeTruthy();
});

test("动画结束触发 clear，store 恢复 null", () => {
	useFrogStore.setState({ current: burst({ pose: "sit" }) });
	render(<TaskDoneFrog />);
	fireEvent.animationEnd(screen.getByTestId("task-done-frog"));
	expect(useFrogStore.getState().current).toBeNull();
});
