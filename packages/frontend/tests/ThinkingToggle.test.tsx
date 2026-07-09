import { test, expect, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { ThinkingToggle } from "../src/components/ui/ThinkingToggle";

test("在 disabled 和 high 之间切换", () => {
  const onChange = mock();
  render(<ThinkingToggle value="disabled" onChange={onChange} />);
  fireEvent.click(screen.getByTestId("thinking-toggle"));
  expect(onChange).toHaveBeenCalledWith("high");
});
