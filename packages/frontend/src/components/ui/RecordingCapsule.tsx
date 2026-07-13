import { useCallback, useEffect, useRef, useState } from "react";
import { useRecordingStore, type RecordingSource } from "../../store/recording";
import { useProjectsStore } from "../../store/projects";
import { useToastStore } from "../../store/toast";
import { setRecordingPrefs } from "../../store/composer-db";
import { formatDuration } from "../../recording/recorder";

const DEFAULT_RIGHT = 16;
const DEFAULT_TOP = 16;
const CAPSULE_WIDTH = 280;

export function RecordingCapsule() {
  const { status, source, owningSessionId, ownerLabel, elapsedMs, pause, resume, stop } = useRecordingStore();
  const currentSessionId = useProjectsStore(s => s.currentSessionId);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [pos, setPos] = useState(() => ({
    x: typeof window !== "undefined" ? window.innerWidth - DEFAULT_RIGHT - CAPSULE_WIDTH : DEFAULT_RIGHT,
    y: DEFAULT_TOP,
  }));

  const dragRef = useRef(false);
  const offsetRef = useRef({ x: 0, y: 0 });

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    dragRef.current = true;
    offsetRef.current = {
      x: e.clientX - pos.x,
      y: e.clientY - pos.y,
    };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }, [pos.x, pos.y]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    setPos({
      x: e.clientX - offsetRef.current.x,
      y: e.clientY - offsetRef.current.y,
    });
  }, []);

  const onPointerUp = useCallback(() => {
    dragRef.current = false;
  }, []);

  useEffect(() => {
    function onResize() {
      setPos(p => ({
        x: Math.min(Math.max(p.x, 0), window.innerWidth - CAPSULE_WIDTH),
        y: Math.min(Math.max(p.y, 0), window.innerHeight - 80),
      }));
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  if (status === "idle") return null;

  const isOwner = owningSessionId === currentSessionId;
  const dotColor = status === "recording" ? "bg-danger" : "bg-warning";

  async function pickSource(next: RecordingSource) {
    await setRecordingPrefs({ lastSource: next });
    if (status === "idle") {
      useRecordingStore.setState({ source: next });
    } else {
      useToastStore.getState().add(`已切换为${next === "mic" ? "麦克风" : "系统音频"}，下次录音生效`);
    }
    setSwitcherOpen(false);
  }

  return (
    <div
      data-testid="recording-capsule"
      className="fixed z-50 flex flex-col gap-2 px-4 py-3 rounded-lg border border-hairline bg-surface shadow-lg select-none"
      style={{ left: pos.x, top: pos.y, minWidth: CAPSULE_WIDTH }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
    >
      <div
        data-testid="recording-capsule-header"
        className="flex items-center gap-2 cursor-grab active:cursor-grabbing"
        onPointerDown={onPointerDown}
        title="拖动"
      >
        <span className="text-secondary">⠿</span>
        <span className="text-xs font-medium text-secondary">录音中</span>
      </div>

      <div data-testid="recording-capsule-controls" className="flex items-center gap-3 flex-nowrap">
        <div className="relative">
          <button
            type="button"
            aria-label="切换音源"
            title={source === "mic" ? "麦克风" : "系统音频"}
            onClick={() => setSwitcherOpen(o => !o)}
            className="text-xl hover:opacity-80"
          >
            {source === "mic" ? "🎤" : "🖥"}
          </button>
          {switcherOpen && (
            <div className="absolute top-full left-0 mt-1 z-50 bg-surface border border-hairline rounded-sm shadow-md text-xs whitespace-nowrap">
              <button
                type="button"
                onClick={() => pickSource("mic")}
                className={`block w-full text-left px-3 py-1.5 hover:bg-surface-hover ${source === "mic" ? "text-primary" : ""}`}
              >🎤 麦克风</button>
              <button
                type="button"
                onClick={() => pickSource("system")}
                className={`block w-full text-left px-3 py-1.5 hover:bg-surface-hover ${source === "system" ? "text-primary" : ""}`}
              >🖥 系统音频</button>
            </div>
          )}
        </div>
        {!isOwner && <span className="text-xs text-tertiary truncate max-w-[140px]">{ownerLabel}</span>}
        <span data-testid="recording-timer" aria-live="polite" aria-label="录音时长" className="font-mono tabular-nums text-lg text-secondary">{formatDuration(elapsedMs)}</span>
        <span
          data-testid="recording-status-dot"
          className={`inline-block w-2.5 h-2.5 rounded-full ${dotColor} ${status === "recording" ? "animate-pulse" : ""}`}
        />

        <div data-testid="recording-capsule-actions" className="ml-auto flex items-center gap-3">
          {status === "recording"
            ? (
              <button
                type="button"
                aria-label="暂停录音"
                title="暂停录音"
                onClick={pause}
                className="text-xl text-secondary hover:text-primary"
              >⏸</button>
            )
            : (
              <button
                type="button"
                aria-label="继续录音"
                title="继续录音"
                onClick={resume}
                className="text-xl text-secondary hover:text-primary"
              >▶</button>
            )}
          <button
            type="button"
            aria-label="停止录音"
            title="停止录音"
            onClick={() => void stop()}
            className="text-xl text-danger hover:opacity-80"
          >⏹</button>
        </div>
      </div>
    </div>
  );
}
