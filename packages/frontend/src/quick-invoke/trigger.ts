// 触发符检测 + 列表过滤纯函数

export type TriggerType = "file" | "skill";

export interface TriggerResult {
  type: TriggerType;
  query: string;
}

export interface FilterableItem {
  name: string;
  description?: string;
}

/**
 * 检测光标前文本是否包含触发符 @ 或 $。
 * 规则：
 * - @ / $ 必须在行首或空格之后（避免 email@test 误触发）
 * - 触发符后的文本作为过滤关键词
 * - 已存在的 chip token（@[...] 或 $[...]）不触发
 * - @ 和 $ 互斥，取最后一个出现的
 */
export function detectTrigger(text: string): TriggerResult | null {
  // 先移除已存在的 chip token，避免 token 内的 @ / $ 干扰检测
  const cleaned = text
    .replace(/@\[[^\]]+\]/g, " ")
    .replace(/\$\[[^\]]+\]/g, " ");

  // 检测 @ 文件触发
  const atMatch = cleaned.match(/(?:^|\s)@([^\s]*)$/);
  if (atMatch) {
    return { type: "file", query: atMatch[1] };
  }

  // 检测 $ 技能触发
  const dollarMatch = cleaned.match(/(?:^|\s)\$([^\s]*)$/);
  if (dollarMatch) {
    return { type: "skill", query: dollarMatch[1] };
  }

  return null;
}

/**
 * 按名称模糊匹配过滤列表项（大小写不敏感）。
 * 空查询返回全部。
 */
export function filterItems<T extends FilterableItem>(items: T[], query: string): T[] {
  if (!query) return items;
  const lower = query.toLowerCase();
  return items.filter(item =>
    item.name.toLowerCase().includes(lower) ||
    (item.description?.toLowerCase().includes(lower) ?? false),
  );
}
