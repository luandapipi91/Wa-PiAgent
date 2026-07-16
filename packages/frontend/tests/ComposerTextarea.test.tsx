import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ComposerTextarea } from "../src/components/ui/ComposerTextarea";

beforeEach(() => {
  document.body.innerHTML = "";
});

test("渲染初始文本", () => {
  render(<ComposerTextarea text="hello" onTextChange={mock()} onKeyDown={mock()} onPaste={mock()} />);
  expect(screen.getByRole("textbox").textContent).toBe("hello");
});

test("渲染文件 chip", () => {
  render(<ComposerTextarea text="看 @[App.tsx]" onTextChange={mock()} onKeyDown={mock()} onPaste={mock()} />);
  const chip = screen.getByText("@App.tsx");
  expect(chip.className).toContain("chip-file");
  expect(chip.getAttribute("data-token")).toBe("@[App.tsx]");
});

test("渲染技能 chip", () => {
  render(<ComposerTextarea text="用 $[brainstorm]" onTextChange={mock()} onKeyDown={mock()} onPaste={mock()} />);
  const chip = screen.getByText("$brainstorm");
  expect(chip.className).toContain("chip-skill");
});

test("输入时回调 onTextChange", () => {
  const onTextChange = mock();
  render(<ComposerTextarea text="" onTextChange={onTextChange} onKeyDown={mock()} onPaste={mock()} />);
  const el = screen.getByRole("textbox") as HTMLElement;
  el.focus();
  el.textContent = "typed";
  fireEvent.input(el);
  expect(onTextChange).toHaveBeenCalledWith("typed");
});

test("外部 setText 清空时 DOM 同步更新", async () => {
  const { rerender } = render(<ComposerTextarea text="hello" onTextChange={mock()} onKeyDown={mock()} onPaste={mock()} />);
  expect(screen.getByRole("textbox").textContent).toBe("hello");
  // 模拟发送后清空
  rerender(<ComposerTextarea text="" onTextChange={mock()} onKeyDown={mock()} onPaste={mock()} />);
  await waitFor(() => {
    expect(screen.getByRole("textbox").textContent).toBe("");
  });
});

test("chip 是不可编辑的", () => {
  render(<ComposerTextarea text="@[file.ts]" onTextChange={mock()} onKeyDown={mock()} onPaste={mock()} />);
  const chip = screen.getByText("@file.ts");
  expect(chip.getAttribute("contenteditable")).toBe("false");
});

test("chip 的 data-token 在 DOM 文本提取时保留", () => {
  const onTextChange = mock();
  render(<ComposerTextarea text="@[file.ts] end" onTextChange={onTextChange} onKeyDown={mock()} onPaste={mock()} />);
  const el = screen.getByRole("textbox") as HTMLElement;
  // 模拟在 chip 后输入
  el.focus();
  // 在末尾追加文本节点
  el.appendChild(document.createTextNode(" more"));
  fireEvent.input(el);
  // onTextChange 应该收到 token + 新文本
  expect(onTextChange).toHaveBeenCalledWith("@[file.ts] end more");
});
