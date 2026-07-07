import { test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConfirmDialog } from "../src/components/ui/ConfirmDialog";

test("渲染标题 + 描述 + 默认按钮文案", () => {
  render(<ConfirmDialog title="删除聊天" message="确定吗？" onConfirm={() => {}} onCancel={() => {}} />);
  expect(screen.getByText("删除聊天")).toBeTruthy();
  expect(screen.getByText("确定吗？")).toBeTruthy();
  expect(screen.getByTestId("confirm-cancel").textContent).toBe("取消");
  expect(screen.getByTestId("confirm-ok").textContent).toBe("确认");
});

test("danger=true 时确认按钮变红", () => {
  render(<ConfirmDialog title="t" message="m" danger onConfirm={() => {}} onCancel={() => {}} />);
  const ok = screen.getByTestId("confirm-ok") as HTMLElement;
  expect(ok.style.background).toBe("#f38ba8");
});

test("点确认触发 onConfirm", () => {
  const fn = vi.fn();
  render(<ConfirmDialog title="t" message="m" onConfirm={fn} onCancel={() => {}} />);
  fireEvent.click(screen.getByTestId("confirm-ok"));
  expect(fn).toHaveBeenCalledOnce();
});

test("点取消触发 onCancel", () => {
  const fn = vi.fn();
  render(<ConfirmDialog title="t" message="m" onConfirm={() => {}} onCancel={fn} />);
  fireEvent.click(screen.getByTestId("confirm-cancel"));
  expect(fn).toHaveBeenCalledOnce();
});

test("自定义按钮文案", () => {
  render(
    <ConfirmDialog title="t" message="m" confirmText="删除" cancelText="算了"
      onConfirm={() => {}} onCancel={() => {}} />
  );
  expect(screen.getByTestId("confirm-ok").textContent).toBe("删除");
  expect(screen.getByTestId("confirm-cancel").textContent).toBe("算了");
});
