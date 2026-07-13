import { test, expect, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { AttachmentChip } from "../src/components/ui/AttachmentChip";
import type { AttachmentDraft } from "@hiagent/shared";

test("renders file name and calls onRemove", () => {
  const onRemove = mock();
  render(<AttachmentChip attachment={{ kind: "file", name: "a.txt", path: "/tmp/a.txt", size: 100 }} onRemove={onRemove} />);
  expect(screen.getByText("a.txt")).toBeTruthy();
  fireEvent.click(screen.getByTestId("attachment-remove"));
  expect(onRemove).toHaveBeenCalled();
});

test("snippet content is truncated beyond 20 characters", () => {
  const onRemove = mock();
  const longContent = "this is a very long snippet text that should be truncated";
  render(<AttachmentChip attachment={{ kind: "snippet", name: "long-snippet", content: longContent }} onRemove={onRemove} />);
  expect(screen.getByText(longContent.slice(0, 20) + "…")).toBeTruthy();
});

test("folder attachment renders folder icon", () => {
  const onRemove = mock();
  render(
    <AttachmentChip
      attachment={{ kind: "folder", name: "docs", path: "/tmp/docs" }}
      onRemove={onRemove}
    />,
  );
  const chip = screen.getByText("docs").parentElement;
  expect(chip?.textContent).toContain("📁");
});

test("image attachment renders camera icon", () => {
  const onRemove = mock();
  render(
    <AttachmentChip
      attachment={{ kind: "image", name: "cat.png", path: "/tmp/cat.png", size: 1024 }}
      onRemove={onRemove}
    />,
  );
  const chip = screen.getByText("cat.png").parentElement;
  expect(chip?.textContent).toContain("📷");
});

test("remove button has accessible label and type button", () => {
  const onRemove = mock();
  render(<AttachmentChip attachment={{ kind: "file", name: "a.txt", path: "/tmp/a.txt", size: 100 }} onRemove={onRemove} />);
  const removeButton = screen.getByLabelText("移除附件");
  expect(removeButton.tagName).toBe("BUTTON");
  expect((removeButton as HTMLButtonElement).type).toBe("button");
});

test("audio chip 渲染文件名 + <audio> 试听 + 移除按钮", () => {
  const a: AttachmentDraft = { kind: "audio", name: "录音 0:02.webm", path: "/p/.hiagent/uploads/rec.webm", size: 10, durationMs: 2000 };
  const onRemove = () => {};
  render(<AttachmentChip attachment={a} onRemove={onRemove} />);
  expect(screen.getByText("录音 0:02.webm")).toBeTruthy();
  const audio = document.querySelector("audio") as HTMLAudioElement;
  expect(audio).toBeTruthy();
  expect(audio?.getAttribute("src")).toBe("/file?path=" + encodeURIComponent("/p/.hiagent/uploads/rec.webm"));
  expect(screen.getByLabelText("移除附件")).toBeTruthy();
});

test("非 audio（file）chip 不渲染 <audio>", () => {
  const a: AttachmentDraft = { kind: "file", name: "a.txt", path: "/p/a.txt", size: 1 };
  render(<AttachmentChip attachment={a} onRemove={() => {}} />);
  expect(document.querySelector("audio")).toBeNull();
});
