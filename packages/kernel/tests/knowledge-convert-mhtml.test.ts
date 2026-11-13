/**
 * MHTML 解析器单元测试
 *
 * 覆盖 altChunk docx（腾讯文档导出）场景：
 * 1. 真实样本解析——1 个 text/html 正文 part + 多个 base64 图片 part，
 *    图片须带 file:/// Content-Location 且字节非空；
 * 2. quoted-printable 解码——=XX 转义还原与 =\r\n / =\n 软换行删除。
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { parseMhtParts, qpDecodeBytes } from "../src/knowledge/convert/mhtml";

const FIX = join(import.meta.dir, "fixtures/knowledge-convert");

describe("mhtml 解析", () => {
  test("真实 altChunk 样本: 1 个 text/html + 多个 image part", () => {
    const zip = unzipSync(readFileSync(join(FIX, "docx-altchunk.docx")));
    const parts = parseMhtParts(zip["word/afchunk.mht"]);
    expect(parts.filter(p => p.contentType.startsWith("text/html")).length).toBe(1);
    // 锁住 mojibake 回归：html part 为 quoted-printable 的 utf-8 字节，解码后必须含中文原文
    const htmlPart = parts.find(p => p.contentType.startsWith("text/html"))!;
    expect(new TextDecoder().decode(qpDecodeBytes(htmlPart.body))).toContain("顾客列表");
    const imgs = parts.filter(p => p.contentType.startsWith("image/"));
    expect(imgs.length).toBeGreaterThanOrEqual(1);
    for (const img of imgs) {
      expect(img.location).toMatch(/^file:\/\/\/C:\/fake\/image\d+\.\w+$/);
      expect(img.body.length).toBeGreaterThan(0);
    }
  });
  test("qpDecodeBytes: =XX 转义与软换行", () => {
    expect(new TextDecoder().decode(qpDecodeBytes(new TextEncoder().encode("12=3D34")))).toBe("12=34");
    expect(new TextDecoder().decode(qpDecodeBytes(new TextEncoder().encode("ab=\r\ncd")))).toBe("abcd");
    expect(new TextDecoder().decode(qpDecodeBytes(new TextEncoder().encode("a=\nb")))).toBe("ab");
  });
});
