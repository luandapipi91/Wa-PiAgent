// 任务完成青蛙动画组件测试（第二层组件测试）。
// 覆盖：无 burst 不渲染 / burst 字段落到 data 属性 / 代表性变体的道具 testid / 哨兵动画结束清除。
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TaskDoneFrog } from "../src/components/ui/frog/TaskDoneFrog";
import { useFrogStore } from "../src/store/frog";
import type { FrogBurst } from "../src/store/frog";

function burst(overrides: Partial<FrogBurst> = {}): FrogBurst {
	return {
		id: 1,
		variant: "sign",
		spot: "dl",
		sessionId: "s1",
		createdAt: Date.now(),
		...overrides,
	};
}

afterEach(cleanup);

beforeEach(() => {
	useFrogStore.setState({ current: null });
});

test("无 burst 时不渲染", () => {
	render(<TaskDoneFrog />);
	expect(screen.queryByTestId("task-done-frog")).toBeNull();
});

test("有 burst 时渲染青蛙，并标出变体与聊天区位置", () => {
	useFrogStore.setState({ current: burst({ variant: "sign", spot: "dl" }) });
	render(<TaskDoneFrog />);
	const el = screen.getByTestId("task-done-frog");
	expect(el.getAttribute("data-variant")).toBe("sign");
	expect(el.getAttribute("data-spot")).toBe("dl");
});

test("8 处位置都挂上对应的位置 class", () => {
	const spots = ["ul", "um", "ur", "ml", "mr", "dl", "dm", "dr"] as const;
	for (const spot of spots) {
		useFrogStore.setState({ current: burst({ spot }) });
		const { unmount } = render(<TaskDoneFrog />);
		expect(screen.getByTestId("task-done-frog").getAttribute("class")).toContain(
			`waf-spot-${spot}`,
		);
		unmount();
	}
});

test("不同变体渲染不同形态：sign 有举牌元素，tongue 有盖章元素，magic 有徽章元素", () => {
	useFrogStore.setState({ current: burst({ variant: "sign" }) });
	const a = render(<TaskDoneFrog />);
	expect(screen.getByTestId("frog-sign-board")).toBeTruthy();
	a.unmount();

	useFrogStore.setState({ current: burst({ variant: "tongue" }) });
	const b = render(<TaskDoneFrog />);
	expect(screen.getByTestId("frog-stamp")).toBeTruthy();
	b.unmount();

	useFrogStore.setState({ current: burst({ variant: "magic" }) });
	const c = render(<TaskDoneFrog />);
	expect(screen.getByTestId("frog-magic-badge")).toBeTruthy();
	c.unmount();
});

test("动画结束触发 clear，store 恢复 null", () => {
	useFrogStore.setState({ current: burst({ variant: "sign" }) });
	render(<TaskDoneFrog />);
	fireEvent.animationEnd(screen.getByTestId("task-done-frog"));
	expect(useFrogStore.getState().current).toBeNull();
});

test("SVG 内部动画结束冒泡不触发 clear（只认哨兵动画）", () => {
	useFrogStore.setState({ current: burst({ variant: "sign" }) });
	render(<TaskDoneFrog />);
	const el = screen.getByTestId("task-done-frog");
	// 模拟 SVG 内部元素的 animationend 冒泡：直接对 svg 根派发（target ≠ currentTarget）
	const svg = el.querySelector("svg");
	fireEvent.animationEnd(svg!);
	expect(useFrogStore.getState().current).not.toBeNull();
});
