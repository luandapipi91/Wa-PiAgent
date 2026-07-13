import { useRecordingStore } from "../../store/recording";
import { useProjectsStore } from "../../store/projects";
import { formatDuration } from "../../recording/recorder";

export function RecordingCapsule() {
  const { status, source, owningSessionId, ownerLabel, elapsedMs, pause, resume, stop } = useRecordingStore();
  const currentSessionId = useProjectsStore(s => s.currentSessionId);
  if (status === "idle") return null;
  const isOwner = owningSessionId === currentSessionId;
  const dotColor = status === "recording" ? "bg-danger" : "bg-warning";

  return (
    <div
      data-testid="recording-capsule"
      className="inline-flex items-center gap-2 px-2.5 py-1 rounded-pill border border-hairline bg-surface text-xs"
    >
      <span>{source === "mic" ? "🎤" : "🖥"}</span>
      {!isOwner && <span className="text-tertiary">{ownerLabel}</span>}
      <span className="font-mono tabular-nums text-secondary">{formatDuration(elapsedMs)}</span>
      <span className={`inline-block w-2 h-2 rounded-full ${dotColor} ${status === "recording" ? "animate-pulse" : ""}`} />
      {status === "recording"
        ? <button type="button" aria-label="暂停录音" onClick={pause} className="text-secondary hover:text-primary">⏸</button>
        : <button type="button" aria-label="继续录音" onClick={resume} className="text-secondary hover:text-primary">▶</button>}
      <button type="button" aria-label="停止录音" onClick={() => void stop()} className="text-danger hover:opacity-80">⏹</button>
    </div>
  );
}
