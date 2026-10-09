// 本地 embedding 引擎：bge-base-zh-v1.5 (q8, CLS) + transformers.js。
//
// 设计要点：
// - 懒加载单例：模型首次使用时才下载/加载，加载失败只记录一次日志并永久降级。
// - query 侧加指令前缀（bge 官方建议），document 侧不加。
// - 模型选型（2026-10-09 POC）：bge-base-zh-v1.5 q8/CLS，bench hit@1 0.91 / MRR 0.922
//   （bge-small-zh mean 口径为 0.73/0.774，见 docs/poc-embedding-model.md）。
// - 512 token 上限，超长由 tokenizer 截断。
// - 输出 L2 归一化后的 Float32，包装成 Uint8Array 以直接写入 SQLite BLOB。
import type { FeatureExtractionPipeline } from "@huggingface/transformers";

import { EMBED_DIM } from "./schema";

export const EMBED_MODEL = "Xenova/bge-base-zh-v1.5";
export const EMBED_DTYPE = "q8";
export { EMBED_DIM };
/** bge 系列建议的检索指令前缀（仅 query 侧） */
export const QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章：";

type LoadState = { status: "idle" } | { status: "ready" } | { status: "failed" };

let pipe: FeatureExtractionPipeline | null = null;
let state: LoadState = { status: "idle" };
let loadPromise: Promise<FeatureExtractionPipeline | null> | null = null;
let failNextLoad = false;
let queryCalls = 0;

/** 测试用：重置单例状态 */
export function resetEmbedderForTest(opts: { failNextLoad?: boolean } = {}): void {
  pipe = null;
  state = { status: "idle" };
  loadPromise = null;
  failNextLoad = opts.failNextLoad ?? false;
  queryCalls = 0;
}

/**
 * 测试用探针：embedQuery 被调用的次数（含空输入 / 模型不可用的早退）。
 * 用途是钉住「调用方不该在条件不成立时去取查询向量」这类护栏——只看返回值无法区分
 * 「没调用」与「调用了但被内部守卫挡成 null」，两者对外表现完全相同。
 */
export function embedQueryCallsForTest(): number {
  return queryCalls;
}

/** 模型 + 精度 + 维度指纹；写入 embed_meta，指纹变化即视为「未索引」 */
export function embedFingerprint(): string {
  return `${EMBED_MODEL}:${EMBED_DTYPE}:${EMBED_DIM}`;
}

export function isEmbedderReady(): boolean {
  return state.status === "ready";
}

async function getPipeline(): Promise<FeatureExtractionPipeline | null> {
  if (state.status === "failed") return null;
  if (pipe) return pipe;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    if (failNextLoad) {
      failNextLoad = false;
      state = { status: "failed" };
      return null;
    }
    try {
      const { pipeline, env } = await import("@huggingface/transformers");
      // 国内网络必须走镜像；海外用户走官方源。允许用环境变量覆盖。
      if (!env.remoteHost || env.remoteHost.includes("huggingface.co")) {
        env.remoteHost = process.env.WA_PI_HF_ENDPOINT ?? "https://hf-mirror.com";
        env.remotePathTemplate = "{model}/resolve/{revision}/";
      }
      // 模型随安装包内置时优先走本地目录
      if (process.env.WA_PI_MODEL_DIR) {
        env.allowRemoteModels = false;
        env.localModelPath = process.env.WA_PI_MODEL_DIR;
      }
      pipe = (await pipeline("feature-extraction", EMBED_MODEL, {
        dtype: EMBED_DTYPE,
        device: "cpu",
      })) as FeatureExtractionPipeline;
      state = { status: "ready" };
      return pipe;
    } catch (err) {
      state = { status: "failed" };
      console.error("[memory-semantic] embedding 模型加载失败，语义检索将被禁用：", err);
      return null;
    }
  })();

  return loadPromise;
}

/** 把池化输出转成可直接落库的 Uint8Array（Float32 小端原始字节） */
function packFloat32(values: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(values).buffer);
}

/** 批量编码文档（不带指令前缀）。模型不可用时返回空数组。 */
export async function embedDocuments(texts: string[]): Promise<Uint8Array[]> {
  if (texts.length === 0) return [];
  const p = await getPipeline();
  if (!p) return [];
  const out = await p(texts, { pooling: "cls", normalize: true });
  return (out.tolist() as number[][]).map(packFloat32);
}

/** 编码查询（带指令前缀）。空输入或模型不可用时返回 null。 */
export async function embedQuery(text: string): Promise<Uint8Array | null> {
  queryCalls++;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const p = await getPipeline();
  if (!p) return null;
  const out = await p([QUERY_PREFIX + trimmed], { pooling: "cls", normalize: true });
  const [vec] = out.tolist() as number[][];
  return packFloat32(vec);
}
