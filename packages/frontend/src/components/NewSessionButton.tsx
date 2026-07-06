interface Props {
  onNewSession: () => void;
}

export function NewSessionButton({ onNewSession }: Props) {
  return (
    <button
      onClick={onNewSession}
      className="w-full px-3 py-2 mb-2 text-left rounded border border-dashed border-surface2 text-subtext hover:border-blue hover:text-text text-sm"
      data-testid="new-session-btn"
    >
      ➕ 新建会话
    </button>
  );
}
