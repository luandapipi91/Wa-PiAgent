import { test, expect } from "bun:test";
import { join } from "node:path";
import { extractText, ExtractionError } from "../src/knowledge/extract";

// 二进制格式测试（docx/pdf 走第三方解析库，惰性 import）：夹具为仓库内提交的最小合法文件。
// sample.docx：fflate 手工构造的最小 OOXML 包（三文件 zip）；sample.pdf：手写 Identity-H+ToUnicode
// 含中文文本层；broken.pdf：sample.pdf 截尾 60%（xref/trailer 丢失）。生成脚本见任务 4 Spike（未入库）。
const FIX_DIR = join(import.meta.dir, "fixtures", "kb-extract");
const fix = (name: string) => join(FIX_DIR, name);

test("extractText docx 抽出中文正文", async () => {
  const r = await extractText(fix("sample.docx"), "docx");
  expect(r.text.length).toBeGreaterThan(50);
  expect(r.text).toContain("知识库产品定价政策");
});

test("extractText pdf 抽出中文文本层", async () => {
  const r = await extractText(fix("sample.pdf"), "pdf");
  expect(r.text).toContain("知识");
  expect(r.text).toContain("定价");
});

test("损坏 PDF 抛 ExtractionError 不产生半字符串", async () => {
  expect(extractText(fix("broken.pdf"), "pdf")).rejects.toThrow(ExtractionError);
});

test("docx/pdf 损坏文件的 ExtractionError 携带文件路径", async () => {
  const err: unknown = await extractText(fix("broken.pdf"), "pdf").catch(e => e);
  expect(err).toBeInstanceOf(ExtractionError);
  expect((err as Error).message).toContain("broken.pdf");
});
