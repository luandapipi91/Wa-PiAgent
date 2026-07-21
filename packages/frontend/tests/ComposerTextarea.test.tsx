import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ComposerTextarea } from "../src/components/ui/ComposerTextarea";
import { registerAgentMeta, clearAgentMeta } from "../src/quick-invoke/tokens";

beforeEach(() => {
  document.body.innerHTML = "";
});

test("渲染初始文本", () => {
  render(<ComposerTextarea text="hello" onTextChange={mock()} onKeyDown={mock()} onPaste={mock()} />);
  expect(screen.getByRole("textbox").textContent).toBe("hello");
});

test("渲染文件 chip（#[...]，绿色 chip-file）", () => {
  render(<ComposerTextarea text="看 #[App.tsx]" onTextChange={mock()} onKeyDown={mock()} onPaste={mock()} />);
  const chip = screen.getByText("#App.tsx");
  expect(chip.className).toContain("chip-file");
  expect(chip.getAttribute("data-token")).toBe("#[App.tsx]");
});

test("渲染技能 chip", () => {
  render(<ComposerTextarea text="用 $[brainstorm]" onTextChange={mock()} onKeyDown={mock()} onPaste={mock()} />);
  const chip = screen.getByText("$brainstorm");
  expect(chip.className).toContain("chip-skill");
});

test("渲染智能体 chip（@[...]，蓝色 chip-agent）", () => {
  render(<ComposerTextarea text="@[代码审查] 帮我看看" onTextChange={mock()} onKeyDown={mock()} onPaste={mock()} />);
  const chip = screen.getByText("@代码审查");
  expect(chip.className).toContain("chip-agent");
  expect(chip.getAttribute("data-token")).toBe("@[代码审查]");
});

test("agent chip 有头像时，@ 在 avatar 之前（最前面）", () => {
  // 注册智能体头像信息，模拟 ComposerTextarea 中带 avatar 的 chip 渲染
  registerAgentMeta("代码审查", { avatar: "🔍", avatarColor: "#0891b2" });
  render(<ComposerTextarea text="@[代码审查]" onTextChange={mock()} onKeyDown={mock()} onPaste={mock()} />);
  const chip = document.querySelector(".chip-agent");
  expect(chip).toBeTruthy();
  // chip 内部结构应为：@ [avatar span] 名称（@ 在最前面）
  const html = chip!.innerHTML;
  // @ 符号在 avatar span 之前
  const atIdx = html.indexOf("@");
  const avatarIdx = html.indexOf("chip-agent-avatar");
  expect(atIdx).toBeGreaterThanOrEqual(0);
  expect(avatarIdx).toBeGreaterThan(atIdx);
  // 头像 emoji 在 @ 之后、名称之前
  const emojiIdx = html.indexOf("🔍");
  const nameIdx = html.indexOf("代码审查", avatarIdx);
  expect(emojiIdx).toBeGreaterThan(atIdx);
  expect(nameIdx).toBeGreaterThan(emojiIdx);
  // 清理全局状态，避免影响其他测试
  clearAgentMeta();
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
  render(<ComposerTextarea text="#[file.ts]" onTextChange={mock()} onKeyDown={mock()} onPaste={mock()} />);
  const chip = screen.getByText("#file.ts");
  expect(chip.getAttribute("contenteditable")).toBe("false");
});

test("chip 的 data-token 在 DOM 文本提取时保留", () => {
  const onTextChange = mock();
  render(<ComposerTextarea text="#[file.ts] end" onTextChange={onTextChange} onKeyDown={mock()} onPaste={mock()} />);
  const el = screen.getByRole("textbox") as HTMLElement;
  // 模拟在 chip 后输入
  el.focus();
  // 在末尾追加文本节点
  el.appendChild(document.createTextNode(" more"));
  fireEvent.input(el);
  // onTextChange 应该收到 token + 新文本
  expect(onTextChange).toHaveBeenCalledWith("#[file.ts] end more");
});
