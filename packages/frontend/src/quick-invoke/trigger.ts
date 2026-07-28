// 触发符检测 + 列表过滤纯函数

export type TriggerType = "agent" | "file" | "skill" | "command";

export interface TriggerResult {
  type: TriggerType;
  query: string;
}

export interface FilterableItem {
  name: string;
  description?: string;
}

/**
 * 检测光标前文本是否包含触发符 @ / # / $。
 * 规则：
 * - @ = 智能体，# = 文件，$ = 技能
 * - 触发符必须在行首或空格之后（避免 email@test 误触发）
 * - 触发符后的文本作为过滤关键词
 * - 已存在的 chip token（@[...] / #[...] / $[...]）不触发
 */
export function detectTrigger(text: string): TriggerResult | null {
  // 先移除已存在的 chip token，避免 token 内的触发符干扰检测
  const cleaned = text
    .replace(/@\[[^\]]+\]/g, " ")
    .replace(/#\[[^\]]+\]/g, " ")
    .replace(/\$\[[^\]]+\]/g, " ")
    .replace(/¥\[[^\]]+\]/g, " ");

  // 检测 @ 智能体触发
  const atMatch = cleaned.match(/(?:^|\s)@([^\s]*)$/);
  if (atMatch) {
    return { type: "agent", query: atMatch[1] };
  }

  // 检测 # 文件触发
  const hashMatch = cleaned.match(/(?:^|\s)#([^\s]*)$/);
  if (hashMatch) {
    return { type: "file", query: hashMatch[1] };
  }

  // 检测 $ / ¥ 技能触发
  const dollarMatch = cleaned.match(/(?:^|\s)[$¥]([^\s]*)$/);
  if (dollarMatch) {
    return { type: "skill", query: dollarMatch[1] };
  }

  // 检测 / 命令触发（必须在行首或空格之后，排除路径中的 /）
  const slashMatch = cleaned.match(/(?:^|\s)\/([^\s]*)$/);
  if (slashMatch) {
    return { type: "command", query: slashMatch[1] };
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
