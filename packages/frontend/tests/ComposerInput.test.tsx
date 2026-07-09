import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { ComposerInput } from "../src/components/ui/ComposerInput";
import { useProvidersStore } from "../src/store/providers";

beforeEach(() => {
  useProvidersStore.setState({ providers: [] });
});

test("calls onSend with text when clicking send", () => {
  const onSend = mock();
  render(
    <ComposerInput
      text="hello"
      setText={mock()}
      model={null}
      setModel={mock()}
      thinking="disabled"
      setThinking={mock()}
      attachments={[]}
      setAttachments={mock()}
      onSend={onSend}
      placeholder="输入..."
    />
  );
  fireEvent.click(screen.getByTestId("composer-send"));
  expect(onSend).toHaveBeenCalled();
});
