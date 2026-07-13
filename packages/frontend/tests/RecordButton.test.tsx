import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { RecordButton } from "../src/components/ui/RecordButton";
import { useRecordingStore } from "../src/store/recording";
import { useProjectsStore } from "../src/store/projects";
import { useToastStore } from "../src/store/toast";
import { getRecordingPrefs, setRecordingPrefs } from "../src/store/composer-db";
import { _setRecordingManager } from "../src/recording/recorder";

// bun test 环境没有 IndexedDB，composer-db 真实实现会静默返回 undefined。
// 这里 mock 成内存实现，让 RecordButton 的偏好读写可测。
let recordingPrefs: { lastSource?: "mic" | "system" } = {};
mock.module("../src/store/composer-db", () => ({
  getRecordingPrefs: async () => ({ ...recordingPrefs }),
  setRecordingPrefs: async (prefs: any) => { recordingPrefs = { ...recordingPrefs, ...prefs }; },
}));

beforeEach(() => {
  recordingPrefs = {};
  useRecordingStore.setState({ status: "idle", source: "mic", owningSessionId: "", ownerLabel: "", elapsedMs: 0 });
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "项目A", cwd: "/tmp", createdAt: 1 }],
    sessions: [{ id: "s1", projectId: "p1", primaryAgent: "dev", title: "会话A", createdAt: 1, lastActivity: 1, piSessionFile: "" }],
  } as any);
  useToastStore.setState({ toasts: [] });
  // 默认引擎桩：start 立即成功
  _setRecordingManager({ start: async () => {}, pause: () => {}, resume: () => {}, stop: async () => ({ path: "", size: 0, durationMs: 0 }) });
});

test("idle 点击 → 用 lastSource 启动（默认 mic）", async () => {
  await setRecordingPrefs({ lastSource: "system" });  // 设上次为 system
  render(<RecordButton sessionId="s1" projectId="p1" />);
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  fireEvent.click(screen.getByLabelText("录音"));
  await waitFor(() => {
    expect(useRecordingStore.getState().status).toBe("recording");
    expect(useRecordingStore.getState().source).toBe("system");
    expect(useRecordingStore.getState().ownerLabel).toBe("项目A · 会话A");
  });
});

test("busy（他会在录）点击 → toast 提示且不启动", async () => {
  useRecordingStore.setState({ status: "recording", owningSessionId: "s9", ownerLabel: "项目B · 会话B" });
  let started = false;
  _setRecordingManager({ start: async () => { started = true; }, pause: () => {}, resume: () => {}, stop: async () => ({ path: "", size: 0, durationMs: 0 }) });
  render(<RecordButton sessionId="s1" projectId="p1" />);
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  fireEvent.click(screen.getByLabelText("录音"));
  await waitFor(() => {
    expect(started).toBe(false);
    expect(useToastStore.getState().toasts[0]?.message).toContain("项目B · 会话B");
    expect(useToastStore.getState().toasts[0]?.message).toContain("正在录音");
  });
});

test("右键 → 弹出音源切换；选 system 更新 lastSource", async () => {
  await setRecordingPrefs({ lastSource: "mic" });
  render(<RecordButton sessionId="s1" projectId="p1" />);
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  fireEvent.contextMenu(screen.getByLabelText("录音"));
  fireEvent.click(screen.getByText(/系统音频/));
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  const prefs = await getRecordingPrefs();
  expect(prefs?.lastSource).toBe("system");
});
