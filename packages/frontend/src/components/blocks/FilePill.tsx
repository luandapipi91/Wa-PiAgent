import { useEffect, useState } from "react";
import { useProjectsStore } from "../../store/projects";
import { parseFilePath } from "./file-path";
import { readFile } from "../../fs-client";
import { FilePreviewModal } from "./FilePreviewModal";

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

/** 文件路径胶囊：先异步校验文件是否存在，存在才显示胶囊，否则回退为纯文本 */
export function FilePill({ rawText, sessionId }: { rawText: string; sessionId: string }) {
  const [preview, setPreview] = useState(false);
  const [fileExists, setFileExists] = useState<boolean | null>(null); // null=校验中

  const parsed = parseFilePath(rawText);

  useEffect(() => {
    if (!parsed) return;
    const abs = resolveAbsolutePath(parsed.path, sessionId);
    let alive = true;
    readFile(abs)
      .then(() => { if (alive) setFileExists(true); })
      .catch(() => { if (alive) setFileExists(false); });
    return () => { alive = false; };
  }, [parsed?.path, sessionId]);

  if (!parsed) return <code>{rawText}</code>;
  // 校验失败（文件不存在）→ 回退为纯文本
  if (fileExists === false) return <code>{rawText}</code>;

  const abs = resolveAbsolutePath(parsed.path, sessionId);
  const base = parsed.path.split("/").pop();
  return (
    <>
      <button
        type="button"
        data-testid="file-pill"
        title={abs}
        onClick={() => setPreview(true)}
        className="inline-flex items-center gap-1 px-1.5 py-0 rounded-md border border-hairline bg-surface-elevated text-[12px] font-mono text-accent hover:border-accent transition-colors align-baseline"
        style={{ cursor: "pointer" }}
      >
        📄 {base}{parsed.line != null ? `:${parsed.line}` : ""}
      </button>
      {preview && <FilePreviewModal absPath={abs} onClose={() => setPreview(false)} />}
    </>
  );
}
