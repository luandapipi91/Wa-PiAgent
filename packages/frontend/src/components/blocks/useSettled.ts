import { useEffect, useState } from "react";

/**
 * 「停顿」检测：值每次变化重置计时，连续 idleMs 无变化后返回 true。
 * 用于流式内容的渲染降级——高频更新期渲染纯文本，停顿后才切完整 markdown。
 */
export function useSettled(value: unknown, idleMs = 500): boolean {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    setSettled(false);
    const t = setTimeout(() => setSettled(true), idleMs);
    return () => clearTimeout(t);
  }, [value, idleMs]);
  return settled;
}
