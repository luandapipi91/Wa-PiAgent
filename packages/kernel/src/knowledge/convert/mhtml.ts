/**
 * MHTML（.mht）解析器——字节级处理
 *
 * 背景：altChunk docx（腾讯文档导出）的正文在 word/*.mht 的 MHTML 里，
 * text/html part 为正文、image part（base64）为图片，按 Content-Location 对应。
 *
 * 关键约束：禁止先对整个 MHT 做 utf-8 解码再扫字符——非 ASCII 字节（正文中文、
 * 图片二进制）会损坏，必须全程字节级扫描；仅在 header 区块上用 latin1 解码做
 * regex 提取（Content-Type / Content-Location / Content-Transfer-Encoding）。
 * header/body 分隔取当前 part 边界内先出现的分隔形态（\r\n\r\n 或 \n\n，腾讯文档
 * 导出的 MHT 用 \n）；base64 part 的 body 尾部可能有 boundary 关闭标记残留
 * （--、\n 等组合形态），解码前须字节级剥离；单个 part 解码失败降级为告警跳过。
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

// M1 加固：base64 尾部 boundary 残留（--、\n、\r 等任意组合）字节级剥离——
// 从尾部向前跳过所有非法 base64 字符，停在最后一个合法 base64 字符处截断
function trimBase64Tail(raw: Uint8Array): string {
  const isB64 = (b: number) =>
    (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || (b >= 0x30 && b <= 0x39) || b === 0x2b /* + */ || b === 0x2f /* / */ || b === 0x3d /* = */;
  let end = raw.length;
  while (end > 0 && !isB64(raw[end - 1])) end--;
  return new TextDecoder("latin1").decode(raw.slice(0, end));
}

// 解析 MHTML 的全部 part（字节级，避免非 ASCII 损坏）；
// warnings 可选：传入时收集非致命告警（如单个 part 解码失败被跳过）
export function parseMhtParts(mht: Uint8Array, warnings?: string[]): MhtPart[] {
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
    // I1 加固：先锁定当前 part 的结束 boundary（下一个 boundary），
    // 分隔符只在 [start, limit) 内搜，防 body 内裸 \r\n\r\n 把分隔点拽进 body 或下一个 part
    const next = bytesIndexOf(mht, boundary, start + 1);
    const limit = next >= 0 ? next : mht.length;
    const crlf = bytesIndexOf(mht, CRLFCRLF, start);
    const lf = bytesIndexOf(mht, LFLF, start);
    const crlfOk = crlf >= 0 && crlf < limit;
    const lfOk = lf >= 0 && lf < limit;
    // 取当前 part 界内先出现的分隔形态（腾讯导出用 \n\n，标准 MHT 用 \r\n\r\n，混用时以先出现者为准）
    let sepAt = -1;
    let sepLen = 0;
    if (crlfOk && (!lfOk || crlf <= lf)) { sepAt = crlf; sepLen = 4; }
    else if (lfOk) { sepAt = lf; sepLen = 2; }
    if (sepAt < 0) { pos = start + 1; continue; }
    const header = dec.decode(mht.slice(start, sepAt));
    const rawBody = mht.slice(sepAt + sepLen, limit);

    const type = header.match(/Content-Type:\s*([\w/+.-]+)/i)?.[1] ?? "";
    const location = header.match(/Content-Location:\s*(\S+)/i)?.[1] ?? "";
    // M2 加固：[\w-]+ 完整捕获 quoted-printable / base-64 等带连字符的 CTE 值
    const cte = header.match(/Content-Transfer-Encoding:\s*([\w-]+)/i)?.[1]?.toLowerCase() ?? "";

    let body: Uint8Array;
    if (cte.replace(/-/g, "") === "base64") {
      // M1 加固：字节级剥离尾部 boundary 残留；解码失败降级为告警并跳过该 part，不崩整个解析
      try {
        body = base64DecodeBytes(trimBase64Tail(rawBody));
      } catch {
        const msg = `MHT base64 part 解码失败已跳过: ${location || type || "未知"}`;
        if (warnings) warnings.push(msg);
        else console.warn(`[WARN] ${msg}`);
        if (next < 0) break;
        pos = next;
        continue;
      }
    } else {
      body = qpDecodeBytes(rawBody);
    }
    if (type || location) parts.push({ contentType: type, location, body });
    if (next < 0) break;
    pos = next;
  }
  return parts;
}
