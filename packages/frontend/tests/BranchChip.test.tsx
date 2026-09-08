// BranchChip 组件测试：分支 pill + portal 下拉（搜索过滤/当前打勾/切换回调/底部入口）
import { test, expect, mock } from "bun:test";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { BranchChip } from "../src/components/git/BranchChip";

const BRANCHES = ["main", "dev", "feature/git-branch-switcher"];

function renderChip(overrides: Partial<Parameters<typeof BranchChip>[0]> = {}) {
	const props = {
		current: "main",
		branches: BRANCHES,
		onSwitch: mock(),
		onCreateBranch: mock(),
		onOpenGraph: mock(),
		pulling: false,
		onPull: mock(),
		onRefresh: mock(),
		...overrides,
	};
	render(<BranchChip {...props} />);
	return props;
}

test("pill 显示当前分支名，点击展开带搜索框的菜单", () => {
	renderChip();
	const chip = screen.getByTestId("branch-chip");
	expect(chip.textContent).toContain("main");
	fireEvent.click(chip);
	expect(screen.getByTestId("branch-menu")).toBeTruthy();
	expect(screen.getByTestId("branch-search")).toBeTruthy();
	// 分支列表全部渲染
	expect(screen.getByTestId("branch-item-main")).toBeTruthy();
	expect(screen.getByTestId("branch-item-dev")).toBeTruthy();
	expect(
		screen.getByTestId("branch-item-feature/git-branch-switcher"),
	).toBeTruthy();
	// 底部入口：拉取/刷新 + 创建分支/Git 图谱
	expect(screen.getByTestId("menu-git-pull")).toBeTruthy();
	expect(screen.getByTestId("menu-git-refresh")).toBeTruthy();
	expect(screen.getByTestId("btn-create-branch")).toBeTruthy();
	expect(screen.getByTestId("btn-git-graph")).toBeTruthy();
});

test("拉取菜单项触发 onPull 并关闭菜单；拉取中禁用且不触发", () => {
	const props = renderChip();
	fireEvent.click(screen.getByTestId("branch-chip"));
	fireEvent.click(screen.getByTestId("menu-git-pull"));
	expect(props.onPull).toHaveBeenCalledTimes(1);
	expect(screen.queryByTestId("branch-menu")).toBeNull();

	cleanup();
	const props2 = renderChip({ pulling: true });
	fireEvent.click(screen.getByTestId("branch-chip"));
	const item = screen.getByTestId("menu-git-pull");
	expect(item.textContent).toContain("拉取中");
	fireEvent.click(item);
	expect(props2.onPull).not.toHaveBeenCalled();
});

test("刷新菜单项触发 onRefresh 并关闭菜单", () => {
	const props = renderChip();
	fireEvent.click(screen.getByTestId("branch-chip"));
	fireEvent.click(screen.getByTestId("menu-git-refresh"));
	expect(props.onRefresh).toHaveBeenCalledTimes(1);
	expect(screen.queryByTestId("branch-menu")).toBeNull();
});

test("搜索框过滤分支列表", () => {
	renderChip();
	fireEvent.click(screen.getByTestId("branch-chip"));
	fireEvent.change(screen.getByTestId("branch-search"), {
		target: { value: "git" },
	});
	expect(screen.queryByTestId("branch-item-main")).toBeNull();
	expect(
		screen.getByTestId("branch-item-feature/git-branch-switcher"),
	).toBeTruthy();
});

test("当前分支打勾，点击其他分支触发 onSwitch 并关闭菜单", () => {
	const props = renderChip();
	fireEvent.click(screen.getByTestId("branch-chip"));
	// 当前分支有 ✓ 标记
	expect(screen.getByTestId("branch-item-main").textContent).toContain("✓");
	expect(screen.getByTestId("branch-item-dev").textContent).not.toContain("✓");
	fireEvent.click(screen.getByTestId("branch-item-dev"));
	expect(props.onSwitch).toHaveBeenCalledWith("dev");
	expect(screen.queryByTestId("branch-menu")).toBeNull();
});

test("点击当前分支只关闭菜单，不触发 onSwitch", () => {
	const props = renderChip();
	fireEvent.click(screen.getByTestId("branch-chip"));
	fireEvent.click(screen.getByTestId("branch-item-main"));
	expect(props.onSwitch).not.toHaveBeenCalled();
	expect(screen.queryByTestId("branch-menu")).toBeNull();
});

test("底部「创建并检出新分支」入口触发 onCreateBranch 并关闭菜单", () => {
	const props = renderChip();
	fireEvent.click(screen.getByTestId("branch-chip"));
	fireEvent.click(screen.getByTestId("btn-create-branch"));
	expect(props.onCreateBranch).toHaveBeenCalledTimes(1);
	expect(screen.queryByTestId("branch-menu")).toBeNull();
});

test("底部「Git 图谱」入口触发 onOpenGraph 并关闭菜单", () => {
	const props = renderChip();
	fireEvent.click(screen.getByTestId("branch-chip"));
	fireEvent.click(screen.getByTestId("btn-git-graph"));
	expect(props.onOpenGraph).toHaveBeenCalledTimes(1);
	expect(screen.queryByTestId("branch-menu")).toBeNull();
});

test("点击组件外部关闭菜单", () => {
	renderChip();
	fireEvent.click(screen.getByTestId("branch-chip"));
	expect(screen.getByTestId("branch-menu")).toBeTruthy();
	fireEvent.mouseDown(document.body);
	expect(screen.queryByTestId("branch-menu")).toBeNull();
});
