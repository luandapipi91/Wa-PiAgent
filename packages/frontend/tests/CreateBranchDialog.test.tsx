// CreateBranchDialog 组件测试：分支名预判（isValidBranchName）+ 提交/取消
import { test, expect, mock } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CreateBranchDialog } from "../src/components/git/CreateBranchDialog";

function renderDialog(onCreate: (name: string) => Promise<void> = async () => {}) {
	const onClose = mock();
	render(<CreateBranchDialog onClose={onClose} onCreate={onCreate} />);
	return { onClose };
}

test("渲染标题/说明/输入框/按钮，初始提交按钮禁用", () => {
	renderDialog();
	expect(screen.getByTestId("create-branch-dialog")).toBeTruthy();
	expect(screen.getByText("创建并检出新分支")).toBeTruthy();
	expect(
		screen.getByText(
			"基于当前 HEAD 创建一个新的本地分支，并在创建成功后立即切换过去。",
		),
	).toBeTruthy();
	expect(
		screen.getByText("首版只支持基于当前 HEAD 创建并切换。"),
	).toBeTruthy();
	const input = screen.getByTestId(
		"branch-name-input",
	) as HTMLInputElement;
	expect(input.placeholder).toBe("例如 feature/git-branch-switcher");
	const confirm = screen.getByTestId(
		"btn-create-branch-confirm",
	) as HTMLButtonElement;
	expect(confirm.disabled).toBe(true);
});

test("输入合法分支名后可提交，非法名禁用并提示", () => {
	renderDialog();
	const input = screen.getByTestId("branch-name-input");
	const confirm = screen.getByTestId(
		"btn-create-branch-confirm",
	) as HTMLButtonElement;
	fireEvent.change(input, { target: { value: "feature/x" } });
	expect(confirm.disabled).toBe(false);
	// 非法名（含 .. ）
	fireEvent.change(input, { target: { value: "bad..name" } });
	expect(confirm.disabled).toBe(true);
	expect(screen.getByText("分支名不合法")).toBeTruthy();
});

test("提交调用 onCreate，成功后关闭对话框", async () => {
	const onCreate = mock(async () => {});
	const { onClose } = renderDialog(onCreate);
	fireEvent.change(screen.getByTestId("branch-name-input"), {
		target: { value: "feature/new" },
	});
	fireEvent.click(screen.getByTestId("btn-create-branch-confirm"));
	await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
	expect(onCreate).toHaveBeenCalledWith("feature/new");
});

test("onCreate 失败时不关闭对话框", async () => {
	const onCreate = mock(async () => {
		throw new Error("branch exists");
	});
	const { onClose } = renderDialog(onCreate);
	fireEvent.change(screen.getByTestId("branch-name-input"), {
		target: { value: "main" },
	});
	fireEvent.click(screen.getByTestId("btn-create-branch-confirm"));
	await waitFor(() => expect(onCreate).toHaveBeenCalled());
	expect(onClose).not.toHaveBeenCalled();
});

test("取消按钮触发 onClose", () => {
	const { onClose } = renderDialog();
	fireEvent.click(screen.getByText("取消"));
	expect(onClose).toHaveBeenCalledTimes(1);
});
