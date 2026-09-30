import { test, expect } from "bun:test";
import {
  EMBED_DIM,
  embedDocuments,
  embedQuery,
  embedFingerprint,
  resetEmbedderForTest,
} from "../src/memory/embedder";

test("embedDocuments 返回 512 维 Float32 字节且长度与输入一致", async () => {
  const out = await embedDocuments(["发版流程需要先跑单元测试", "今天中午吃什么"]);
  expect(out).toHaveLength(2);
  expect(out[0]).toBeInstanceOf(Uint8Array);
  expect(out[0].byteLength).toBe(EMBED_DIM * 4);
  // 本用例承担首次模型下载/加载（约 23MB），远超 bun 默认的 5s 单测超时。
}, 60_000);

test("语义相近的句子余弦相似度显著高于无关句", async () => {
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

test("embedQuery 输出与 embedDocuments 同维，且空输入返回 null", async () => {
  const q = await embedQuery("检索相关文章");
  expect(q!.byteLength).toBe(EMBED_DIM * 4);
  expect(await embedQuery("   ")).toBeNull();
});

test("指纹稳定且随模型/维度变化", () => {
  const f = embedFingerprint();
  expect(f).toContain(EMBED_DIM.toString());
  expect(f).toBe(embedFingerprint());
});

test("模型不可用时返回 null 而不抛错", async () => {
  resetEmbedderForTest({ failNextLoad: true });
  expect(await embedQuery("任意文本")).toBeNull();
});
