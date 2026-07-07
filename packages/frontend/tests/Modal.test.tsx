import { test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Modal } from "../src/components/ui/Modal";

test("渲染遮罩 + 子内容", () => {
  render(
    <Modal onClose={() => {}}>
      <div>内容</div>
    </Modal>
  );
  expect(screen.getByTestId("modal-overlay")).toBeTruthy();
  expect(screen.getByText("内容")).toBeTruthy();
});

test("点击遮罩触发 onClose", () => {
  const fn = vi.fn();
  render(<Modal onClose={fn}><div>x</div></Modal>);
  fireEvent.click(screen.getByTestId("modal-overlay"));
  expect(fn).toHaveBeenCalledOnce();
});

test("点击卡片内容不触发 onClose", () => {
  const fn = vi.fn();
  render(<Modal onClose={fn}><div>x</div></Modal>);
  fireEvent.click(screen.getByTestId("modal-content"));
  expect(fn).not.toHaveBeenCalled();
});

test("ESC 触发 onClose", () => {
  const fn = vi.fn();
  render(<Modal onClose={fn}><div>x</div></Modal>);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(fn).toHaveBeenCalledOnce();
});

test("自定义 data-testid 透传到卡片", () => {
  render(
    <Modal onClose={() => {}} data-testid="my-dialog">
      <div>x</div>
    </Modal>
  );
  expect(screen.getByTestId("my-dialog")).toBeTruthy();
});
