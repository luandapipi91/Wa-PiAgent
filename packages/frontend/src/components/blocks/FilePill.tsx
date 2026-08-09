import { useEffect, useState } from "react";
import { useProjectsStore } from "../../store/projects";
import { useSessionStore } from "../../store/session";
import { Icon } from "../ui/Icon";
import { parseFilePath } from "./file-path";
import { statFile } from "../../fs-client";

/** 从会话找到项目 cwd（相对路径据此拼绝对路径）。ProjectEntity 的路径字段为 cwd */
export function resolveSessionCwd(sessionId: string): string | null {
  const { sessions, projects } = useProjectsStore.getState();
  const s = sessions.find(x => x.id === sessionId);
  const p = projects.find(x => x.id === s?.projectId);
  return p?.cwd ?? null;
}

/** 正斜杠归一化：把反斜杠全部转为正斜杠，合并连续斜杠 */
function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/");
}

export function resolveAbsolutePath(path: string, sessionId: string): string {
  if (path.startsWith("/") || path.startsWith("~")) return path;
  const cwd = resolveSessionCwd(sessionId);
  if (!cwd) return path;
  return normalizeSlashes(cwd.replace(/\/+$/, "") + "/" + path);
}

/** 文件路径胶囊：stat 探测文件存在性，不存在则回退纯文本。点击触发全局文件预览（FilePreviewModal）。 */
export function FilePill({ rawText, sessionId }: { rawText: string; sessionId: string }) {
  const [fileExists, setFileExists] = useState<boolean | null>(null);

  const parsed = parseFilePath(rawText);

  useEffect(() => {
    if (!parsed) return;
    const abs = resolveAbsolutePath(parsed.path, sessionId);
    let alive = true;
    statFile(abs)
      .then(exists => { if (alive) setFileExists(exists); })
      .catch(() => { if (alive) setFileExists(false); });
    return () => { alive = false; };
  }, [parsed?.path, sessionId]);

  if (!parsed) return <code>{rawText}</code>;
  if (fileExists === false) return <code>{rawText}</code>;

  const abs = resolveAbsolutePath(parsed.path, sessionId);
  const base = parsed.path.split("/").pop();
  return (
    <button
      type="button"
      data-testid="file-pill"
      title={abs}
      onClick={() => useSessionStore.getState().openFilePreview(abs, sessionId)}
      className="inline-flex items-center gap-1 px-1.5 py-0 rounded-md border border-hairline bg-surface-elevated text-[calc(12px*var(--font-scale))] font-mono text-accent hover:border-accent transition-colors align-baseline"
      style={{ cursor: "pointer" }}
    >
      <Icon name="file" size={12} /> {base}{parsed.line != null ? `:${parsed.line}` : ""}
    </button>
  );
}
