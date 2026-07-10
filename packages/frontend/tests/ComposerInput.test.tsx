import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useProvidersStore } from "../src/store/providers";

const handlers = new Set<(e: any) => void>();
const sendMock = mock();

mock.module("../src/ws-instance", () => ({
  send: sendMock,
  onMessage: (h: (e: any) => void) => {
    handlers.add(h);
    return () => handlers.delete(h);
  },
}));

import { ComposerInput } from "../src/components/ui/ComposerInput";

beforeEach(() => {
  useProvidersStore.setState({ providers: [] });
  handlers.clear();
  sendMock.mockClear();
});

function renderComposer(props?: Partial<React.ComponentProps<typeof ComposerInput>>) {
  return render(
    <ComposerInput
      text="hello"
      setText={mock()}
      model="gpt-4o"
      setModel={mock()}
      thinking="disabled"
      setThinking={mock()}
      attachments={[]}
      setAttachments={mock() as any}
      projectId="p1"
      onSend={mock()}
      placeholder="输入..."
      {...props}
    />
  );
}

function completeLatestUpload(path: string) {
  const sent = sendMock.mock.calls.find(([e]) => e.type === "fs:upload")?.[0];
  expect(sent).toBeTruthy();
  handlers.forEach(h => h({ type: "fs:upload", id: sent.id, path }));
  return sent;
}

test("calls onSend with text when clicking send", () => {
  const onSend = mock();
  renderComposer({ onSend });
  fireEvent.click(screen.getByTestId("composer-send"));
  expect(onSend).toHaveBeenCalled();
});

test("disables send and shows placeholder when no model is selected", () => {
  useProvidersStore.setState({
    providers: [
      { id: "p1", name: "openai", api: "openai-completions", baseUrl: "", apiKey: "", models: [{ id: "gpt-4o", contextWindow: 128000, maxTokens: 4096 }] },
    ],
  });
  renderComposer({ model: null });
  const select = screen.getByTestId("model-selector") as HTMLSelectElement;
  expect(select.value).toBe("");
  expect(screen.getByText("选择模型")).toBeTruthy();
  expect((screen.getByTestId("composer-send") as HTMLButtonElement).disabled).toBe(true);
});

test("uploads selected file to project directory and adds attachment chip", async () => {
  const setAttachments = mock() as any;
  const file = new File(["hello"], "notes.txt", { type: "text/plain" });

  renderComposer({ setAttachments });

  const input = screen.getByTestId("composer-input").querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });

  await waitFor(() => expect(sendMock).toHaveBeenCalled());
  const sent = completeLatestUpload("/project/p1/.hiagent/uploads/notes.txt");
  expect(sent.projectId).toBe("p1");
  expect(sent.name).toBe("notes.txt");

  await waitFor(() => expect(setAttachments).toHaveBeenCalled());
  const updater = setAttachments.mock.calls[0][0];
  const attachments = updater([]);
  expect(attachments).toHaveLength(1);
  expect(attachments[0]).toMatchObject({
    kind: "file",
    name: "notes.txt",
    path: "/project/p1/.hiagent/uploads/notes.txt",
  });
});

test("uploads pasted file from clipboard", async () => {
  const setAttachments = mock() as any;
  const file = new File(["pasted"], "pasted.txt", { type: "text/plain" });

  renderComposer({ setAttachments });

  const textarea = screen.getByTestId("composer-input").querySelector("textarea")!;
  fireEvent.paste(textarea, { clipboardData: { files: [file] } });

  await waitFor(() => expect(sendMock).toHaveBeenCalled());
  completeLatestUpload("/project/p1/.hiagent/uploads/pasted.txt");

  await waitFor(() => expect(setAttachments).toHaveBeenCalled());
  const attachments = setAttachments.mock.calls[0][0]([]);
  expect(attachments[0]).toMatchObject({ kind: "file", name: "pasted.txt" });
});

test("uploads dropped file into composer", async () => {
  const setAttachments = mock() as any;
  const file = new File(["dropped"], "dropped.png", { type: "image/png" });

  renderComposer({ setAttachments });

  const composer = screen.getByTestId("composer-input").firstChild!;
  fireEvent.drop(composer, { dataTransfer: { files: [file] } });

  await waitFor(() => expect(sendMock).toHaveBeenCalled());
  completeLatestUpload("/project/p1/.hiagent/uploads/dropped.png");

  await waitFor(() => expect(setAttachments).toHaveBeenCalled());
  const attachments = setAttachments.mock.calls[0][0]([]);
  expect(attachments[0]).toMatchObject({ kind: "image", name: "dropped.png" });
});

test("plain text paste is not intercepted", async () => {
  const setText = mock();
  renderComposer({ setText });

  const textarea = screen.getByTestId("composer-input").querySelector("textarea")!;
  fireEvent.paste(textarea, { clipboardData: { files: [] } });

  await new Promise(r => setTimeout(r, 50));
  expect(sendMock).not.toHaveBeenCalled();
});
