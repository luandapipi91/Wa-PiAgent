interface Props {
  onClick: () => void;
}

export function SettingsButton({ onClick }: Props) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left px-2 py-1.5 text-xs text-tertiary transition-colors hover:text-brand"
      data-testid="settings-btn"
    >⚙ 系统设置</button>
  );
}
