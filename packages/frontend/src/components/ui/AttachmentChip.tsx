import type { AttachmentDraft } from "@hiagent/shared";
import { pathToUploadUrl } from "../../fs-client";

interface Props {
  attachment: AttachmentDraft;
  onRemove: () => void;
}

export function AttachmentChip({ attachment, onRemove }: Props) {
  const label = attachment.kind === "snippet"
    ? attachment.content.slice(0, 20) + (attachment.content.length > 20 ? "…" : "")
    : attachment.name;
  const icon =
    attachment.kind === "image" ? "📷" :
    attachment.kind === "audio" ? "🎤" :
    attachment.kind === "folder" ? "📁" :
    attachment.kind === "snippet" ? "📝" : "📄";

  return (
    <span className="inline-flex flex-col gap-1 text-xs text-secondary bg-surface-hover px-2 py-1 rounded-pill" data-testid="attachment-chip">
      <span className="inline-flex items-center gap-1">
        <span>{icon}</span>
        <span className="truncate max-w-[150px]">{label}</span>
        <button
          type="button"
          aria-label="移除附件"
          data-testid="attachment-remove"
          onClick={onRemove}
          className="text-tertiary hover:text-danger ml-1"
        >✕</button>
      </span>
      {attachment.kind === "audio" && (
        <audio controls src={pathToUploadUrl(attachment.path)} className="h-10 w-full min-w-[220px]" data-testid="attachment-audio" />
      )}
    </span>
  );
}
