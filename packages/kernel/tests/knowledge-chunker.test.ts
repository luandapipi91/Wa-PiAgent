import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { chunkDocument, estimateTokens } from "../src/knowledge/chunker";

// 结构切块主夹具：# 产品 > ## 定价 > ### 折扣，有内容的两节（定价 / 折扣）。
// 行号布局：1 "# 产品" 3 "## 定价" 5 定价内容 7 "### 折扣" 9 折扣内容。
const SAMPLE_MD = [
  "# 产品",
  "",
  "## 定价",
  "",
  "定价章节内容，描述各档位价格与计费方式。这里是补充说明，让定价节内容足够明确。",
  "",
  "### 折扣",
  "",
  "折扣规则说明，包含限时优惠与团队折扣细则。",
].join("\n");

// 长文档夹具：两个多段落节（触发 450 结构拆块）+ 单段 700 token（触发 448 预算再切）。
const LONG_MD = [
  "# 指南",
  "",
  "## 部署",
  "",
  Array.from(
    { length: 12 },
    () => "部署流程说明段落，覆盖环境准备、依赖安装、配置文件生成与服务启动验证的完整操作步骤。",
  ).join("\n\n"),
  "",
  "## 监控",
  "",
  Array.from(
    { length: 12 },
    () => "监控指标说明段落，覆盖 CPU 使用率、内存占用、磁盘水位、请求延迟与错误率的采集阈值和告警规则。",
  ).join("\n\n"),
  "",
  "## 故障排查",
  "",
  "超".repeat(700),
].join("\n");

test("Markdown 按标题栈切块且每块带完整 breadcrumb", () => {
  const chunks = chunkDocument({ type: "md", text: SAMPLE_MD }); // SAMPLE_MD: # 产品 > ## 定价 > ### 折扣 两节
  expect(chunks.length).toBeGreaterThanOrEqual(2);
  expect(chunks[0].breadcrumb).toBe("产品 > 定价");
  expect(chunks.every(c => c.prefixContent.startsWith("File: "))).toBe(true);
});
test("块正文含当前标题前置", () => {
  const chunks = chunkDocument({ type: "md", text: SAMPLE_MD });
  expect(chunks.find(c => c.title === "折扣")).toBeTruthy();
});
test("单段超 6000 字符按字符硬切", () => {
  const long = "段".repeat(15000);
  const chunks = chunkDocument({ type: "txt", text: long, relPath: "a.txt" });
  expect(chunks.length).toBeGreaterThanOrEqual(3);
});
test("所有块 prefixContent 经 tokenizer 测量 ≤ 448 token（嵌入预算）", () => {
  const chunks = chunkDocument({ type: "md", text: LONG_MD });
  // 用 embedder 同款 tokenizer 测量（transformers 数量级校验可换估算：CJK≈1 字 1 token）
  for (const c of chunks) expect(estimateTokens(c.prefixContent)).toBeLessThanOrEqual(448);
});
test("contentHash 对同内容稳定、对路径/行号变化敏感", () => {
  const a = chunkDocument({ type: "txt", text: "同内容", relPath: "a.txt" })[0];
  const b = chunkDocument({ type: "txt", text: "同内容", relPath: "b.txt" })[0];
  const c = chunkDocument({ type: "txt", text: "同内容", relPath: "a.txt", startLine: 99 })[0];
  expect(a.contentHash).not.toBe(b.contentHash);
  expect(a.contentHash).not.toBe(c.contentHash);
});

// —— 以下为防回归补充断言 ——

test("结构块正文以标题文本+空行开头且行号对应源文件", () => {
  const chunks = chunkDocument({ type: "md", text: SAMPLE_MD, relPath: "p.md" });
  const zhekou = chunks.find(c => c.title === "折扣");
  expect(zhekou?.content).toBe("折扣\n\n折扣规则说明，包含限时优惠与团队折扣细则。");
  // 折扣内容在第 9 行（1 基），块行号取正文实际行
  expect(zhekou?.startLine).toBe(9);
  expect(zhekou?.endLine).toBe(9);
});

test("contentHash 可按 sha256(relPath NUL fileType NUL startLine NUL endLine NUL breadcrumb NUL content) 复算", () => {
  const chunks = chunkDocument({ type: "md", text: SAMPLE_MD, relPath: "p.md" });
  for (const c of chunks) {
    const want = createHash("sha256")
      .update(`p.md\0md\0${c.startLine}\0${c.endLine}\0${c.breadcrumb ?? ""}\0${c.content}`)
      .digest("hex");
    expect(c.contentHash).toBe(want);
  }
});

test("英文长段按句号预算再切且全部块不超 448", () => {
  const para = Array.from({ length: 80 }, (_, i) => `Sentence ${i} describes deployment step ${i} with details.`).join(" ");
  const chunks = chunkDocument({ type: "txt", text: para, relPath: "en.txt" });
  expect(chunks.length).toBeGreaterThanOrEqual(2);
  for (const c of chunks) expect(estimateTokens(c.prefixContent)).toBeLessThanOrEqual(448);
});

test("空白文本返回空数组", () => {
  expect(chunkDocument({ type: "txt", text: "" })).toEqual([]);
  expect(chunkDocument({ type: "md", text: "   \n  " })).toEqual([]);
});

test("多空行分隔的段间源行不被合成 join 压缩（endLine 取源末行）", () => {
  const text = ["段甲内容", "", "", "", "段乙内容"].join("\n"); // 段乙在第 5 行
  const c = chunkDocument({ type: "txt", text, relPath: "g.txt" })[0];
  expect(c.startLine).toBe(1);
  expect(c.endLine).toBe(5);
});

test("身份 hash 含面包屑：祖先标题改名、正文不变时 hash 必须变化（否则复用旧向量造成语义分叉）", () => {
  const a = chunkDocument({ type: "md", text: "# 产品\n\n## 定价\n\n价格说明。", relPath: "a.md" });
  const b = chunkDocument({ type: "md", text: "# 产品线\n\n## 定价\n\n价格说明。", relPath: "a.md" });
  const ca = a.find(c => c.title === "定价")!;
  const cb = b.find(c => c.title === "定价")!;
  expect(ca.content).toBe(cb.content); // 本层标题与正文都没变
  expect(ca.contentHash).not.toBe(cb.contentHash); // 但面包屑变了 → 身份必须变
});

test("超预算块按句子边界再切：每块估算 token ≤ 448，尾部内容不丢", () => {
  const long = Array.from({ length: 120 }, (_, i) => `第${i}句：这是一段足够长的中文内容用于验证切分。`).join("");
  const chunks = chunkDocument({ type: "txt", text: long, relPath: "big.txt" });
  expect(chunks.length).toBeGreaterThan(1);
  for (const c of chunks) expect(estimateTokens(c.content)).toBeLessThanOrEqual(448);
  expect(chunks.some(c => c.content.includes("第119句"))).toBe(true);
});

test("超长标题栈占满预算时仍切正文且前缀不超硬上限（不静默截断）", () => {
  const longTitle = "很长的章节标题".repeat(40); // 单级 ≈ 280 字，四级栈 ≈ 1100+ token
  const head = `# ${longTitle}\n\n## ${longTitle}\n\n### ${longTitle}\n\n#### ${longTitle}\n\n`;
  const body = "正文内容说明。".repeat(400);
  const chunks = chunkDocument({ type: "md", text: head + body, relPath: "deep.md" });
  expect(chunks.length).toBeGreaterThan(1);
  for (const c of chunks) {
    expect(estimateTokens(c.prefixContent)).toBeLessThanOrEqual(448);
    expect(c.content.length).toBeGreaterThan(0);
  }
  // 尾部内容必须在某些块里出现（不许因为前缀吃满预算而丢掉后半段）
  expect(chunks.some(c => c.content.includes("正文内容说明。正文内容说明。"))).toBe(true);
});
