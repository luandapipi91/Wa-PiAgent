import { useState } from "react";
import ReactDiffViewer from "react-diff-viewer-continued";
import { useTranslation } from "../../i18n/useTranslation";
import { resolveAbsolutePath } from "./FilePill";
import { ShareButton } from "../ui/ShareButton";
import { openFileOrPreview } from "../../open-file-preview";
import type { FileChangeSnapshot } from "@wa-pi/shared";

export function FileChangeSummary({
  sessionId,
  files,
}: {
  sessionId: string;
  files: FileChangeSnapshot[];
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (files.length === 0) return null;

  return (
    <div className="flex flex-col gap-1" data-testid="file-change-summary">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 text-[calc(11px*var(--font-scale))] text-tertiary select-none"
      >
        <span className="flex-1 border-t border-hairline" />
        <span className="whitespace-nowrap">
          📄 {t("blocks.fileChanges.title", { count: files.length })}
        </span>
        <span className="whitespace-nowrap">{open ? "▾" : "▸"}</span>
        <span className="flex-1 border-t border-hairline" />
      </button>
      {open && (
        <div className="flex flex-col gap-0.5">
          {files.map((f) => (
            <FileChangeItem key={f.path} sessionId={sessionId} file={f} />
          ))}
        </div>
      )}
    </div>
  );
}

function FileChangeItem({
  sessionId,
  file,
}: {
  sessionId: string;
  file: FileChangeSnapshot;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const abs = resolveAbsolutePath(file.path, sessionId);
  const movedToAbs = file.movedTo
    ? resolveAbsolutePath(file.movedTo, sessionId)
    : null;
  // 失效且找不回新位置：路径已不存在，打开/预览/分享全部禁用（diff 内容仍在可展开）
  const gone = file.missing === true && !movedToAbs;
  const targetAbs = movedToAbs ?? abs;
  const isAdded = file.before === null && !file.error && !file.oversized;
  const canDiff = file.before != null && !file.error && !file.oversized;
  const label = file.missing
    ? t("blocks.fileChanges.missing")
    : file.error
      ? t("blocks.fileChanges.readError")
      : file.oversized
        ? t("blocks.fileChanges.tooLarge")
        : isAdded
          ? t("blocks.fileChanges.added")
          : t("blocks.fileChanges.modified");

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 px-1 py-1">
        <span
          className={`text-[11px] font-semibold rounded px-1 ${
            isAdded
              ? "bg-success-soft text-success"
              : "bg-warning-soft text-warning"
          }`}
        >
          {label}
        </span>
        {gone ? (
          <span className="font-mono text-[12px] text-tertiary line-through">
            {file.path}
          </span>
        ) : (
          <button
            type="button"
            className="font-mono text-[12px] text-accent hover:underline text-left"
            onClick={() => openFileOrPreview(targetAbs, sessionId)}
          >
            {movedToAbs ? file.movedTo : file.path}
          </button>
        )}
        {movedToAbs && (
          <span
            className="text-[11px] text-tertiary truncate"
            title={file.path}
          >
            {t("blocks.fileChanges.movedFrom")}：{file.path}
          </span>
        )}
        {!gone && !file.error && !file.oversized && (
          <span className="ml-auto flex items-center gap-2 text-tertiary text-[11px] select-none">
            {canDiff && (
              <button
                type="button"
                className="hover:text-accent"
                onClick={() => openFileOrPreview(targetAbs, sessionId)}
              >
                {t("blocks.fileChanges.preview")}
              </button>
            )}
            {canDiff && (
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
                className="hover:text-accent"
              >
                {open
                  ? t("blocks.fileChanges.collapse")
                  : t("blocks.fileChanges.expand")}
              </button>
            )}
            <ShareButton
              paths={[targetAbs]}
              sessionId={sessionId}
              testId={`file-change-share-${file.path}`}
            />
          </span>
        )}
        {gone && canDiff && (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="ml-auto text-tertiary text-[11px] hover:text-accent select-none"
          >
            {open
              ? t("blocks.fileChanges.collapse")
              : t("blocks.fileChanges.expand")}
          </button>
        )}
      </div>
      {open && canDiff && (
        <div className="pl-4" data-testid={`diff-${file.path}`}>
          <ReactDiffViewer
            oldValue={file.before ?? ""}
            newValue={file.after ?? ""}
            splitView={false}
            showDiffOnly
            extraLinesSurroundingDiff={3}
          />
        </div>
      )}
    </div>
  );
}
