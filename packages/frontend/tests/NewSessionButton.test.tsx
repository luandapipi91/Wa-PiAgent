import { test, expect, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { NewSessionButton } from "../src/components/NewSessionButton";

test("点击触发 onNewSession", () => {
  const fn = mock();
  render(<NewSessionButton onNewSession={fn} />);
  fireEvent.click(screen.getByTestId("new-session-btn"));
  expect(fn).toHaveBeenCalledOnce();
});
