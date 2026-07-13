import { test, expect, beforeEach } from "bun:test";
import { useRecordingStore } from "../src/store/recording";
import { useComposerPrefsStore } from "../src/store/composer-prefs";
import { _setRecordingManager, type RecordingEngine, type StartArgs, type RecordingResult } from "../src/recording/recorder";

beforeEach(() => {
  useRecordingStore.setState({
    status: "idle", source: "mic", owningProjectId: "", owningSessionId: "",
    ownerLabel: "", startedAt: 0, elapsedMs: 0, error: undefined,
  });
  useComposerPrefsStore.setState({ bySession: {} });
});

function fakeEngine(): { engine: RecordingEngine; startArgs: StartArgs | null; stopped: boolean } {
  let startArgs: StartArgs | null = null;
  const engine: RecordingEngine = {
    start: async (a) => { startArgs = a; },
    pause: () => {},
    resume: () => {},
    stop: async (): Promise<RecordingResult> => ({ path: "/p/uploads/rec.webm", size: 100, durationMs: 2000 }),
  };
  return { engine, get startArgs() { return startArgs; }, stopped: false } as any;
}

test("start 进入 recording 并记录归属", async () => {
  const f = fakeEngine(); _setRecordingManager(f.engine);
  await useRecordingStore.getState().start({ source: "system", projectId: "p1", sessionId: "s1", ownerLabel: "项目A · 会话A" });
  const s = useRecordingStore.getState();
  expect(s.status).toBe("recording");
  expect(s.source).toBe("system");
  expect(s.owningSessionId).toBe("s1");
  expect(s.ownerLabel).toBe("项目A · 会话A");
});

test("start 时 onTick 回写 elapsedMs", async () => {
  const f = fakeEngine(); _setRecordingManager(f.engine);
  await useRecordingStore.getState().start({ source: "mic", projectId: "p1", sessionId: "s1", ownerLabel: "x" });
  const args = f.startArgs as (StartArgs & { onTick: (ms: number) => void }) | null;
  expect(args).not.toBeNull();
  args!.onTick(5000);
  expect(useRecordingStore.getState().elapsedMs).toBe(5000);
});

test("非 idle 时 start 被拒（busy），不调用 engine.start", async () => {
  let called = false;
  const engine: RecordingEngine = { start: async () => { called = true; }, pause: () => {}, resume: () => {}, stop: async () => ({ path: "", size: 0, durationMs: 0 }) };
  _setRecordingManager(engine);
  useRecordingStore.setState({ status: "recording", owningSessionId: "s1", ownerLabel: "项目A · 会话A" });
  await expect(useRecordingStore.getState().start({ source: "mic", projectId: "p2", sessionId: "s2", ownerLabel: "y" }))
    .rejects.toThrow(/正在录音/);
  expect(called).toBe(false);
});

test("pause/resume 切换 status", async () => {
  const f = fakeEngine(); _setRecordingManager(f.engine);
  await useRecordingStore.getState().start({ source: "mic", projectId: "p1", sessionId: "s1", ownerLabel: "x" });
  useRecordingStore.getState().pause();
  expect(useRecordingStore.getState().status).toBe("paused");
  useRecordingStore.getState().resume();
  expect(useRecordingStore.getState().status).toBe("recording");
});

test("stop 成功后：idle + audio draft 写入归属会话 composer", async () => {
  const f = fakeEngine(); _setRecordingManager(f.engine);
  await useRecordingStore.getState().start({ source: "mic", projectId: "p1", sessionId: "s1", ownerLabel: "x" });
  useComposerPrefsStore.setState({ bySession: { s1: { model: null, thinking: "disabled", attachments: [] } } });
  await useRecordingStore.getState().stop();
  expect(useRecordingStore.getState().status).toBe("idle");
  const drafts = useComposerPrefsStore.getState().bySession["s1"].attachments;
  expect(drafts.length).toBe(1);
  expect(drafts[0].kind).toBe("audio");
  expect((drafts[0] as any).path).toBe("/p/uploads/rec.webm");
});

test("start 失败：status 回 idle + error，且 rethrow", async () => {
  const engine: RecordingEngine = { start: async () => { throw new Error("无设备"); }, pause: () => {}, resume: () => {}, stop: async () => ({ path: "", size: 0, durationMs: 0 }) };
  _setRecordingManager(engine);
  await expect(useRecordingStore.getState().start({ source: "mic", projectId: "p1", sessionId: "s1", ownerLabel: "x" })).rejects.toThrow("无设备");
  expect(useRecordingStore.getState().status).toBe("idle");
  expect(useRecordingStore.getState().error).toBe("无设备");
});
