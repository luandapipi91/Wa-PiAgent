import { test, expect } from "bun:test";
import {
  EMBED_DIM,
  embedDocuments,
  embedQuery,
  embedFingerprint,
  resetEmbedderForTest,
} from "../src/memory/embedder";
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

test.skipIf(modelUnavailable)("embedDocuments 返回 512 维 Float32 字节且长度与输入一致", async () => {
  const out = await embedDocuments(["发版流程需要先跑单元测试", "今天中午吃什么"]);
  expect(out).toHaveLength(2);
  expect(out[0]).toBeInstanceOf(Uint8Array);
  expect(out[0].byteLength).toBe(EMBED_DIM * 4);
  // 冷环境下首次模型下载/加载（约 23MB）可能超过 bun 默认的 5s 单测超时，故此例显式放宽。
}, 60_000);

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

// 降级路径（failNextLoad 强制加载失败）本身就不依赖真模型：离线也必须跑 ——
// 它断言的正是「模型不可用时 embedQuery 返回 null 而不抛错」。
test("模型不可用时返回 null 而不抛错", async () => {
  resetEmbedderForTest({ failNextLoad: true });
  expect(await embedQuery("任意文本")).toBeNull();
});
