import { create } from "zustand";
import i18n from "../i18n";
import type { AttachmentDraft } from "@wa-pi/shared";
import { getRecordingManager, formatDuration, type StartArgs, type RecordingResult } from "../recording/recorder";
import { useComposerPrefsStore } from "./composer-prefs";

export type RecordingStatus = "idle" | "recording" | "paused";
export type RecordingSource = "mic" | "system";

interface StartOpts { source: RecordingSource; projectId: string; sessionId: string; ownerLabel: string; }

interface RecordingState {
  status: RecordingStatus;
  source: RecordingSource;
  owningProjectId: string;
  owningSessionId: string;
  ownerLabel: string;
  startedAt: number;
  elapsedMs: number;
  error?: string;
  start(opts: StartOpts): Promise<void>;
  pause(): void;
  resume(): void;
  stop(): Promise<void>;
}

export const useRecordingStore = create<RecordingState>((set, get) => ({
  status: "idle",
  source: "system",
  owningProjectId: "",
  owningSessionId: "",
  ownerLabel: "",
  startedAt: 0,
  elapsedMs: 0,

  start: async (opts) => {
    if (get().status !== "idle") {
      throw new Error(i18n.t("ui.recording.busyConflict", { owner: get().ownerLabel }));
    }
    set({ error: undefined });
    try {
      await getRecordingManager().start({
        source: opts.source,
        projectId: opts.projectId,
        sessionId: opts.sessionId,
        ownerLabel: opts.ownerLabel,
        onTick: (elapsedMs) => set({ elapsedMs }),
      });
      set({
        status: "recording",
        source: opts.source,
        owningProjectId: opts.projectId,
        owningSessionId: opts.sessionId,
        ownerLabel: opts.ownerLabel,
        startedAt: Date.now(),
        elapsedMs: 0,
      });
    } catch (e) {
      set({ status: "idle", error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  },

  pause: () => {
    if (get().status !== "recording") return;
    getRecordingManager().pause();
    set({ status: "paused" });
  },

  resume: () => {
    if (get().status !== "paused") return;
    getRecordingManager().resume();
    set({ status: "recording" });
  },

  stop: async () => {
    if (get().status === "idle") return;
    const owningSessionId = get().owningSessionId;
    try {
      const result: RecordingResult = await getRecordingManager().stop();
      // audio draft 写入归属会话 composer
      const draft: AttachmentDraft = {
        kind: "audio" as const,
        name: i18n.t("store.recordingFile", { duration: formatDuration(result.durationMs) }),
        path: result.path,
        size: result.size,
        ...(result.durationMs ? { durationMs: result.durationMs } : {}),
      };
      const existing = useComposerPrefsStore.getState().bySession[owningSessionId]?.attachments ?? [];
      useComposerPrefsStore.getState().setSessionPrefs(owningSessionId, { attachments: [...existing, draft] });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ status: "idle", elapsedMs: 0, startedAt: 0 });
    }
  },
}));

function beforeUnloadHandler(e: BeforeUnloadEvent) {
  e.preventDefault();
  e.returnValue = i18n.t("ui.recording.beforeunloadWarn");
}

let beforeUnloadRegistered = false;
useRecordingStore.subscribe((state, prevState) => {
  if (state.status === prevState?.status) return;
  const active = state.status !== "idle";
  if (active === beforeUnloadRegistered) return;
  if (active) {
    window.addEventListener("beforeunload", beforeUnloadHandler);
    beforeUnloadRegistered = true;
  } else {
    window.removeEventListener("beforeunload", beforeUnloadHandler);
    beforeUnloadRegistered = false;
  }
});
