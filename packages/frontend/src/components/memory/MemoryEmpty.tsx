// MemoryEmpty.tsx — 空状态组件
interface Props {
  type: "memory" | "instructions";
}

export function MemoryEmpty({ type }: Props) {
  if (type === "instructions") {
    return (
      <div className="flex flex-col items-center justify-center py-16" data-testid="memory-empty-instructions">
        <div
          className="flex items-center justify-center text-3xl mb-4"
          style={{
            width: 64, height: 64, borderRadius: 20,
            background: "linear-gradient(135deg, var(--surface-elevated), var(--surface-hover))",
            border: "1px solid var(--hairline)",
          }}
        >📄</div>
        <h4 className="font-extrabold text-base mb-1.5 text-primary">没有指令文件</h4>
        <p className="text-[12.5px] text-tertiary text-center leading-relaxed">
          当前项目根目录下没有 AGENTS.md 或 CLAUDE.md。<br />
          创建后，智能体会自动加载作为行为指令。
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center justify-center py-16" data-testid="memory-empty">
      <div
        className="flex items-center justify-center text-3xl mb-4"
        style={{
          width: 72, height: 72, borderRadius: 20,
          background: "linear-gradient(135deg, var(--surface-elevated), var(--surface-hover))",
          border: "1px solid var(--hairline)",
        }}
      >🧠</div>
      <h4 className="font-extrabold text-lg mb-1.5 text-primary">还没有记忆</h4>
      <p className="text-[13px] text-tertiary text-center leading-relaxed">
        智能体会在对话中自动学习并记住你的偏好、纠正和经验。<br />
        开始一段对话，记忆会自动积累到这里。
      </p>
    </div>
  );
}
