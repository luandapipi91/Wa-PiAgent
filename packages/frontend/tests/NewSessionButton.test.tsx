import { test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NewSessionButton } from "../src/components/NewSessionButton";

test("点击触发 onNewSession", () => {
  const fn = vi.fn();
  render(<NewSessionButton onNewSession={fn} />);
  fireEvent.click(screen.getByTestId("new-session-btn"));
  expect(fn).toHaveBeenCalledOnce();
});
