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
import { join } from "node:path";

import { WA_PI_DIR } from "@wa-pi/shared";
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

// —— 空闲自动卸载（性能优化：模型常驻 ~110-180MB，空闲 5 分钟卸载、用时重载 ~400ms）——
/** 空闲多久后卸载模型；下次使用自动重载（缓存热加载 ~300-400ms） */
export const EMBEDDER_IDLE_UNLOAD_MS = 5 * 60_000;
/** 最近一次使用时刻（getPipeline 成功 / embedQuery / embedDocuments 刷新；0 = 从未使用） */
let lastUsedAt = 0;
/** 推理进行中计数：>0 时不卸载（防「卸到一半有人在用」） */
let inflight = 0;
let idleTimer: ReturnType<typeof setInterval> | null = null;

/** 测试用：重置单例状态 */
export function resetEmbedderForTest(opts: { failNextLoad?: boolean } = {}): void {
  pipe = null;
  state = { status: "idle" };
  loadPromise = null;
  failNextLoad = opts.failNextLoad ?? false;
  queryCalls = 0;
  lastUsedAt = 0;
  inflight = 0;
  if (idleTimer) {
    clearInterval(idleTimer);
    idleTimer = null;
  }
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

export function modelCacheDir(): string {
  return join(WA_PI_DIR, "models");
}

/**
 * 启动预热：触发模型下载/加载但不推理（安装包不内置模型，首启在此从镜像下载）。返回是否就绪。
 * 失败（离线 / 镜像不可用）静默返回 false——语义检索降级，词法照常。
 */
export async function preloadModel(): Promise<boolean> {
  return (await getPipeline()) !== null;
}

export function isEmbedderReady(): boolean {
  return state.status === "ready";
}

/** 空闲卸载判定（纯函数，便于离线表驱动测试）：有管道 + 无推理进行中 + 有使用记录 + 超阈值 */
export function shouldUnloadForIdle(
  now: number,
  lastUsed: number,
  inflightCount: number,
  hasPipe: boolean,
  threshold: number = EMBEDDER_IDLE_UNLOAD_MS,
): boolean {
  return hasPipe && inflightCount === 0 && lastUsed > 0 && now - lastUsed >= threshold;
}

/**
 * 卸载模型释放内存（~110-180MB）：官方 dispose() 遍历释放全部 ONNX session（wasm/原生堆
 * 不受 JS GC 管理——实测置空引用不调 dispose 内存不归还），再置空单例 + 同步 GC。
 * dispose 失败只告警：单例已置空，最坏退回 GC 兑底，不影响后续重载。
 */
export async function unloadModel(): Promise<void> {
  if (loadPromise) {
    try {
      await loadPromise;
    } catch {
      /* 加载失败同样视为已无可卸载对象 */
    }
  }
  const p = pipe;
  pipe = null;
  state = { status: "idle" };
  loadPromise = null;
  lastUsedAt = 0;
  if (!p) return;
  try {
    await (p as unknown as { model?: { dispose?: () => Promise<unknown> } }).model?.dispose?.();
  } catch (err) {
    console.error("[memory-semantic] 模型 dispose 失败（单例已置空，退回 GC 兑底）:", err);
  }
  Bun.gc(true);
}

/** 空闲卸载入口（定时器每 60s 调一次；now 可注入测试）。返回是否真的卸了。 */
export async function maybeUnloadForIdle(now: number = Date.now()): Promise<boolean> {
  if (!shouldUnloadForIdle(now, lastUsedAt, inflight, pipe !== null)) return false;
  await unloadModel();
  console.log(
    `[memory-semantic] embedding 模型空闲 ${Math.round(EMBEDDER_IDLE_UNLOAD_MS / 60_000)} 分钟，已卸载（下次使用自动重载）`,
  );
  return true;
}

function ensureIdleTimer(): void {
  if (idleTimer) return;
  idleTimer = setInterval(() => {
    void maybeUnloadForIdle().catch(() => {});
  }, 60_000);
  // 不阳碍进程退出（kernel 自己有生命周期管理，定时器不该挂住它）
  idleTimer.unref?.();
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
      // 模型随安装包内置时优先走本地目录（特殊部署）；否则下载缓存落
      // WA_PI_DIR/models（用户目录持久可写，首次初始化自动从镜像下载，升级不丢）。
      if (process.env.WA_PI_MODEL_DIR) {
        env.allowRemoteModels = false;
        env.localModelPath = process.env.WA_PI_MODEL_DIR;
      } else {
        env.cacheDir = modelCacheDir();
      }
      pipe = (await pipeline("feature-extraction", EMBED_MODEL, {
        dtype: EMBED_DTYPE,
        device: "cpu",
      })) as FeatureExtractionPipeline;
      state = { status: "ready" };
      lastUsedAt = Date.now();
      ensureIdleTimer();
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
  inflight++;
  try {
    const p = await getPipeline();
    if (!p) return [];
    const out = await p(texts, { pooling: "cls", normalize: true });
    lastUsedAt = Date.now();
    return (out.tolist() as number[][]).map(packFloat32);
  } finally {
    inflight--;
  }
}

/** 编码查询（带指令前缀）。空输入或模型不可用时返回 null。 */
export async function embedQuery(text: string): Promise<Uint8Array | null> {
  queryCalls++;
  const trimmed = text.trim();
  if (!trimmed) return null;
  inflight++;
  try {
    const p = await getPipeline();
    if (!p) return null;
    const out = await p([QUERY_PREFIX + trimmed], { pooling: "cls", normalize: true });
    lastUsedAt = Date.now();
    const [vec] = out.tolist() as number[][];
    return packFloat32(vec);
  } finally {
    inflight--;
  }
}
