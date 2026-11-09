import { test, expect } from "bun:test";
import { join } from "node:path";
import { extractText, ExtractionError } from "../src/knowledge/extract";

// 文本格式直读测试：md/txt/html 不走第三方解析库，夹具为纯文本文件。
const FIX_DIR = join(import.meta.dir, "fixtures", "kb-extract");
const fix = (name: string) => join(FIX_DIR, name);

test("extractText md 直读保留标题与正文", async () => {
  const r = await extractText(fix("sample.md"), "md");
  expect(r.text).toContain("# 定价政策");
  expect(r.title).toBeUndefined();
});

test("extractText txt 直读返回原文", async () => {
  const r = await extractText(fix("sample.txt"), "txt");
  expect(r.text).toContain("纯文本备注内容");
  expect(r.text).not.toContain("#");
});

test("extractText html 去除 script/style/nav 并保留正文结构", async () => {
  const r = await extractText(fix("page.html"), "html");
  expect(r.text).not.toMatch(/<script|function\s*\(/);
  expect(r.text).toContain("正文段落");
  // header/nav/footer 文本也一并剔除（页脚版权、导航链接不进切块）
  expect(r.text).not.toContain("页脚导航链接");
  expect(r.text).not.toContain("首页");
  expect(r.text).not.toContain("trackVisit");
  expect(r.text).toContain("知识库支持文档检索与语义问答");
});

test("extractText 不存在的文件抛 ExtractionError", async () => {
  expect(extractText(fix("no-such-file.md"), "md")).rejects.toThrow(ExtractionError);
});
