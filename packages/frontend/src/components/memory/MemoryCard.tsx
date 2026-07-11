// MemoryCard.tsx — 记忆卡片（含行内编辑态）
import { useState } from "react";
import type { MemoryEntry, ArchivedMemory } from "@hiagent/shared";

interface Props {
  entry: MemoryEntry;
  mode?: "active" | "archived";
  onEdit?: (text: string) => void;
  onArchive?: () => void;
  onRestore?: () => void;
  onPurge?: () => void;
}

// 分类标签配色
const CATEGORY_STYLE: Record<string, { bg: string; color: string; label: string }> = {
  memory: { bg: "var(--success-soft)", color: "var(--success)", label: "记忆" },
  user: { bg: "var(--accent-soft)", color: "var(--accent)", label: "用户" },
  failure: { bg: "var(--danger-soft)", color: "var(--danger)", label: "失败" },
};

export function MemoryCard({ entry, mode = "active", onEdit, onArchive, onRestore, onPurge }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.text);

  const cat = CATEGORY_STYLE[entry.category] ?? CATEGORY_STYLE.memory;
  const isArchived = mode === "archived";

  const handleSave = () => {
    onEdit?.(draft);
    setEditing(false);
  };

  const handleCancel = () => {
    setDraft(entry.text);
    setEditing(false);
  };

  return (
    <div
      className="mb-2.5 p-3.5"
      style={{
        background: "var(--surface)",
        border: editing ? "1px solid var(--accent)" : "1px solid var(--hairline)",
        borderRadius: 14,
        opacity: isArchived ? 0.75 : 1,
        boxShadow: editing ? "0 0 0 3px var(--accent-soft)" : "none",
        transition: "box-shadow 0.2s, border-color 0.2s",
      }}
      data-testid={`memory-card-${entry.id}`}
    >
      {/* 头部：分类标签 + 作用域 */}
      <div className="flex items-center gap-2 mb-2">
        <span
          className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
          style={{ background: cat.bg, color: cat.color }}
        >{cat.label}</span>
        <span className="text-[10px] text-tertiary">
          {entry.scope === "global" ? "○ 全局" : "● 项目"}
        </span>
      </div>

      {/* 内容 / 编辑态 */}
      {editing ? (
        <>
          <textarea
            className="w-full text-[12.5px] leading-relaxed p-2.5 mb-2 outline-none"
            style={{
              background: "var(--canvas)",
              border: "1px solid var(--hairline-strong)",
              borderRadius: 10,
              color: "var(--text-primary)",
              minHeight: 60,
            }}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            data-testid="memory-edit-textarea"
          />
          <div className="flex justify-end gap-2">
            <button
              onClick={handleCancel}
              className="text-[11px] text-secondary px-2.5 py-1 rounded-md"
              style={{ border: "1px solid var(--hairline)", background: "transparent" }}
              data-testid="memory-edit-cancel"
            >取消</button>
            <button
              onClick={handleSave}
              className="text-[11px] font-semibold text-white px-3.5 py-1 rounded-md"
              style={{ background: "var(--accent)", border: "none" }}
              data-testid="memory-edit-save"
            >保存</button>
          </div>
        </>
      ) : (
        <>
          <p className="text-[12.5px] leading-relaxed text-primary m-0 mb-2">{entry.text}</p>
          <div className="flex items-center justify-between">
            <span className="text-[10.5px] text-tertiary">
              {isArchived ? `归档于 ${(entry as ArchivedMemory).archivedAt?.slice(0, 10) ?? ""}` : entry.updatedAt?.slice(0, 10) ?? ""}
            </span>
            <div className="flex gap-1.5">
              {isArchived ? (
                <>
                  <CardButton onClick={onRestore} testId="memory-restore" text="恢复"
                    color="var(--accent)" borderColor="var(--accent)" />
                  <CardButton onClick={onPurge} testId="memory-purge" text="彻底删除"
                    color="var(--danger)" borderColor="var(--danger)" />
                </>
              ) : (
                <>
                  <CardButton onClick={() => setEditing(true)} testId="memory-edit" text="编辑" />
                  <CardButton onClick={onArchive} testId="memory-archive" text="归档" />
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function CardButton({ onClick, testId, text, color, borderColor }: {
  onClick?: () => void; testId: string; text: string;
  color?: string; borderColor?: string;
}) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      className="text-[11px] px-2.5 py-1 rounded-md"
      style={{
        color: color ?? "var(--text-secondary)",
        border: `1px solid ${borderColor ?? "var(--hairline)"}`,
        background: "transparent",
      }}
    >{text}</button>
  );
}
