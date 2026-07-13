import { create } from "zustand";
import type { AttachmentDraft } from "@hiagent/shared";
import { getRecordingManager, type StartArgs, type RecordingResult } from "../recording/recorder";
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
  source: "mic",
  owningProjectId: "",
  owningSessionId: "",
  ownerLabel: "",
  startedAt: 0,
  elapsedMs: 0,

  start: async (opts) => {
    if (get().status !== "idle") {
      throw new Error(`${get().ownerLabel} 正在录音，需要等到上一个录音结束才能开始新的录音`);
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
        kind: "audio",
        name: result.path.split(/[\\/]/).pop() ?? "recording.webm",
        path: result.path,
        size: result.size,
        ...(result.durationMs ? { durationMs: result.durationMs } : {}),
      } as AttachmentDraft;
      const existing = useComposerPrefsStore.getState().bySession[owningSessionId]?.attachments ?? [];
      useComposerPrefsStore.getState().setSessionPrefs(owningSessionId, { attachments: [...existing, draft] });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ status: "idle", elapsedMs: 0, startedAt: 0 });
    }
  },
}));
