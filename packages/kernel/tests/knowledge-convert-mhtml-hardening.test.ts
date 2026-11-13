/**
 * mhtml.ts 加固测试（任务 3 审查项 I1 / M1 / M2）
 *
 * I1：header/body 分隔点搜索必须限定在当前 part 边界内——
 *    body 内裸 \r\n\r\n 不得把分隔点拽进 body 中间导致 body 截断；
 * M1：base64 part 尾部 boundary 残留（-- 与 \n 任意组合形态）须字节级清理；
 *    单个 part 解码失败降级为告警跳过，不得崩掉整个解析；
 * M2：Content-Transfer-Encoding 值须完整捕获（[\w-]+，quoted-printable 完整），
 *    base-64 变体写法也应走 base64 解码分支。
 */
import { describe, test, expect } from "bun:test";
import { parseMhtParts, base64DecodeBytes } from "../src/knowledge/convert/mhtml";

// 构造 MHT 字节：头部声明 boundary，parts 以 \n 行分隔（腾讯文档导出风格）
function buildMht(partsBody: string[]): Uint8Array {
  const head = 'MIME-Version: 1.0\nContent-Type: multipart/related;\n    boundary="----=mhtTestPart"\n\n';
  return new TextEncoder().encode(head + partsBody.join("\n") + "\n");
}

// 70 字节 1x1 png 的 base64 文本
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("mhtml 加固", () => {
  test("I1: part body 内裸 \\r\\n\\r\\n 不截断当前 part", () => {
    const mht = buildMht([
      "------=mhtTestPart",
      "Content-Type: text/html",
      "Content-Location: file:///C:/fake/doc.html",
      "",
      "<html>第一段\r\n\r\n第二段",
      "",
      "------=mhtTestPart",
      "Content-Type: image/png",
      "Content-Location: file:///C:/fake/image1.png",
      "",
      "aGVsbG8=",
      "",
      "------=mhtTestPart--",
    ]);
    const parts = parseMhtParts(mht);
    const html = parts.find((p) => p.contentType.startsWith("text/html"))!;
    expect(html.location).toBe("file:///C:/fake/doc.html");
    // body 必须完整：裸 \r\n\r\n 前后内容都在（qp 解码保真）
    const text = new TextDecoder().decode(html.body);
    expect(text).toContain("<html>第一段");
    expect(text).toContain("第二段");
  });

  test("M1: base64 尾部 -- 与 \\n 组合残留不破坏解码", () => {
    const mht = buildMht([
      "------=mhtTestPart",
      "Content-Type: image/png",
      "Content-Transfer-Encoding: base64",
      "Content-Location: file:///C:/fake/image1.png",
      "",
      `${PNG_B64}\n--\n--`,
      "",
      "------=mhtTestPart--",
    ]);
    const parts = parseMhtParts(mht);
    const img = parts.find((p) => p.contentType.startsWith("image/"))!;
    // 尾部残留清理后解码结果必须与干净 base64 完全一致
    expect(img.body).toEqual(base64DecodeBytes(PNG_B64));
  });

  test("M1: 单个 part 解码失败降级告警跳过, 不崩解析", () => {
    const warnings: string[] = [];
    const mht = buildMht([
      "------=mhtTestPart",
      "Content-Type: image/png",
      "Content-Transfer-Encoding: base64",
      "Content-Location: file:///C:/fake/image1.png",
      "",
      "QU@JDRA==", // 中间含非法字符，atob 必抛
      "",
      "------=mhtTestPart",
      "Content-Type: image/png",
      "Content-Transfer-Encoding: base64",
      "Content-Location: file:///C:/fake/image2.png",
      "",
      PNG_B64,
      "",
      "------=mhtTestPart--",
    ]);
    const parts = parseMhtParts(mht, warnings);
    // 非法 part 被跳过，正常 part 保留
    expect(parts.length).toBe(1);
    expect(parts[0].location).toContain("image2");
    expect(warnings.some((w) => w.includes("解码失败"))).toBe(true);
  });

  test("M2: base-64 变体 CTE 完整捕获并走 base64 解码", () => {
    const mht = buildMht([
      "------=mhtTestPart",
      "Content-Type: image/png",
      "Content-Transfer-Encoding: base-64",
      "Content-Location: file:///C:/fake/image1.png",
      "",
      PNG_B64,
      "",
      "------=mhtTestPart--",
    ]);
    const parts = parseMhtParts(mht);
    const img = parts.find((p) => p.contentType.startsWith("image/"))!;
    // base-64 不得被误走 qp 分支导致字节错乱
    expect(img.body).toEqual(base64DecodeBytes(PNG_B64));
  });
});
