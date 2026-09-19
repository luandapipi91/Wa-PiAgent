import { useEffect, useState } from "react";
import { useProjectsStore } from "../../store/projects";
import { useSessionStore } from "../../store/session";
import { Icon } from "../ui/Icon";
import { mediaKindOf, parseFilePath } from "./file-path";
import type { MediaItem } from "./media-utils";
import { statFilesBatched } from "../../fs-client";
import { openFileOrPreview } from "../../open-file-preview";

/** 从会话找到项目 cwd（相对路径据此拼绝对路径）。ProjectEntity 的路径字段为 cwd */
export function resolveSessionCwd(sessionId: string): string | null {
  const { sessions, projects } = useProjectsStore.getState();
  const s = sessions.find((x) => x.id === sessionId);
  const p = projects.find((x) => x.id === s?.projectId);
  return p?.cwd ?? null;
}

/** 正斜杠归一化：把反斜杠全部转为正斜杠，合并连续斜杠 */
function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/");
}

export function resolveAbsolutePath(path: string, sessionId: string): string {
  // 已是绝对路径（Windows 盘符 C:\、H:/ 或 Unix /、~）→ 直接返回并归一化正斜杠；
  // 否则视为相对路径，拼项目 cwd。
  if (
    /^[a-zA-Z]:[\\/]/.test(path) ||
    path.startsWith("/") ||
    path.startsWith("~")
  ) {
    return normalizeSlashes(path);
  }
  const cwd = resolveSessionCwd(sessionId);
  if (!cwd) return path;
  return normalizeSlashes(cwd.replace(/\/+$/, "") + "/" + path);
}

/** 文件路径胶囊：stat 探测文件存在性，不存在则回退纯文本。
 *  点击分发：图片/视频扩展名 → MediaPreviewModal 媒体画廊；其余 → 全局文件预览（FilePreviewModal）。
 *  mediaItems：所在文本块的媒体清单（collectMediaItems 收集），传入后点击按绝对路径定位画廊起点。 */
export function FilePill({
  rawText,
  sessionId,
  mediaItems,
}: {
  rawText: string;
  sessionId: string;
  mediaItems?: MediaItem[];
}) {
  const [fileExists, setFileExists] = useState<boolean | null>(null);

  const parsed = parseFilePath(rawText);

  useEffect(() => {
    if (!parsed) return;
    const abs = resolveAbsolutePath(parsed.path, sessionId);
    let alive = true;
    // 批量调度：同一 tick 内挂载的多个 FilePill 会合并成一个 stat-batch 请求
    statFilesBatched([abs])
      .then((m) => {
        if (alive) setFileExists(m.get(abs) === true);
      })
      .catch(() => {
        if (alive) setFileExists(false);
      });
    return () => {
      alive = false;
    };
  }, [parsed?.path, sessionId]);

  if (!parsed) return <code>{rawText}</code>;
  if (fileExists === false) return <code>{rawText}</code>;

  const abs = resolveAbsolutePath(parsed.path, sessionId);
  const base = parsed.path.split("/").pop();
  const kind = mediaKindOf(parsed.path);

  const handleClick = () => {
    if (kind) {
      // 图片/视频路径 → 媒体画廊；无清单时以单媒体打开
      const items = mediaItems?.length
        ? mediaItems
        : [{ src: parsed.path, kind, name: base ?? parsed.path }];
      const idx = items.findIndex(
        (it) =>
          it.kind === kind && resolveAbsolutePath(it.src, sessionId) === abs,
      );
      useSessionStore
        .getState()
        .openMediaPreview(items, Math.max(idx, 0), sessionId);
      return;
    }
    openFileOrPreview(abs, sessionId);
  };

  return (
    <button
      type="button"
      data-testid="file-pill"
      title={abs}
      onClick={handleClick}
      className="inline-flex items-center gap-1 px-1.5 py-0 rounded-md border border-hairline bg-surface-elevated text-[calc(12px*var(--font-scale))] font-mono text-accent hover:border-accent transition-colors align-baseline"
      style={{ cursor: "pointer" }}
    >
      <Icon name="file" size={12} /> {base}
      {parsed.line == null ? "" : `:${parsed.line}`}
    </button>
  );
}
