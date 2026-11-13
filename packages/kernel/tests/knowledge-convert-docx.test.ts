/**
 * docx 双通道转换测试（altChunk 补偿 + 普通 docx 占位符按序外联）
 *
 * 覆盖：
 * 1. altChunk 样本（腾讯文档导出）——正文来自 MHT、图片按 Content-Location 外联，
 *    断言零 data:image 与零 file:///C:/fake/ 残留；
 * 2. 普通 docx——库产占位符与 document.xml r:embed 一一对应，按序外联落盘；
 * 3. 0 字节损坏图——不落盘、引用置空、warnings 记「0 字节」；
 * 4. 占位符/图片数量不齐——warnings 记「数量不齐」，多余占位符置空。
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { convertDocxSmart } from "../src/knowledge/convert/docx-smart";
import { zipSync, strToU8 } from "fflate";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIX = join(import.meta.dir, "fixtures/knowledge-convert");

// 每用例独立临时目录（测试尾部统一清理）
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kb-docx-"));
  tmpDirs.push(dir);
  return dir;
}
const tmpDirs: string[] = [];

// 图片落盘 sink：目录指向临时目录，md 引用前缀模拟 kb 预览的相对路径
function makeSink(dir: string) {
  return { dirAbs: dir, relPrefix: "../source/x" };
}

// 70 字节 1x1 png（构造损坏样本用）
const PNG1PX = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x60, 0x00, 0x00, 0x00,
  0x06, 0x00, 0x05, 0x51, 0xab, 0x0d, 0x06, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

// ---- 手工构造 docx 的最小合法骨架 ----

const CT_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Default Extension="png" ContentType="image/png"/>` +
  `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
  `</Types>`;

const ROOT_RELS_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId0" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
  `</Relationships>`;

// 单个 inline drawing（r:embed 指向关系 Id；mammoth 为每个 blip 产一个 data URI 占位符）
function drawing(rid: string, n: number): string {
  return (
    `<w:drawing><wp:inline distL="0" distR="0" distB="0" distT="0"><wp:extent cy="30610" cx="5722"/>` +
    `<wp:docPr descr="d" name="p${n}" id="${n}"/><wp:cNvGraphicFramePr/>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>` +
    `<pic:nvPicPr><pic:cNvPr descr="d" name="p${n}" id="${n + 10}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill rotWithShape="true"><a:blip r:embed="${rid}"/><a:srcRect b="0" r="0" t="0" l="0"/><a:stretch/></pic:blipFill>` +
    `<pic:spPr><a:xfrm rot="21600000"><a:off y="0" x="0"/><a:ext cy="30610" cx="5722"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`
  );
}

function docXml(rids: string[]): string {
  const body = rids.map((r, i) => `<w:p><w:r>${drawing(r, i + 1)}</w:r></w:p>`).join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ` +
    `xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ` +
    `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<w:body>${body}</w:body></w:document>`
  );
}

function relsXml(pairs: [string, string][]): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    pairs
      .map(
        ([id, t]) =>
          `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${t}"/>`
      )
      .join("") +
    `</Relationships>`
  );
}

let brokenDocxPath = "";
let mismatchDocxPath = "";

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "kb-docx-fix-"));
  tmpDirs.push(dir);

  // broken: 2 个 r:embed；rels 映射 image1.png(正常) / image2.png(0 字节)
  const brokenZip = zipSync({
    "[Content_Types].xml": strToU8(CT_XML),
    "_rels/.rels": strToU8(ROOT_RELS_XML),
    "word/document.xml": strToU8(docXml(["rId1", "rId2"])),
    "word/_rels/document.xml.rels": strToU8(relsXml([["rId1", "media/image1.png"], ["rId2", "media/image2.png"]])),
    "word/media/image1.png": PNG1PX,
    "word/media/image2.png": new Uint8Array(0),
  });
  brokenDocxPath = join(dir, "broken.docx");
  writeFileSync(brokenDocxPath, brokenZip);

  // mismatch: document.xml 引用 3 张图，第 3 个关系 Id 用非 rIdN 形态——
  // mammoth 按 rels 产出 3 个占位符，而 extractDocxImagesInOrder 只认 r:embed="rIdN" → 只提取 2 张 → 数量不齐
  const mismatchZip = zipSync({
    "[Content_Types].xml": strToU8(CT_XML),
    "_rels/.rels": strToU8(ROOT_RELS_XML),
    "word/document.xml": strToU8(docXml(["rId1", "rId2", "pic3"])),
    "word/_rels/document.xml.rels": strToU8(
      relsXml([["rId1", "media/image1.png"], ["rId2", "media/image2.png"], ["pic3", "media/image3.png"]])
    ),
    "word/media/image1.png": PNG1PX,
    "word/media/image2.png": PNG1PX,
    "word/media/image3.png": PNG1PX,
  });
  mismatchDocxPath = join(dir, "mismatch.docx");
  writeFileSync(mismatchDocxPath, mismatchZip);
});

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe("docx 双通道", () => {
  test("altChunk 样本: 正文来自 MHT, 图片外联, 无 data: 无 fake 残留", async () => {
    const sink = makeSink(tmpDir());
    const r = await convertDocxSmart(join(FIX, "docx-altchunk.docx"), sink);
    expect(r.via).toBe("altChunk(mht→html)");
    expect(r.markdown).toContain("查询对象"); // MHT 正文真实内容
    expect(r.markdown).not.toMatch(/data:image/); // 审查重点 1
    expect(r.markdown).not.toContain("file:///C:/fake/");
    expect(r.images.length).toBeGreaterThanOrEqual(1);
    for (const p of r.images) expect(Bun.file(p).size).toBeGreaterThan(0);
  });

  test("普通 docx: 占位符数=media 图数, 按序外联", async () => {
    const sink = makeSink(tmpDir());
    const r = await convertDocxSmart(join(FIX, "docx-normal.docx"), sink);
    expect(r.via).toBe("docx(mammoth)");
    const refs = [...r.markdown.matchAll(/\]\((\.\.\/[^\s)]+)\)/g)].length;
    expect(refs).toBe(8); // 样本实测 8 图
    expect(r.images.length).toBe(8);
    expect(r.markdown).toContain(`${sink.relPrefix}/img1.png`);
  });

  test("0 字节损坏图: 跳过落盘, 引用置空, 告警", async () => {
    const sink = makeSink(tmpDir());
    const r = await convertDocxSmart(brokenDocxPath, sink);
    expect(r.images.length).toBe(1); // 只落盘正常那张
    expect(r.markdown).toContain("/img1.png");
    expect(r.markdown).toContain("![d]()"); // 0 字节图的占位符被置空
    expect(r.warnings.some((w) => w.includes("0 字节"))).toBe(true);
  });

  test("占位符 3 / 提取图 2: 数量不齐告警, 多余占位符置空", async () => {
    const sink = makeSink(tmpDir());
    const r = await convertDocxSmart(mismatchDocxPath, sink);
    expect(r.warnings.some((w) => w.includes("数量不齐"))).toBe(true);
    expect(r.markdown.match(/data:image/g)).toBeNull(); // 全部外联或置空
    expect(r.markdown).toContain("![d]()"); // 多余的第 3 个占位符被置空
    expect(r.markdown).toContain("../source/x/img1.png");
  });
});
