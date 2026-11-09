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

// 最终审查修复回归（T4①）：未闭合的 <script>（截断页常见）配对剔除捕捉不到，
// 会把后续正文全部吞进脚本块——补一遍贪婪剔到文末兜底
test("extractText html 未闭合 script 兜底剔除（截断页面）", async () => {
  const r = await extractText(fix("unclosed.html"), "html");
  expect(r.text).toContain("正文第一段");
  expect(r.text).not.toContain("console.log");
  expect(r.text).not.toMatch(/<script/i);
});

// 最终审查修复回归（T4②）：&amp; 必须最后替换，否则 &amp;lt; 被双重解码成 <
test("extractText 实体解码顺序：&amp;lt; 单次解码保持文本形态", async () => {
  const r = await extractText(fix("entities.html"), "html");
  // &amp;lt; 解码一次 → 字面文本 &lt;b&gt;，不再二次解码成真标签 <b>
  expect(r.text).toContain("&lt;b&gt;不应成为真标签&lt;/b&gt;");
  expect(r.text).not.toContain("<b>");
});
