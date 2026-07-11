// MemoryCard.tsx — 记忆条目卡片（占位实现）
// 注意：这是 Task 8 的最小占位，仅渲染 entry.text 与基础结构，
// 让 MemoryPage 能编译。Task 9 会用完整版替换（编辑、归档、分类徽章等）。
import type { MemoryEntry, ArchivedMemory } from "@hiagent/shared";

interface Props {
  entry: MemoryEntry | ArchivedMemory;
  mode?: "saved" | "archived";
  onEdit?: (text: string) => void;
  onArchive?: () => void;
  onRestore?: () => void;
  onPurge?: () => void;
}

export function MemoryCard({ entry, mode = "saved" }: Props) {
  return (
    <div
      className="p-3.5 mb-2.5"
      style={{
        background: "var(--surface)",
        border: "1px solid var(--hairline)",
        borderRadius: 14,
      }}
      data-testid={`memory-card-${mode}`}
    >
      <p className="text-[13px] text-primary leading-relaxed m-0">{entry.text}</p>
    </div>
  );
}
