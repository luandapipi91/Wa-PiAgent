interface Props {
  onNewProject: () => void;
}

export function EmptyState({ onNewProject }: Props) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-10 text-center" data-testid="empty-state">
      <div className="w-[72px] h-[72px] rounded-xl flex items-center justify-center text-3xl mb-5 border border-hairline shadow-md"
        style={{ background: "linear-gradient(135deg, var(--surface-elevated), var(--surface))" }}>
        🚀
      </div>
      <div className="text-[22px] font-extrabold tracking-tight text-primary mb-2">开始你的第一个项目</div>
      <div className="text-sm text-secondary max-w-[360px] leading-relaxed mb-6">
        选择一个代码目录，WA PI Agent 会自动分析项目结构并为你分配智能体团队。
      </div>
      <button
        onClick={onNewProject}
        className="px-[22px] py-2.5 rounded-pill bg-brand text-white text-sm font-semibold border-0 cursor-pointer shadow-md transition-all hover:-translate-y-px hover:shadow-lg"
        data-testid="empty-new-project"
      >＋ 新建项目</button>
    </div>
  );
}
