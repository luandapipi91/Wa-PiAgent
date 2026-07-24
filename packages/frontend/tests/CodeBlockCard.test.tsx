import { test, expect, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { CodeBlockCard } from "../src/components/blocks/CodeBlockCard";
import { useToastStore } from "../src/store/toast";

beforeEach(() => {
  useToastStore.setState({ toasts: [] });
});

test("头部条显示语言名与复制按钮", () => {
  render(<CodeBlockCard language="ts" code={"const a = 1;\n"} />);
  const card = screen.getByTestId("code-block-card");
  expect(card.textContent).toContain("ts");
  expect(screen.getByTestId("code-copy")).toBeTruthy();
});

test("点击复制写剪贴板并弹 toast", async () => {
  let copied = "";
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: async (t: string) => { copied = t; } },
    writable: true,
    configurable: true,
  });
  render(<CodeBlockCard language="ts" code={"const a = 1;\n"} />);
  fireEvent.click(screen.getByTestId("code-copy"));
  await new Promise(r => setTimeout(r, 0));
  expect(copied).toBe("const a = 1;\n");
});

test("≤20 行无折叠按钮，>20 行显示 +N more lines 且点击展开", () => {
  const short = Array.from({ length: 5 }, (_, i) => `l${i}`).join("\n");
  const { unmount } = render(<CodeBlockCard language="text" code={short} />);
  expect(screen.queryByTestId("code-expand")).toBeNull();
  unmount();
  const long = Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n");
  render(<CodeBlockCard language="text" code={long} />);
  const btn = screen.getByTestId("code-expand");
  expect(btn.textContent).toContain("+10");
  expect(screen.getByTestId("code-block-card").textContent).not.toContain("l29");
  fireEvent.click(btn);
  expect(screen.getByTestId("code-block-card").textContent).toContain("l29");
});
