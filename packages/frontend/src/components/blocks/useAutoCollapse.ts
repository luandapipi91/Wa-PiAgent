import { useCallback, useState } from "react";

/**
 * 自动折叠 hook：流式中默认展开，块完成后自动折叠；用户手动操作后尊重用户选择。
 * - isStreaming: 整轮流式标志
 * - isDone: 该 block 是否完成
 *
 * userOpen 为 null 表示用户未手动操作，跟随自动逻辑；一旦 toggle 则固定为用户选择。
 * 必须基于当前显示的 open 取反（setUserOpen(!open)）：若用 updater 形式 setUserOpen(o => !o)，
 * 流式展开时第一次点击会把用户态置为展开（open 仍为 true），要点两次才折叠。
 */
export function useAutoCollapse(opts: {
  isStreaming?: boolean;
  isDone: boolean;
  /** 为 true 时自动展开时机从「流式中」改为「执行中（未完成即展开）」 */
  executingMode?: boolean;
}): { open: boolean; toggle: () => void } {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const autoOpen = opts.executingMode
    ? !opts.isDone
    : (!!opts.isStreaming && !opts.isDone);
  const open = userOpen ?? autoOpen;
  const toggle = useCallback(() => {
    setUserOpen(!open);
  }, [open]);
  return { open, toggle };
}
