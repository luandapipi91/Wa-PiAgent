import { test, expect, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { AttachmentChip } from "../src/components/ui/AttachmentChip";

test("renders file name and calls onRemove", () => {
  const onRemove = mock();
  render(<AttachmentChip attachment={{ kind: "file", name: "a.txt", path: "/tmp/a.txt", size: 100 }} onRemove={onRemove} />);
  expect(screen.getByText("a.txt")).toBeTruthy();
  fireEvent.click(screen.getByTestId("attachment-remove"));
  expect(onRemove).toHaveBeenCalled();
});
