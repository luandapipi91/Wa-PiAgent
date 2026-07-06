interface Props {
  onNewProject: () => void;
}

export function EmptyState({ onNewProject }: Props) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center" data-testid="empty-state">
      <p className="text-text mb-4">还没有项目，先创建一个吧</p>
      <button
        onClick={onNewProject}
        className="px-4 py-2 rounded text-sm"
        style={{ background: "#89b4fa", color: "#1e1e2e" }}
        data-testid="empty-new-project"
      >＋ 新建项目</button>
    </div>
  );
}
