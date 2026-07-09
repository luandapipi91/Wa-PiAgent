interface Props {
  onNewSession: () => void;
}

export function NewSessionButton({ onNewSession }: Props) {
  return (
    <button
      onClick={onNewSession}
      className="w-full px-3 py-2.5 mb-1.5 text-left text-sm font-semibold rounded-md border-[1.5px] border-dashed border-hairline-strong text-secondary transition-colors hover:border-brand hover:text-brand hover:bg-surface"
      data-testid="new-session-btn"
    >
      ＋ 新建会话
    </button>
  );
}
