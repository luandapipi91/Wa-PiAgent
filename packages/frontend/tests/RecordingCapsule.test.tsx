import { test, expect, beforeEach } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { RecordingCapsule } from "../src/components/ui/RecordingCapsule";
import { useRecordingStore } from "../src/store/recording";
import { useProjectsStore } from "../src/store/projects";

const { start: originalStart, pause: originalPause, resume: originalResume, stop: originalStop } = useRecordingStore.getState();

beforeEach(() => {
  useRecordingStore.setState({
    status: "idle",
    source: "mic",
    owningProjectId: "",
    owningSessionId: "",
    ownerLabel: "",
    startedAt: 0,
    elapsedMs: 0,
    error: undefined,
    start: originalStart,
    pause: originalPause,
    resume: originalResume,
    stop: originalStop,
  });
  useProjectsStore.setState({ currentSessionId: "s1" } as any);
});

test("idle 时不渲染", () => {
  render(<RecordingCapsule />);
  expect(screen.queryByTestId("recording-capsule")).toBeNull();
});

test("recording：显示计时、音源、暂停 + 停止；点停止调 store.stop", async () => {
  useRecordingStore.setState({ status: "recording", source: "system", owningSessionId: "s1", ownerLabel: "项目A · 会话A", elapsedMs: 65000 });
  let stopped = false;
  useRecordingStore.setState({ stop: async () => { stopped = true; } } as any);
  render(<RecordingCapsule />);
  expect(screen.getByText("1:05")).toBeTruthy();           // formatDuration(65000)
  expect(screen.getByText("🖥")).toBeTruthy();              // 系统音频 icon
  fireEvent.click(screen.getByLabelText("停止录音"));
  await waitFor(() => expect(stopped).toBe(true));
});

test("paused：显示继续按钮", () => {
  useRecordingStore.setState({ status: "paused", source: "mic", owningSessionId: "s1", ownerLabel: "x", elapsedMs: 1000 });
  useRecordingStore.setState({ resume: () => {}, stop: async () => {} } as any);
  render(<RecordingCapsule />);
  expect(screen.getByLabelText("继续录音")).toBeTruthy();
});

test("非归属会话：显示 ownerLabel", () => {
  useProjectsStore.setState({ currentSessionId: "s-other" } as any);
  useRecordingStore.setState({ status: "recording", source: "mic", owningSessionId: "s1", ownerLabel: "项目A · 会话A", elapsedMs: 0 });
  useRecordingStore.setState({ pause: () => {}, stop: async () => {} } as any);
  render(<RecordingCapsule />);
  expect(screen.getByText("项目A · 会话A")).toBeTruthy();
});

test("recording 时阻止 beforeunload，idle 时不阻止", () => {
  useRecordingStore.setState({ status: "recording" });
  const e = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(e);
  expect(e.defaultPrevented).toBe(true);
  expect((e as BeforeUnloadEvent).returnValue).toBe("正在录音，退出将丢失未保存录音");

  useRecordingStore.setState({ status: "idle" });
  const e2 = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(e2);
  expect(e2.defaultPrevented).toBe(false);
});

test("点击暂停调用 store.pause", () => {
  let paused = false;
  useRecordingStore.setState({
    status: "recording", source: "mic", owningSessionId: "s1", ownerLabel: "x", elapsedMs: 1000,
    pause: () => { paused = true; },
    resume: () => {},
    stop: async () => ({ path: "", size: 0, durationMs: 0 }),
  } as any);
  render(<RecordingCapsule />);
  fireEvent.click(screen.getByLabelText("暂停录音"));
  expect(paused).toBe(true);
});

test("点击继续调用 store.resume", () => {
  let resumed = false;
  useRecordingStore.setState({
    status: "paused", source: "mic", owningSessionId: "s1", ownerLabel: "x", elapsedMs: 1000,
    pause: () => {},
    resume: () => { resumed = true; },
    stop: async () => ({ path: "", size: 0, durationMs: 0 }),
  } as any);
  render(<RecordingCapsule />);
  fireEvent.click(screen.getByLabelText("继续录音"));
  expect(resumed).toBe(true);
});
