import { test, expect, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { AttachmentPathModal } from "../src/components/ui/AttachmentPathModal";

test("returns entered absolute path on confirm", () => {
  const onConfirm = mock();
  const onCancel = mock();
  render(<AttachmentPathModal fileName="a.txt" onConfirm={onConfirm} onCancel={onCancel} />);
  fireEvent.change(screen.getByTestId("path-input"), { target: { value: "/tmp/a.txt" } });
  fireEvent.click(screen.getByTestId("confirm-path"));
  expect(onConfirm).toHaveBeenCalledWith("/tmp/a.txt");
});
