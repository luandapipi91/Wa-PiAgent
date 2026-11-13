/**
 * 转换编排器测试（格式分发 + mirror 落盘 + 降级信号）
 *
 * 覆盖：
 * 1. docx（altChunk 样本）——md 落盘 mirror/<rel>.md、图片落 _assets/<rel>/、via 透传；
 * 2. txt 直通复制——via=passthrough、内容逐字节一致；
 * 3. html 库转换——via=html(turndown)、外联化后无 data:image 残留；
 * 4. 畸形 docx（MHT 无 boundary）——ok:false 降级信号，reason 非空；
 * 5. 直通源文件不存在——同样 ok:false（indexer 靠它降级，绝不抛异常）；
 * 6. 分发集合外的扩展名（xlsx）——精确 { ok:false, reason:"unsupported" }；
 * 7. CONVERTER_VERSION 为整数常量。
 */
import { describe, test, expect, afterAll } from "bun:test";
import { convertToMirror, CONVERTER_VERSION } from "../src/knowledge/convert";
import { zipSync, strToU8 } from "fflate";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIX = join(import.meta.dir, "fixtures/knowledge-convert");

// 临时根目录下 mirror/ 作为镜像目录（断言 mdPath.endsWith(join("mirror", ...))）
const root = mkdtempSync(join(tmpdir(), "kb-orch-"));
const mirrorDir = join(root, "mirror");
const srcDir = join(root, "src");
mkdirSync(srcDir, { recursive: true });

// 畸形 docx：document.xml 含 altChunk 字样，但 afchunk.mht 损坏（无 boundary 行）
const brokenDocxPath = join(srcDir, "broken.docx");
writeFileSync(
  brokenDocxPath,
  zipSync({
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
        `</Types>`
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId0" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
        `</Relationships>`
    ),
    "word/document.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ` +
        `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<w:body><w:altChunk r:id="rId1"/></w:body></w:document>`
    ),
    // 损坏 MHT：multipart 声明后没有 boundary 分隔行，解析必然失败
    "word/afchunk.mht": strToU8(
      "MIME-Version: 1.0\nContent-Type: multipart/related\n\n<html><body>损坏正文</body></html>"
    ),
  })
);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("convertToMirror 编排", () => {
  test("docx: 产物落盘 mirror/<rel>.md + _assets/", async () => {
    const r = await convertToMirror(join(FIX, "docx-altchunk.docx"), "顾客/顾客列表.docx", mirrorDir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.via).toBe("altChunk(mht→html)");
    expect(existsSync(r.mdPath)).toBe(true);
    expect(r.mdPath.endsWith(join("mirror", "顾客", "顾客列表.docx.md"))).toBe(true);
    expect(existsSync(join(mirrorDir, "_assets", "顾客", "顾客列表.docx", "img1.png"))).toBe(true);
  });

  test("txt/md 直通复制, via=passthrough", async () => {
    writeFileSync(join(srcDir, "notes.txt"), "纯文本内容");
    const r = await convertToMirror(join(srcDir, "notes.txt"), "notes.txt", mirrorDir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.via).toBe("passthrough");
    expect(readFileSync(r.mdPath, "utf8")).toBe("纯文本内容");
  });

  test("html 走库转换且外联化后无 data:image", async () => {
    writeFileSync(join(srcDir, "p.html"), "<html><body><h1>标题</h1><p>正文</p></body></html>");
    const r = await convertToMirror(join(srcDir, "p.html"), "p.html", mirrorDir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.via).toBe("html(turndown)");
    expect(readFileSync(r.mdPath, "utf8")).toContain("标题");
    expect(readFileSync(r.mdPath, "utf8")).not.toMatch(/data:image/);
  });

  test("畸形 docx(MHT 无 boundary) → ok:false 降级信号", async () => {
    const r = await convertToMirror(brokenDocxPath, "broken.docx", mirrorDir);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason.length).toBeGreaterThan(0);
  });

  test("直通源文件不存在 → ok:false 且 reason 非空", async () => {
    const r = await convertToMirror(join(srcDir, "ghost.txt"), "ghost.txt", mirrorDir);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason.length).toBeGreaterThan(0);
  });

  test("scan 类型集合外 → ok:false unsupported", async () => {
    const r = await convertToMirror(join(srcDir, "data.xlsx"), "data.xlsx", mirrorDir);
    expect(r).toEqual({ ok: false, reason: "unsupported" });
  });

  test("CONVERTER_VERSION 为数字常量", () => {
    expect(Number.isInteger(CONVERTER_VERSION)).toBe(true);
  });
});
