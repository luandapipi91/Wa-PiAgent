import { useEffect, useRef, useState } from "react";
import { useRecordingStore } from "../../store/recording";
import { useProjectsStore } from "../../store/projects";
import { useToastStore } from "../../store/toast";
import { useTranslation } from "../../i18n/useTranslation";
import { getRecordingPrefs, setRecordingPrefs, type RecordingPrefs } from "../../store/composer-db";

interface Props { sessionId: string; projectId?: string; }

export function RecordButton({ sessionId, projectId }: Props) {
  const status = useRecordingStore(s => s.status);
  const start = useRecordingStore(s => s.start);
  const [lastSource, setLastSource] = useState<"mic" | "system">("system");
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const { t } = useTranslation();

  useEffect(() => { void getRecordingPrefs().then(p => { if (p?.lastSource) setLastSource(p.lastSource); }); }, []);

  const busy = status !== "idle";

  async function handleClick() {
    if (busy) {
      const { ownerLabel } = useRecordingStore.getState();
      useToastStore.getState().add(t("ui.recording.busyConflict", { owner: ownerLabel }));
      return;
    }
    const source = (await getRecordingPrefs())?.lastSource ?? lastSource;
    try {
      await start({ source, projectId: projectId ?? "", sessionId, ownerLabel: buildOwnerLabel() });
    } catch (e) {
      useToastStore.getState().add(e instanceof Error ? e.message : t("ui.recording.startFailed"));
    }
  }

  function buildOwnerLabel(): string {
    const { projects, sessions } = useProjectsStore.getState();
    const session = sessions.find(s => s.id === sessionId);
    const project = projects.find(p => p.id === (session?.projectId ?? projectId));
    return `${project?.name ?? t("ui.recording.defaultProject")} · ${session?.title ?? t("ui.recording.defaultSession")}`;
  }

  function openSwitcher() {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
    setSwitcherOpen(true);
  }

  async function pickSource(src: "mic" | "system") {
    setLastSource(src);
    await setRecordingPrefs({ lastSource: src } as RecordingPrefs);
    setSwitcherOpen(false);
  }

  useEffect(() => {
    const el = btnRef.current;
    if (!el) return;
    const handler = (e: Event) => {
      e.preventDefault();
      openSwitcher();
    };
    // happy-dom 不会把 contextmenu 派发到 React 合成事件，这里额外监听原生事件以保证测试可触发
    el.addEventListener("contextmenu", handler);
    return () => el.removeEventListener("contextmenu", handler);
  }, []);

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        aria-label={t("ui.recording.ariaLabel")}
        data-testid="record-button"
        onClick={handleClick}
        onContextMenu={(e) => { e.preventDefault(); openSwitcher(); }}
        onTouchStart={() => { longPressTimer.current = setTimeout(openSwitcher, 500); }}
        onTouchEnd={() => { if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; } }}
        title={t("ui.recording.titleWithCurrent", { current: lastSource === "mic" ? t("ui.recording.sourceMic") : t("ui.recording.sourceSystem") })}
        className={`text-lg ${status === "recording" ? "text-danger animate-pulse" : status === "paused" ? "text-tertiary cursor-not-allowed" : "text-secondary hover:text-primary"}`}
      >🎙</button>
      {switcherOpen && (
        <div className="absolute bottom-full mb-2 left-0 z-10 bg-surface border border-hairline rounded-sm shadow-md text-xs" data-testid="record-source-switcher">
          <button type="button" onClick={() => pickSource("mic")} className="block w-full text-left px-3 py-1.5 hover:bg-surface-hover">{t("ui.recording.micOption")}</button>
          <button type="button" onClick={() => pickSource("system")} className="block w-full text-left px-3 py-1.5 hover:bg-surface-hover">{t("ui.recording.systemOption")}</button>
        </div>
      )}
    </div>
  );
}
