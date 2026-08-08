// InstructionItem.tsx — 指令文件条目（只读）
import { useState } from "react";
import type { InstructionFile } from "@wa-pi/shared";
import { Modal } from "../ui/Modal";
import { useTranslation } from "../../i18n/useTranslation";

interface Props {
  instruction: InstructionFile;
}

export function InstructionItem({ instruction }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const isGlobal = instruction.scope === "global";
  const summary = instruction.content.slice(0, 100).trim() + (instruction.content.length > 100 ? "..." : "");

  return (
    <>
      <div
        className="flex items-start gap-3 p-3.5 mb-2.5"
        style={{
          background: "var(--surface)",
          border: "1px solid var(--hairline)",
          borderRadius: 14,
        }}
        data-testid={`instruction-item-${instruction.scope}`}
      >
        <div
          className="flex items-center justify-center text-base flex-shrink-0"
          style={{
            width: 36, height: 36, borderRadius: 10,
            background: "linear-gradient(135deg, var(--surface-elevated), var(--surface-hover))",
            border: "1px solid var(--hairline)",
          }}
        >📄</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-[calc(13px*var(--font-scale))] font-bold text-primary">{instruction.name}</span>
            <span
              className="text-[calc(9.5px*var(--font-scale))] font-semibold px-[7px] py-[2px] rounded-full"
              style={{
                background: isGlobal ? "var(--accent-soft)" : "var(--success-soft)",
                color: isGlobal ? "var(--accent)" : "var(--success)",
              }}
            >{isGlobal ? t("memoryInstruction.scopeGlobal") : t("memoryInstruction.scopeProject")}</span>
          </div>
          <p className="text-[calc(11px*var(--font-scale))] text-tertiary font-mono mb-1.5">{instruction.path}</p>
          <p className="text-[calc(11.5px*var(--font-scale))] text-secondary leading-relaxed m-0">{summary}</p>
        </div>
        <button
          onClick={() => setOpen(true)}
          className="text-[calc(11px*var(--font-scale))] text-secondary px-3 py-1 rounded-md"
          style={{ border: "1px solid var(--hairline)", background: "transparent" }}
        >{t("memoryInstruction.viewButton")}</button>
      </div>

      {open && (
        <Modal onClose={() => setOpen(false)} width={720} data-testid="instruction-view-modal">
          {/* 标题栏 */}
          <div
            className="flex items-center justify-between px-5 py-3.5"
            style={{ borderBottom: "1px solid var(--hairline)" }}
          >
            <h3 className="text-[calc(14px*var(--font-scale))] font-extrabold text-primary m-0">{instruction.name}</h3>
            <button
              onClick={() => setOpen(false)}
              className="text-[calc(12px*var(--font-scale))] text-secondary px-2.5 py-1 rounded-md"
              style={{ border: "1px solid var(--hairline)", background: "transparent" }}
              data-testid="instruction-view-close"
            >{t("memoryInstruction.closeButton")}</button>
          </div>
          {/* 文件路径 */}
          <div className="px-5 py-2" style={{ borderBottom: "1px solid var(--hairline)" }}>
            <p className="text-[calc(11px*var(--font-scale))] text-tertiary font-mono m-0">{instruction.path}</p>
          </div>
          {/* 内容（可滚动，只读） */}
          <div
            className="px-5 py-3.5 overflow-y-auto"
            style={{ maxHeight: "60vh" }}
          >
            <pre
              className="text-[calc(12px*var(--font-scale))] text-secondary leading-relaxed whitespace-pre-wrap break-words m-0 font-mono"
              data-testid="instruction-view-content"
            >{instruction.content}</pre>
          </div>
        </Modal>
      )}
    </>
  );
}
