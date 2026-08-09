import type { AgentName } from "@wa-pi/shared";

interface Props {
  name: string;
  description?: string;
  avatar?: string;
  avatarColor?: string;
  /** 当前选中态：显示 ✓ 勾选标记 */
  selected?: boolean;
  /** 键盘/鼠标高亮态：背景变色 */
  highlighted?: boolean;
  onClick?: () => void;
  onMouseEnter?: () => void;
  innerRef?: (el: HTMLElement | null) => void;
  testId?: string;
}

// avatarColor 形如 "#06b6d4-#3b82f6"（渐变）或单色；还原为 CSS background
export function avatarBackground(color?: string): string | undefined {
  if (!color) return undefined;
  const [c1, c2] = color.split("-").map(s => s.trim());
  return c2 ? `linear-gradient(135deg, ${c1}, ${c2})` : c1;
}

/**
 * 智能体列表项（头像 + 名称 + 描述 + 选中/高亮态）。
 * 纯展示行，AgentDropdown 与 QuickInvokeMenu 的 @ 智能体分支共用，保证视觉一致。
 */
export function AgentMenuItem({
  name, description, avatar, avatarColor,
  selected = false, highlighted = false,
  onClick, onMouseEnter, innerRef, testId,
}: Props) {
  return (
    <div
      ref={innerRef}
      data-testid={testId}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-sm cursor-pointer text-left transition-colors text-secondary ${
        highlighted ? "bg-accent-soft" : selected ? "bg-surface-hover" : "hover:bg-surface-hover"
      }`}
    >
      <span
        className="w-[22px] h-[22px] rounded-sm flex items-center justify-center text-[calc(12px*var(--font-scale))] flex-none"
        style={{ background: avatarBackground(avatarColor) }}
      >{avatar ?? "🤖"}</span>
      <span className="min-w-0 flex-1">
        <div className="text-[calc(12px*var(--font-scale))] text-primary truncate">{name}</div>
        {description && <div className="text-[calc(11px*var(--font-scale))] text-tertiary truncate">{description}</div>}
      </span>
      {selected && <span className="ml-auto text-accent">✓</span>}
    </div>
  );
}

export type { AgentName };
