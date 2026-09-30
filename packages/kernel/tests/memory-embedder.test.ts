import { test, expect } from "bun:test";
import {
  EMBED_DIM,
  embedDocuments,
  embedQuery,
  embedFingerprint,
  resetEmbedderForTest,
} from "../src/memory/embedder";

// ---------------------------------------------------------------------------
// 模型可用性门（本文件所有用例的统一前置）
//
// 本文件断言的是真实模型的真实行为（真实向量维度、真实语义相似度），因此必须先成功
// 加载 bge-small-zh-v1.5（首次运行需下载约 23MB）。离线 / 新克隆 / 无外网的 CI 上
// 加载必然失败，`embedQuery` 会返回 null —— 这是「环境不具备条件」，不是被测代码的错。
// 故在文件顶部探测一次（会触发模型加载，注意：模块顶层 await 不受 bun 单测超时约束）：
//   - 模型可用   → 5 个用例照常执行，断言强度与联网时逐字一致；
//   - 模型不可用 → 全部用例 skip（不是 fail）并打印原因，使离线环境下的全量测试保持
//     自足，且不会把「网络问题」伪装成「断言不符」。
// 约定：后续任何依赖模型 / 外网的测试文件，复用同一模式
// （顶部一次性探测 + `test.skipIf` + 不可用时打印清晰原因）。
// ---------------------------------------------------------------------------
const modelProbe = await embedQuery("可用性探测");
const modelUnavailable = modelProbe === null;

if (modelUnavailable) {
  console.warn(
    "[memory-embedder.test] 跳过本文件全部用例：embedding 模型不可用。\n" +
      "  原因：模型加载失败（离线 / 无法访问 hf-mirror.com / 未随包内置模型）。\n" +
      "  这不是断言失败，也不是被测代码的缺陷 —— 请在有网络的机器上重跑，\n" +
      "  或设置 WA_PI_MODEL_DIR 指向本地模型目录、WA_PI_HF_ENDPOINT 指向可用镜像。",
  );
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

test.skipIf(modelUnavailable)("指纹稳定且随模型/维度变化", () => {
  const f = embedFingerprint();
  expect(f).toContain(EMBED_DIM.toString());
  expect(f).toBe(embedFingerprint());
});

test.skipIf(modelUnavailable)("模型不可用时返回 null 而不抛错", async () => {
  resetEmbedderForTest({ failNextLoad: true });
  expect(await embedQuery("任意文本")).toBeNull();
});
