// 知识库清单 system prompt 段的渲染（任务 9，规格 §6.6）：
// 把智能体绑定的库清单渲染成 <available_knowledge_bases> XML（仿 <available_skills> 清单式），
// 由 system-prompt.ts 的 knowledge-bases 纯运行时段经 ctx.knowledgeBasesContext 注入。
// 只列 status ≠ error 的库；索引中的库标注进度；描述为空不输出 description 元素。
import type { KbInfo } from "@wa-pi/shared";

/** 使用指引行（规格 §6.6：清单后固定附一行，说明何时检索、检索不到意味着什么） */
const USAGE_HINT =
  "回答相关问题前优先检索上述知识库（knowledge_search）；查不到不代表事实不存在";

/** 索引中状态标注（规格 §6.6 示例：「索引中 42%，完成后可检索」）。
 *  仅 scanning/indexing 状态返回标注；ready 返回 null（不标注）；error 由调用方先行过滤。 */
function statusLabel(kb: KbInfo): string | null {
  if (kb.status !== "scanning" && kb.status !== "indexing") return null;
  const p = kb.progress;
  if (p && p.filesTotal > 0) {
    return `索引中 ${Math.round((p.filesDone / p.filesTotal) * 100)}%，完成后可检索`;
  }
  return "索引中，完成后可检索";
}

/**
 * 渲染绑定知识库清单为 system prompt 文本。
 * - error 库不出现；全 error / 空清单返回空串（composePrompt 过滤空段 → 整段不出现）
 * - 索引中的库附 <status> 标注（含百分比进度）
 * - 描述为空时不输出 description 元素（避免空标签噪音）
 * - 清单后附一行使用指引（含 knowledge_search 工具名提示）
 */
export function buildKnowledgeBasesPrompt(kbs: KbInfo[]): string {
  const visible = kbs.filter((kb) => kb.status !== "error");
  if (visible.length === 0) return "";
  const lines: string[] = ["<available_knowledge_bases>"];
  for (const kb of visible) {
    lines.push(`  <knowledge_base id="${kb.id}">`);
    lines.push(`    <name>${kb.name}</name>`);
    const status = statusLabel(kb);
    if (status) lines.push(`    <status>${status}</status>`);
    if (kb.description?.trim()) {
      lines.push(`    <description>${kb.description}</description>`);
    }
    lines.push("  </knowledge_base>");
  }
  lines.push("</available_knowledge_bases>");
  lines.push(USAGE_HINT);
  return lines.join("\n");
}
