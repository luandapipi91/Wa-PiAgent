// InstructionItem.tsx — 指令文件条目（只读）
import type { InstructionFile } from "@hiagent/shared";

interface Props {
  instruction: InstructionFile;
}

export function InstructionItem({ instruction }: Props) {
  const isGlobal = instruction.scope === "global";
  const summary = instruction.content.slice(0, 100).trim() + (instruction.content.length > 100 ? "..." : "");

  const openFile = () => {
    // 用 window.open 打开文件路径（浏览器环境下可能需要 kernel 中转）
    window.open(`file:///${instruction.path.replace(/\\/g, "/")}`, "_blank");
  };

  return (
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
          <span className="text-[13px] font-bold text-primary">{instruction.name}</span>
          <span
            className="text-[9.5px] font-semibold px-[7px] py-[2px] rounded-full"
            style={{
              background: isGlobal ? "var(--accent-soft)" : "var(--success-soft)",
              color: isGlobal ? "var(--accent)" : "var(--success)",
            }}
          >{isGlobal ? "全局" : "项目"}</span>
        </div>
        <p className="text-[11px] text-tertiary font-mono mb-1.5">{instruction.path}</p>
        <p className="text-[11.5px] text-secondary leading-relaxed m-0">{summary}</p>
      </div>
      <button
        onClick={openFile}
        className="text-[11px] text-secondary px-3 py-1 rounded-md"
        style={{ border: "1px solid var(--hairline)", background: "transparent" }}
      >打开</button>
    </div>
  );
}
