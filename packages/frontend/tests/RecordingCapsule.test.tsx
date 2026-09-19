import { test, expect, beforeEach } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { RecordingCapsule } from "../src/components/ui/RecordingCapsule";
import { useRecordingStore } from "../src/store/recording";
import { useProjectsStore } from "../src/store/projects";
import { useToastStore } from "../src/store/toast";
import { _setRecordingManager, type RecordingEngine } from "../src/recording/recorder";

function fakeEngine(spies?: { paused?: () => void; resumed?: () => void; stopped?: () => void }): RecordingEngine {
  return {
    start: async () => {},
    pause: () => { spies?.paused?.(); },
    resume: () => { spies?.resumed?.(); },
    stop: async () => { spies?.stopped?.(); return { path: "", size: 0, durationMs: 0 }; },
  };
}

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
  });
  useProjectsStore.setState({ currentSessionId: "s1" } as any);
  useToastStore.setState({ toasts: [] });
  _setRecordingManager({ start: async () => {}, pause: () => {}, resume: () => {}, stop: async () => ({ path: "", size: 0, durationMs: 0 }) });
});

test("idle 时不渲染", () => {
  render(<RecordingCapsule />);
  expect(screen.queryByTestId("recording-capsule")).toBeNull();
});

test("recording：显示计时、音源、暂停 + 停止；点停止调 store.stop", async () => {
  useRecordingStore.setState({ status: "recording", source: "system", owningSessionId: "s1", ownerLabel: "项目A · 会话A", elapsedMs: 65000 });
  let stopped = false;
  _setRecordingManager(fakeEngine({ stopped: () => { stopped = true; } }));
  render(<RecordingCapsule />);
  expect(screen.getByText("1:05")).toBeTruthy();           // formatDuration(65000)
  expect(screen.getByText("🖥")).toBeTruthy();              // 系统音频 icon
  fireEvent.click(screen.getByLabelText("停止录音"));
  await waitFor(() => expect(stopped).toBe(true));
});

test("paused：显示继续按钮", () => {
  useRecordingStore.setState({ status: "paused", source: "mic", owningSessionId: "s1", ownerLabel: "x", elapsedMs: 1000 });
  render(<RecordingCapsule />);
  expect(screen.getByLabelText("继续录音")).toBeTruthy();
});

test("非归属会话：显示 ownerLabel", () => {
  useProjectsStore.setState({ currentSessionId: "s-other" } as any);
  useRecordingStore.setState({ status: "recording", source: "mic", owningSessionId: "s1", ownerLabel: "项目A · 会话A", elapsedMs: 0 });
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
  useRecordingStore.setState({ status: "recording", source: "mic", owningSessionId: "s1", ownerLabel: "x", elapsedMs: 1000 });
  _setRecordingManager(fakeEngine({ paused: () => { paused = true; } }));
  render(<RecordingCapsule />);
  fireEvent.click(screen.getByLabelText("暂停录音"));
  expect(paused).toBe(true);
});

test("点击继续调用 store.resume", () => {
  let resumed = false;
  useRecordingStore.setState({ status: "paused", source: "mic", owningSessionId: "s1", ownerLabel: "x", elapsedMs: 1000 });
  _setRecordingManager(fakeEngine({ resumed: () => { resumed = true; } }));
  render(<RecordingCapsule />);
  fireEvent.click(screen.getByLabelText("继续录音"));
  expect(resumed).toBe(true);
});

test("录音胶囊宽度足够且图标不换行", () => {
  useRecordingStore.setState({ status: "recording", source: "mic", owningSessionId: "s1", ownerLabel: "x", elapsedMs: 1000 });
  render(<RecordingCapsule />);
  const capsule = screen.getByTestId("recording-capsule");
  expect(parseInt(capsule.style.minWidth, 10)).toBeGreaterThanOrEqual(280);
  const row = capsule.querySelector("[class*='flex-nowrap']");
  expect(row).toBeTruthy();
});

test("点击音源 icon 展开切换选项", () => {
  useRecordingStore.setState({ status: "recording", source: "mic", owningSessionId: "s1", ownerLabel: "x", elapsedMs: 1000 });
  render(<RecordingCapsule />);
  expect(screen.queryByText("切换音源")).toBeNull();
  const icon = screen.getByLabelText("切换音源");
  fireEvent.click(icon);
  expect(screen.getByText("🎤 麦克风")).toBeTruthy();
  expect(screen.getByText("🖥 系统音频")).toBeTruthy();
});

test("录音状态小圆点位于时间后、暂停/停止靠右", () => {
  useRecordingStore.setState({ status: "recording", source: "mic", owningSessionId: "s1", ownerLabel: "x", elapsedMs: 1000 });
  render(<RecordingCapsule />);
  const dot = screen.getByTestId("recording-status-dot");
  const timer = screen.getByTestId("recording-timer");
  const pause = screen.getByLabelText("暂停录音");
  const stop = screen.getByLabelText("停止录音");
  const actions = screen.getByTestId("recording-capsule-actions");
  const controls = screen.getByTestId("recording-capsule-controls");

  // timer 在 dot 之前；操作按钮容器在 dot 之后
  expect(dot.compareDocumentPosition(timer) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  expect(dot.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // 暂停、停止在操作容器内，且容器靠右（ml-auto）
  expect(actions.contains(pause)).toBe(true);
  expect(actions.contains(stop)).toBe(true);
  expect(actions.className).toContain("ml-auto");
  // 操作容器是控制行最后一个子元素
  expect(controls.lastElementChild).toBe(actions);
});
