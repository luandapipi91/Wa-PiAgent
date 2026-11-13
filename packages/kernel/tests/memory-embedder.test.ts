import { test, expect } from "bun:test";
import {
  EMBED_DIM,
  EMBED_DTYPE,
  EMBED_MODEL,
  EMBEDDER_IDLE_UNLOAD_MS,
  acquireEmbedderKeepAlive,
  embedderKeepAliveCountForTest,
  embedderLoadAttemptsForTest,
  coerceEmbeddings,
  embedDocuments,
  embedQuery,
  embedFingerprint,
  isEmbedderReady,
  maybeUnloadForIdle,
  modelCacheDir,
  preloadModel,
  resetEmbedderForTest,
  shouldUnloadForIdle,
  unloadModel,
} from "../src/memory/embedder";
import { WA_PI_DIR } from "@wa-pi/shared";
import { join } from "node:path";
import {
  probeModelAvailability,
  registerModelGateFailure,
} from "./helpers/model-gate";

// ---------------------------------------------------------------------------
// 模型可用性门（三态，见 tests/helpers/model-gate.ts）
//
// 本文件断言的是真实模型的真实行为（真实向量维度、真实语义相似度），因此必须先成功
// 加载 bge-small-zh-v1.5（首次运行需下载约 23MB）。门在文件顶部探测一次（会触发模型加载，
// 注意：模块顶层 await 不受 bun 单测超时约束）：
//   - available → 前 3 例照常执行，断言强度与联网时逐字一致；
//   - noSource  → 真没模型来源（离线 / 新克隆 / 无外网 CI）→ 前 3 例 skip 并打印原因；
//   - broken    → 声明了来源（WA_PI_MODEL_DIR / 本机缓存）却加载失败 → **判红**：不再把
//                 「embedder 加载路径被改坏」伪装成 skip（这正是本门存在的意义）。
// 后 2 例（指纹纯函数、failNextLoad 降级路径）本身不调模型、离线可跑，**不挂门**。
// ---------------------------------------------------------------------------
const gate = await probeModelAvailability();
registerModelGateFailure(gate, "memory-embedder.test");
const modelUnavailable = gate.status !== "available";

if (modelUnavailable) {
  console.warn(`[memory-embedder.test] ${gate.detail}`);
}

test.skipIf(modelUnavailable)("embedDocuments 返回 EMBED_DIM 维 Float32 字节且长度与输入一致（bge-base-zh 为 768 维）", async () => {
  const out = await embedDocuments(["发版流程需要先跑单元测试", "今天中午吃什么"]);
  expect(out).toHaveLength(2);
  expect(out[0]).toBeInstanceOf(Uint8Array);
  expect(out[0].byteLength).toBe(EMBED_DIM * 4);
  // 冷环境下首次模型下载/加载（约 98MB）可能超过 bun 默认的 5s 单测超时，故此例显式放宽。
}, 60_000);

// 选型钉子（2026-10-09 POC 结论）：bge-base-zh-v1.5 + CLS（bench hit@1 0.91 vs small/mean 0.73），
// 防止模型名 / 维度 / 池化口径被无意识地改回去。
test("选型契约：bge-base-zh-v1.5 / 768 维 / q8 / CLS 口径", () => {
  expect(EMBED_MODEL).toBe("Xenova/bge-base-zh-v1.5");
  expect(EMBED_DIM).toBe(768);
  const f = embedFingerprint();
  expect(f).toBe("Xenova/bge-base-zh-v1.5:q8:768");
});

test.skipIf(modelUnavailable)("语义相近的句子余弦相似度显著高于无关句", async () => {
  const [a, b, c] = await embedDocuments([
    "发版流程需要先跑单元测试",
    "上线前必须执行单元测试",
    "今天中午吃什么",
  ]);
  const toF = (u: Uint8Array) => new Float32Array(u.buffer, u.byteOffset, EMBED_DIM);
  const cos = (x: Float32Array, y: Float32Array) =>
    x.reduce((s, v, i) => s + v * y[i], 0);
  const near = cos(toF(a), toF(b));
  const far = cos(toF(a), toF(c));
  expect(near).toBeGreaterThan(0.6);
  expect(far).toBeLessThan(0.4);
});

test.skipIf(modelUnavailable)("embedQuery 输出与 embedDocuments 同维，且空输入返回 null", async () => {
  const q = await embedQuery("检索相关文章");
  expect(q!.byteLength).toBe(EMBED_DIM * 4);
  expect(await embedQuery("   ")).toBeNull();
});

// 指纹是纯字符串拼接，不调模型：离线也必须跑（挂门会让这条契约在无网 CI 上零断言）。
test("指纹稳定且随模型/维度变化", () => {
  const f = embedFingerprint();
  expect(f).toContain(EMBED_DIM.toString());
  expect(f).toBe(embedFingerprint());
});

test("modelCacheDir 指向 WA_PI_DIR/models（不内置模型时初始化下载的持久落盘处）", () => {
  expect(modelCacheDir()).toBe(join(WA_PI_DIR, "models"));
});

test("preloadModel 降级路径：模型加载失败时返回 false 不抛错（离线可跑）", async () => {
  resetEmbedderForTest({ failNextLoad: true });
  expect(await preloadModel()).toBe(false);
});

test.skipIf(modelUnavailable)("preloadModel 预热成功：初始化触发下载/加载（不推理）", async () => {
  resetEmbedderForTest();
  expect(await preloadModel()).toBe(true);
}, 60_000);

// 降级路径（failNextLoad 强制加载失败）本身就不依赖真模型：离线也必须跑 ——
// 它断言的正是「模型不可用时 embedQuery 返回 null 而不抛错」。
test("模型不可用时返回 null 而不抛错", async () => {
  resetEmbedderForTest({ failNextLoad: true });
  expect(await embedQuery("任意文本")).toBeNull();
});

// —— 失败重试语义（粘性缺陷修复：一次失败不再永久禁用到重启）—— 离线可跑，不挂门 ——
test("加载失败后不永久粘死：限频窗口过后下一次调用重新尝试加载", async () => {
  resetEmbedderForTest({ failNextLoad: true, retryAfterMs: 0 });
  expect(await embedDocuments(["x"])).toHaveLength(0); // 首次失败（failNextLoad 注入）
  expect(embedderLoadAttemptsForTest()).toBe(0);       // 注入失败不计入真实加载尝试
  // 窗口过后重新尝试加载：无论本次成功（模型可用环境）还是再次失败（离线），
  // 「真的重新加载了」才是被锁定的行为——旧实现的永久粘死在这里 attempts 恒为 0
  const second = await embedDocuments(["x"]);
  expect(embedderLoadAttemptsForTest()).toBe(1);
  if (!modelUnavailable) expect(second).toHaveLength(1);
});

test("失败后的限频窗口内不重试（防高频轮询打爆加载器）", async () => {
  resetEmbedderForTest({ failNextLoad: true, retryAfterMs: 60_000 });
  expect(await embedDocuments(["x"])).toHaveLength(0); // 首次失败
  expect(await embedDocuments(["x"])).toHaveLength(0); // 窗口内静默快速失败，不重新加载
  expect(embedderLoadAttemptsForTest()).toBe(0);
});

// —— 推理出口契约（coerceEmbeddings）：桌面进程曾出现「加载成功但推理返回空列表」的进程内状态问题，
// 出口必须校验长度并留下诊断日志（含模型/精度），静默空返回让排查者无迹可循 —— 离线可跑，不挂门 ——
test("coerceEmbeddings：输出与输入一一对应时逐条转 Float32 向量", () => {
  const fake = { tolist: () => [[0.1, 0.2], [0.3, 0.4]] };
  const out = coerceEmbeddings(fake, 2, { model: EMBED_MODEL, dtype: EMBED_DTYPE });
  expect(out).toHaveLength(2);
  expect(out[0].byteLength).toBe(8); // 2 个 float32
});

test("coerceEmbeddings：输出条数不匹配 → 返回空数组（下游以嵌入数量不匹配失败）", () => {
  const fake = { tolist: () => [[0.1, 0.2]] };
  const out = coerceEmbeddings(fake, 64, { model: EMBED_MODEL, dtype: EMBED_DTYPE });
  expect(out).toHaveLength(0);
});

test("coerceEmbeddings：输出为空列表/非数组/无 tolist → 返回空数组不抛错", () => {
  expect(coerceEmbeddings({ tolist: () => [] }, 64, { model: EMBED_MODEL, dtype: EMBED_DTYPE })).toHaveLength(0);
  expect(coerceEmbeddings({ }, 64, { model: EMBED_MODEL, dtype: EMBED_DTYPE })).toHaveLength(0);
  expect(coerceEmbeddings(null, 64, { model: EMBED_MODEL, dtype: EMBED_DTYPE })).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// 空闲自动卸载（性能优化：模型常驻 ~110-180MB，空闲 5 分钟卸载、用时重载 ~400ms；
// dispose 实测真降 RSS —— spike: 推理后 327MB → dispose+GC 后 219MB）
// ---------------------------------------------------------------------------

// 判定是纯函数：表驱动离线可跑，不挂模型门（挂门会让判定契约在无网 CI 零断言）
test("shouldUnloadForIdle 四分支表驱动：有管道+无 inflight+有使用记录+超阈值才卸", () => {
  const now = 1_000_000;
  const used = now - EMBEDDER_IDLE_UNLOAD_MS; // 恰好到阈值
  const cases: Array<[string, boolean, number, number, boolean]> = [
    // [名, hasPipe, inflight, lastUsedAt, 期望]
    ["空闲超阈值 → 卸", true, 0, used, true],
    ["未到阈值 → 不卸", true, 0, now - 1, false],
    ["推理进行中 → 不卸", true, 1, used, false],
    ["无管道（已卸/未加载）→ 不卸", false, 0, used, false],
    ["从未使用（lastUsedAt=0）→ 不卸", true, 0, 0, false],
  ];
  for (const [name, hasPipe, inflight, lastUsedAt, expected] of cases) {
    expect(shouldUnloadForIdle(now, lastUsedAt, inflight, hasPipe)).toBe(expected);
  }
});

test("unloadModel 无模型时幂等不抛错（离线可跑）", async () => {
  resetEmbedderForTest();
  await expect(unloadModel()).resolves.toBeUndefined();
});

// 保活：长任务（知识库索引）运行期间模型不得被空闲卸载——抽取阶段可能超过 5 分钟不调嵌入，
// 若此时把模型卸了，嵌入阶段要重新加载，用户看到的就是「建库到一半模型没了」。
test("shouldUnloadForIdle：保活引用未释放时不卸（即便已超空闲阈值）", () => {
  const now = 1_000_000;
  const used = now - EMBEDDER_IDLE_UNLOAD_MS;
  expect(shouldUnloadForIdle(now, used, 0, true, EMBEDDER_IDLE_UNLOAD_MS, 1)).toBe(false);
  expect(shouldUnloadForIdle(now, used, 0, true, EMBEDDER_IDLE_UNLOAD_MS, 0)).toBe(true);
});

test("acquireEmbedderKeepAlive 引用计数：幂等释放、归零后恢复可卸载", () => {
  resetEmbedderForTest();
  const release1 = acquireEmbedderKeepAlive();
  const release2 = acquireEmbedderKeepAlive();
  expect(embedderKeepAliveCountForTest()).toBe(2);
  release1();
  expect(embedderKeepAliveCountForTest()).toBe(1);
  release1(); // 重复释放不双重扣减
  expect(embedderKeepAliveCountForTest()).toBe(1);
  release2();
  expect(embedderKeepAliveCountForTest()).toBe(0);
});

test.skipIf(modelUnavailable)("保活期间空闲超时也不卸载，释放后下一轮才卸", async () => {
  resetEmbedderForTest();
  expect(await preloadModel()).toBe(true);
  const release = acquireEmbedderKeepAlive();
  const now = Date.now();
  expect(await maybeUnloadForIdle(now + EMBEDDER_IDLE_UNLOAD_MS + 60_000)).toBe(false);
  expect(isEmbedderReady()).toBe(true);
  release();
  expect(await maybeUnloadForIdle(now + EMBEDDER_IDLE_UNLOAD_MS + 120_000)).toBe(true);
  expect(isEmbedderReady()).toBe(false);
}, 120_000);

test.skipIf(modelUnavailable)("空闲卸载行为链：未超时不卸 → 超时卸 → 再次使用自动重载", async () => {
  resetEmbedderForTest();
  expect(await preloadModel()).toBe(true);
  expect(isEmbedderReady()).toBe(true);

  const now = Date.now();
  // 未超时：不卸载，模型仍就绪
  expect(await maybeUnloadForIdle(now - EMBEDDER_IDLE_UNLOAD_MS + 1)).toBe(false);
  expect(isEmbedderReady()).toBe(true);

  // 超时（now + 6min）：卸载，单例回到 idle
  expect(await maybeUnloadForIdle(now + EMBEDDER_IDLE_UNLOAD_MS + 60_000)).toBe(true);
  expect(isEmbedderReady()).toBe(false);

  // 再次使用：懒加载自动重载（卸载/重载闭环，正是「需要的时候再重新加载」的验收）
  const vec = await embedQuery("卸载后重新加载验证");
  expect(vec).not.toBeNull();
  expect(isEmbedderReady()).toBe(true);
}, 120_000);
