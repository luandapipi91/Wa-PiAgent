// 模型可用性门（三态）：区分「环境没有模型来源」与「模型来源存在却加载失败」。
//
// 背景（最终审查 I2）：各测试文件原先统一用 `(await embedQuery(...)) === null` 判定
// 「模型不可用 → 全部 skip」。这把「离线 / 无网」与「embedder 的加载逻辑被改坏」
// 混为一谈：dtype / localModelPath / allowRemoteModels / 模型目录名任一被改坏，
// 依赖模型的用例都会**静默 skip 而不是变红** —— 在无网机器 / CI 上「全绿」，
// 而规格 §7.1（语义召回）与 §7.3（降级）的全部断言都挂在这道门上。
//
// 三态：
//   available —— 探测拿到向量：用例照常执行，断言强度与联网时逐字一致；
//   noSource  —— 本机既没设 WA_PI_MODEL_DIR、也没有该模型的本机缓存：环境不具备条件，
//                skip 并打印原因（离线 / 无网 CI 的常态）；
//   broken    —— 声明了模型来源（WA_PI_MODEL_DIR 或本机缓存）却仍不可用：这是真实故障，
//                由 registerModelGateFailure 注册一条必定失败的用例 → **判红**，
//                不再静默跳过。
//
// 判定逻辑是纯函数（classifyModelProbe），与探测本身分离，便于单测直接钉住三态口径
//（见 tests/memory-model-gate.test.ts）。
import { test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { EMBED_MODEL, embedQuery, resetEmbedderForTest } from "../../src/memory/embedder";

export type ModelGateStatus = "available" | "noSource" | "broken";

export interface ModelProbeInput {
  /** 探测是否拿到向量 */
  probeOk: boolean;
  /** 探测期抛出的异常消息（加载失败 / 推理期异常）；无异常为 null */
  probeError: string | null;
  /** process.env.WA_PI_MODEL_DIR（未设置 / 空串 → null） */
  envDir: string | null;
  /** 本机缓存里该模型目录的路径（不存在 → null） */
  cacheDir: string | null;
}

export interface ModelGate {
  status: ModelGateStatus;
  /** 供 skip 提示 / 断言失败信息使用的可读说明 */
  detail: string;
}

export function classifyModelProbe(input: ModelProbeInput): ModelGate {
  if (input.probeOk) {
    return { status: "available", detail: `模型可用（${EMBED_MODEL}）` };
  }
  const sources: string[] = [];
  if (input.envDir) sources.push(`WA_PI_MODEL_DIR=${input.envDir}`);
  if (input.cacheDir) sources.push(`本机缓存 ${input.cacheDir}`);
  const why = input.probeError
    ? `加载/推理期抛错：${input.probeError}`
    : "加载失败（embedQuery 返回 null）";
  if (sources.length > 0) {
    return {
      status: "broken",
      detail:
        `模型来源存在（${sources.join("；")}）却仍不可用 —— ${why}。\n` +
        "  这是真实故障（embedder 的加载路径被改坏 / 资产损坏 / 目录名不符），不是「环境无网」，\n" +
        "  故判红而不是 skip：请修 embedder 的加载逻辑，或把 WA_PI_MODEL_DIR 指到真实模型目录。",
    };
  }
  return {
    status: "noSource",
    detail:
      `本机没有任何模型来源（未设置 WA_PI_MODEL_DIR，${EMBED_MODEL} 也不在本机缓存里）—— ${why}。\n` +
      "  这是「环境不具备条件」（离线 / 无网 CI），不是被测代码的缺陷：依赖模型的用例 skip。\n" +
      "  联网重跑，或设置 WA_PI_MODEL_DIR 指向本地模型目录、WA_PI_HF_ENDPOINT 指向可用镜像。",
  };
}

/**
 * 探测本机模型可用性。探测本身**永不抛出**：加载失败返回 null、推理期抛错都被转成
 * 判定的输入（否则会在模块顶层炸掉整个测试文件，只把诊断弄差）。
 *
 * 首次探测失败时会**复位单例再探一次**：embedder 的加载状态是进程级单例，而同一 worker 内
 * 前一个测试文件可能刚跑过 `resetEmbedderForTest({ failNextLoad: true })`（降级路径用例），
 * 把状态永久置为 failed —— 那不是「模型加载被改坏」，只是测试卫生。只有**复位后重新加载
 * 仍失败**才算真实故障（否则会误报 broken，把跨文件污染变成红）。
 * 副作用（有益的）：混跑时后续文件不再因前一个文件的单例污染而静默 skip。
 */
export async function probeModelAvailability(): Promise<ModelGate> {
  const source = await detectModelSource();
  let { ok, error } = await probeOnce();
  if (!ok) {
    resetEmbedderForTest();
    ({ ok, error } = await probeOnce());
  }
  return classifyModelProbe({
    probeOk: ok,
    probeError: error,
    envDir: source.envDir,
    cacheDir: source.cacheDir,
  });
}

async function probeOnce(): Promise<{ ok: boolean; error: string | null }> {
  try {
    return { ok: (await embedQuery("可用性探测")) !== null, error: null };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  }
}

async function detectModelSource(): Promise<{
  envDir: string | null;
  cacheDir: string | null;
}> {
  const rawEnv = process.env.WA_PI_MODEL_DIR;
  const envDir = rawEnv && rawEnv.trim() ? rawEnv : null;

  // 本机缓存 = transformers 包目录下的默认 `.cache/<model>`（与 embedder 的默认加载路径同源）。
  // **刻意不用 `env.cacheDir`**：门要能发现「加载路径被改坏」（cacheDir / localModelPath /
  // 目录名被改错），若用被测代码正在读的那个值来判定「有没有来源」，一旦它被改错，门就会
  // 跟着改口说「没来源」→ 又变回静默 skip，等于门被被测代码指挥。故以包内默认位置为准，
  // 另有配置过的 cacheDir 时一并算作来源（两个都查）。
  const candidates = new Set<string>();
  const def = defaultCacheModelDir();
  if (def) candidates.add(def);
  try {
    const { env } = await import("@huggingface/transformers");
    if (env.cacheDir) candidates.add(join(env.cacheDir, EMBED_MODEL));
  } catch {
    /* transformers 不可导入时不视为「有缓存来源」：由 envDir / noSource 分支决定 */
  }

  const hit = [...candidates].find((p) => existsSync(p));
  return { envDir, cacheDir: hit ?? null };
}

/** transformers 包内默认缓存位置（`<pkg>/.cache/<model>`）；解析不到时返回 null */
function defaultCacheModelDir(): string | null {
  try {
    const pkg = Bun.resolveSync(
      "@huggingface/transformers/package.json",
      import.meta.dir,
    );
    return join(dirname(pkg), ".cache", EMBED_MODEL);
  } catch {
    return null;
  }
}

/** broken 时注册一条必定失败的用例：把「静默 skip」变成「显式判红」并给出原因 */
export function registerModelGateFailure(gate: ModelGate, label: string): void {
  if (gate.status !== "broken") return;
  test(`${label}：模型来源存在却仍不可用（真实故障，判红）`, () => {
    throw new Error(`[${label}] ${gate.detail}`);
  });
}
