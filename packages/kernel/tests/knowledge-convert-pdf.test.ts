/**
 * pdf 双路径转换测试（文本层优先 + 内嵌图片提取）
 *
 * 覆盖：
 * 1. 有文本层 pdf——unpdf 抽文本直接返回（via=pdf(unpdf)，不提图片）；
 * 2. 无文本层扫描件（fixture：8 个 FlateDecode DeviceRGB 8bpc 图）——
 *    内嵌图片逐页解压→RGBA→jpeg，markdown 按「## 第 N 页」+ data URI 组织；
 * 3. 不可解码图片流（垃圾字节的 FlateDecode）——跳过该图并在 warnings 注明。
 */
import { describe, test, expect, afterAll } from "bun:test";
import { convertPdfSmart } from "../src/knowledge/convert/pdf-smart";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIX = join(import.meta.dir, "fixtures/knowledge-convert");

// 图片落盘 sink：pdf 扫描件产物为 data URI（外联化由任务 5 编排层处理），本函数不落盘
const sink = { dirAbs: join(tmpdir(), "kb-pdf-sink-unused"), relPrefix: "../source/x" };

// 测试内构造的 pdf 临时文件，跑完统一清理
const generated: string[] = [];
afterAll(() => {
  for (const p of generated) rmSync(p, { force: true });
});

// ---- 手工构造最小合法 PDF（对象全 ASCII，xref 偏移即字符串长度）----

/** 生成 stream 对象体 */
function streamObj(body: string): string {
  return `<< /Length ${body.length} >>\nstream\n${body}\nendstream`;
}

/**
 * 含文本层的极简 PDF：Type0/Identity-H 字体 + ToUnicode 1:1 映射
 * （glyph id = unicode 码位），content stream 用 hex string 写文本。
 * 这样 pdf.js 无需内嵌字体即可按 ToUnicode 解出原文本。
 */
function makeMinimalPdf(text: string): string {
  // 文本 → 4 位 hex 串（每个码点一组，即 glyph id）
  const hex = [...text]
    .map((c) => (c.codePointAt(0) as number).toString(16).padStart(4, "0"))
    .join("");
  const content = `BT /F1 24 Tf 72 700 Td <${hex}> Tj ET`;
  // ToUnicode CMap：用到的码点逐一做 glyph→unicode 1:1 映射
  const codes = [...new Set([...text])].sort();
  const bfchar = codes
    .map((c) => {
      const h = (c.codePointAt(0) as number).toString(16).padStart(4, "0");
      return `<${h}> <${h}>`;
    })
    .join("\n");
  const cmap = [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
    `${codes.length} beginbfchar`,
    bfchar,
    "endbfchar",
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end",
    "end",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>",
    "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 6 0 R >>",
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> /FontDescriptor 8 0 R /DW 1000 >>",
    streamObj(cmap),
    streamObj(content),
    "<< /Type /FontDescriptor /FontName /STSong-Light /Flags 4 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -254 /CapHeight 880 /StemV 0 >>",
  ];
  return assemblePdf(objects);
}

/**
 * 无文本层 + 不可解码图片流的 PDF：content 只有 BT/ET（unpdf 文本为空），
 * 另含一个 /Filter /FlateDecode 但 stream 为垃圾字节的 image 对象
 * （未挂进页面 Resources——parseEmbeddedImages 是纯字节级正则扫描，仍会找到它）。
 */
function makeCorruptPdf(): string {
  const garbage = "X".repeat(64); // 非 deflate 头，inflateSync 必抛
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
    streamObj("BT ET"),
    streamObj(garbage).replace(
      "<< /Length 64 >>",
      "<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length 64 >>",
    ),
  ];
  return assemblePdf(objects);
}

/** 拼对象 → xref → trailer，写出临时文件并返回路径 */
function assemblePdf(objects: string[]): string {
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  const p = join(tmpdir(), `kb-pdf-gen-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  writeFileSync(p, Buffer.from(out, "latin1"));
  generated.push(p);
  return p;
}

describe("pdf 双路径", () => {
  test("有文本层: 直接返回文本 markdown", async () => {
    const pdfPath = makeMinimalPdf("你好 世界");
    const r = await convertPdfSmart(pdfPath, sink);
    expect(r.via).toBe("pdf(unpdf)");
    expect(r.markdown).toContain("你好 世界");
    expect(r.images.length).toBe(0);
  });

  test("无文本层扫描件: 内嵌图片逐页提取为 jpeg data URI", async () => {
    const r = await convertPdfSmart(join(FIX, "pdf-scanned.pdf"), sink);
    expect(r.via).toBe("pdf(内嵌图片提取)");
    expect(r.markdown).toContain("## 第 1 页");
    const uris = r.markdown.match(/data:image\/jpeg;base64,[A-Za-z0-9+/=]+/g) ?? [];
    expect(uris.length).toBe(8);
    for (const u of uris) expect(u.length).toBeGreaterThan(100_000);
  });

  test("不可解码图片流: 跳过并在 warnings 注明", async () => {
    const corruptPdfPath = makeCorruptPdf();
    const r = await convertPdfSmart(corruptPdfPath, sink);
    expect(r.warnings.some((w) => w.includes("不可解码"))).toBe(true);
    expect(r.markdown).not.toContain("## 第 1 页");
  });
});
