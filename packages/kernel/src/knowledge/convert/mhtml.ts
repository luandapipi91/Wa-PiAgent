/**
 * MHTML（.mht）解析器——字节级处理
 *
 * 背景：altChunk docx（腾讯文档导出）的正文在 word/*.mht 的 MHTML 里，
 * text/html part 为正文、image part（base64）为图片，按 Content-Location 对应。
 *
 * 关键约束：禁止先对整个 MHT 做 utf-8 解码再扫字符——非 ASCII 字节（正文中文、
 * 图片二进制）会损坏，必须全程字节级扫描；仅在 header 区块上用 latin1 解码做
 * regex 提取（Content-Type / Content-Location / Content-Transfer-Encoding）。
 * header/body 分隔优先 \r\n\r\n，退回 \n\n（腾讯文档导出的 MHT 用 \n）；
 * base64 part 的 body 尾部可能有 boundary 关闭标记 -- 残留，解码前需清理。
 */

/** 单个 MHT part：内容类型、Content-Location、原始字节 body（已按 CTE 解码） */
export interface MhtPart {
  contentType: string;
  location: string;
  body: Uint8Array;
}

function bytesIndexOf(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

// 字节级 quoted-printable 解码：=XX → 字节，"=\r\n"/"=\n" 软换行删除
export function qpDecodeBytes(body: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const b = body[i];
    if (b === 0x3d /* = */) {
      if (body[i + 1] === 0x0d && body[i + 2] === 0x0a) { i += 2; continue; }
      if (body[i + 1] === 0x0a) { i += 1; continue; }
      const h1 = String.fromCharCode(body[i + 1]), h2 = String.fromCharCode(body[i + 2]);
      if (/^[0-9A-Fa-f]$/.test(h1) && /^[0-9A-Fa-f]$/.test(h2)) { out.push(parseInt(h1 + h2, 16)); i += 2; continue; }
    }
    out.push(b);
  }
  return new Uint8Array(out);
}

// base64 文本（含换行）→ 字节
export function base64DecodeBytes(text: string): Uint8Array {
  const bin = atob(text.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// 解析 MHTML 的全部 part（字节级，避免非 ASCII 损坏）
export function parseMhtParts(mht: Uint8Array): MhtPart[] {
  const enc = new TextEncoder();
  const dec = new TextDecoder("latin1");
  const bm = dec.decode(mht).match(/boundary="([^"]+)"/);
  if (!bm) throw new Error("MHT 头无 boundary");
  const boundary = enc.encode("--" + bm[1]);
  const CRLFCRLF = enc.encode("\r\n\r\n");
  const LFLF = enc.encode("\n\n");
  const parts: MhtPart[] = [];

  let pos = 0;
  while (true) {
    const start = bytesIndexOf(mht, boundary, pos);
    if (start < 0) break;
    // header 与 body 分隔：优先 \r\n\r\n，退回 \n\n（腾讯文档导出的 MHT 用 \n）
    const crlf = bytesIndexOf(mht, CRLFCRLF, start);
    const sepLen = crlf >= 0 ? 4 : 2;
    const sepAt = crlf >= 0 ? crlf : bytesIndexOf(mht, LFLF, start);
    if (sepAt < 0) { pos = start + 1; continue; }
    const next = bytesIndexOf(mht, boundary, sepAt);
    const header = dec.decode(mht.slice(start, sepAt));
    const rawBody = mht.slice(sepAt + sepLen, next >= 0 ? next : mht.length);

    const type = header.match(/Content-Type:\s*([\w/+.-]+)/i)?.[1] ?? "";
    const location = header.match(/Content-Location:\s*(\S+)/i)?.[1] ?? "";
    const cte = header.match(/Content-Transfer-Encoding:\s*(\w+)/i)?.[1]?.toLowerCase() ?? "";

    let body: Uint8Array;
    if (cte === "base64") {
      // base64 body 尾部可能残留 boundary 关闭标记 --，解码前清理
      const tail = dec.decode(rawBody).replace(/--[^\S\r\n]*$/, "").trimEnd();
      body = base64DecodeBytes(tail);
    } else {
      body = qpDecodeBytes(rawBody);
    }
    if (type || location) parts.push({ contentType: type, location, body });
    if (next < 0) break;
    pos = next;
  }
  return parts;
}
