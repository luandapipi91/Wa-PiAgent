import { test, expect, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { TagInput } from "../src/components/ui/TagInput";

test("渲染初始 tags", () => {
  render(<TagInput value={["a", "b"]} onChange={() => {}} />);
  expect(screen.getByText("a")).toBeTruthy();
  expect(screen.getByText("b")).toBeTruthy();
});

test("输入 | 添加 tag", () => {
  const onChange = mock();
  render(<TagInput value={["a"]} onChange={onChange} />);
  const input = screen.getByTestId("tag-input-field") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "b|" } });
  expect(onChange).toHaveBeenCalledWith(["a", "b"]);
});

test("回车添加 tag", () => {
  const onChange = mock();
  render(<TagInput value={["a"]} onChange={onChange} />);
  const input = screen.getByTestId("tag-input-field");
  fireEvent.change(input, { target: { value: "b" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onChange).toHaveBeenCalledWith(["a", "b"]);
});

test("点 × 移除 tag", () => {
  const onChange = mock();
  render(<TagInput value={["a", "b"]} onChange={onChange} />);
  // 第一个 tag 的删除按钮
  const removeBtns = screen.getAllByTestId("tag-remove");
  fireEvent.click(removeBtns[0]);
  expect(onChange).toHaveBeenCalledWith(["b"]);
});

test("粘贴 a|b|c 拆成 3 个", () => {
  const onChange = mock();
  render(<TagInput value={[]} onChange={onChange} />);
  const input = screen.getByTestId("tag-input-field");
  fireEvent.change(input, { target: { value: "a|b|c|" } });
  expect(onChange).toHaveBeenCalledWith(["a", "b", "c"]);
});

test("纯空白不生成 tag", () => {
  const onChange = mock();
  render(<TagInput value={[]} onChange={onChange} />);
  const input = screen.getByTestId("tag-input-field");
  fireEvent.change(input, { target: { value: "   |" } });
  expect(onChange).not.toHaveBeenCalled();
});
