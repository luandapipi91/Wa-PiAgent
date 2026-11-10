// 知识库索引指纹：模型指纹 + 切块版本。
// 切块策略变化（块边界/前缀/预算）必须让存量索引整体失效重建——否则同一块会保留旧向量
// 却对应新的切法，语义与词法两路悄悄分叉。
import { embedFingerprint } from "../memory/embedder";

/** 切块器版本：改动 chunker.ts 的切分/前缀/预算语义时递增 */
export const KB_CHUNKER_VERSION = 2;

/** 落库 embed_meta 与检索期 mismatch 判定共用的唯一指纹 */
export function knowledgeFingerprint(): string {
  return `${embedFingerprint()}:chunker=${KB_CHUNKER_VERSION}`;
}
