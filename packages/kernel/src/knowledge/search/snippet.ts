// 移植自 pi-knowledge@0.13.0 dist/src/engine.js（MIT）
// 片段摘要：以查询词首次出现处为中心截取 maxLength 个字符，两侧截断时补 "..."。
// 上游的 tokenizeForSimilarity 就是 tokenizeForSearch，这里直接用后者。
import { tokenizeForSearch } from "./query";

export function buildQuerySnippet(content: string, query: string, maxLength = 240): string {
  const terms = [...tokenizeForSearch(query)].sort((a, b) => b.length - a.length);
  const lower = content.toLowerCase();
  let matchIndex = -1;
  for (const term of terms) {
    matchIndex = lower.indexOf(term.toLowerCase());
    if (matchIndex >= 0) break;
  }
  if (matchIndex < 0) return content.slice(0, maxLength);
  const half = Math.floor(maxLength / 2);
  const start = Math.max(0, matchIndex - half);
  const end = Math.min(content.length, start + maxLength);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < content.length ? "..." : "";
  return `${prefix}${content.slice(start, end)}${suffix}`;
}
