import type { AttachmentDraft } from "@hiagent/shared";

interface Props {
  attachment: AttachmentDraft;
  onRemove: () => void;
}

export function AttachmentChip({ attachment, onRemove }: Props) {
  const label = attachment.kind === "snippet"
    ? attachment.content.slice(0, 20) + (attachment.content.length > 20 ? "…" : "")
    : attachment.name;
  const icon = attachment.kind === "image" ? "📷" : attachment.kind === "snippet" ? "📝" : "📄";

  return (
    <span className="inline-flex items-center gap-1 text-xs text-secondary bg-surface-hover px-2 py-1 rounded-pill">
      <span>{icon}</span>
      <span className="truncate max-w-[150px]">{label}</span>
      <button
        data-testid="attachment-remove"
        onClick={onRemove}
        className="text-tertiary hover:text-danger ml-1"
      >✕</button>
    </span>
  );
}
