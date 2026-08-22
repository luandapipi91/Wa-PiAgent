/** 中文人名库：为智能体随机生成人名（姓 + 名），支持查重重试 */

const SURNAMES = [
  "林", "沈", "顾", "苏", "陈", "叶", "周", "许", "陆", "江",
  "方", "韩", "秦", "唐", "宋", "程", "曾", "萧", "尹", "洛",
] as const;

const GIVEN_NAMES = [
  "晓岚", "亦凡", "子墨", "雨桐", "思远", "若曦", "浩然", "静怡",
  "天翊", "梦琪", "景行", "书瑶", "沐宸", "芷若", "云舟", "清晏",
  "明轩", "语嫣", "君泽", "南絮", "既白", "疏影", "承宇", "念安",
] as const;

/** 第一个组合（rng 恒 0 时的结果），兜底逻辑以它为基准 */
const FIRST_COMBO = `${SURNAMES[0]}${GIVEN_NAMES[0]}`; // 林晓岚

/**
 * 随机生成中文人名。
 * @param existing 已存在的名字（智能体 displayName 列表），生成结果避开它们
 * @param rng 随机源，测试可注入确定性函数
 */
export function randomPersonName(
  existing: readonly string[] = [],
  rng: () => number = Math.random,
): string {
  for (let i = 0; i < 50; i++) {
    const name =
      SURNAMES[Math.floor(rng() * SURNAMES.length)] +
      GIVEN_NAMES[Math.floor(rng() * GIVEN_NAMES.length)];
    if (!existing.includes(name)) return name;
  }
  // 兜底：第一个组合加数字后缀
  let n = 2;
  while (existing.includes(`${FIRST_COMBO}${n}`)) n++;
  return `${FIRST_COMBO}${n}`;
}
