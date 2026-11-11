// 移植自 pi-knowledge@0.13.0 dist/src/search/reranker-logits.js（MIT）
//
// 单 logit 的 cross-encoder（如 ms-marco-MiniLM）不能走 pipeline("text-classification")：
// 单标签时 softmax 恒为 1.0，且 pipeline 不透传 text_pair。上游改为直接持
// tokenizer + 序列分类模型，取原始 logit 当分数（单调变换，不影响排序）。

export interface RawLogitRerankInput {
  text: string;
  text_pair: string;
}

export type RawLogitTokenizer = (
  text: string,
  options: { text_pair: string; padding: true; truncation: true },
) => Record<string, unknown>;

export type RawLogitModel = (inputs: Record<string, unknown>) => Promise<{
  logits: { data: ArrayLike<number> };
}>;

export function scoreSingleRawLogit(logits: { data: ArrayLike<number> }, model: string): number {
  const scores = Array.from(logits.data);
  if (scores.length !== 1) {
    throw new Error(
      `Raw-logit reranker expected a single-logit sequence classifier for ${model}, got ${scores.length} logits. ` +
        "Use a single-logit reranker model or disable PI_KNOWLEDGE_RERANKER_RAW_LOGITS.",
    );
  }
  const score = scores[0];
  if (!Number.isFinite(score))
    throw new Error(`Raw-logit reranker returned a non-finite score for ${model}`);
  return score;
}

export async function rerankWithSingleRawLogit(
  input: RawLogitRerankInput,
  tokenizer: RawLogitTokenizer,
  model: RawLogitModel,
  modelName: string,
): Promise<Array<{ score: number }>> {
  const inputs = tokenizer(input.text, {
    text_pair: input.text_pair,
    padding: true,
    truncation: true,
  });
  const { logits } = await model(inputs);
  return [{ score: scoreSingleRawLogit(logits, modelName) }];
}
