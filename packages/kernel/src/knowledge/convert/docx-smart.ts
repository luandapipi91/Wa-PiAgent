/**
 * docx 智能转换（双通道）+ 图片真实字节落盘
 *
 * 背景：@ryangarber/markitdown-ts 的 turndown "img tags" 规则会把所有 data URI 图片
 * 截断为 "data:image/xxx;base64..." 占位符（库刻意移除图片功能），因此图片字节必须
 * 由本模块直接提取并写盘，md 中改写为相对路径外联引用。
 *
 * 两条通道：
 * 1. altChunk docx（腾讯文档导出）：正文在 word/*.mht 的 MHTML 里，
 *    text/html part 为正文、image part（base64）为图片，按 Content-Location 对应；
 *    图片按 Content-Location 落盘、html 中的 src 改写为外联相对路径后走库的 html 通道。
 * 2. 普通 docx：库转换产出的占位符按文档顺序与 document.xml 的 r:embed 引用一一对应，
 *    图片字节从 zip 内 word/media/ 按 rels 映射提取，按序落盘替换。
 *
 * 非致命问题记入 warnings（不中断转换）：源文件 0 字节损坏图（不落盘、引用置空、
 * 序号照常推进）、占位符与实际图片数量不齐、MHT 单个 part 解码失败（跳过该 part）。
 */
import { MarkItDown } from "@ryangarber/markitdown-ts";
import { unzipSync } from "fflate";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseMhtParts } from "./mhtml";
import type { ConvertResult, ImageSink } from "./types";

// 库产出的图片占位符形态（库刻意把 data URI 截断为 base64... 假串）
const PLACEHOLDER_RE = /!\[([^\]]*)\]\(data:image\/[\w.+-]+;base64\.\.\.\)/g;

const mdConverter = new MarkItDown();

function saveImage(sink: ImageSink, idx: number, ext: string, bytes: Uint8Array): string {
  mkdirSync(sink.dirAbs, { recursive: true });
  const p = join(sink.dirAbs, `img${idx}.${ext}`);
  writeFileSync(p, bytes);
  return p;
}

// altChunk docx → html：MHT 图片按 Content-Location 落盘，html 中的 src 改写为外联相对路径
function convertAltChunkDocx(
  docxBytes: Uint8Array,
  sink: ImageSink,
  warnings: string[]
): { html: string; images: string[] } {
  const zip = unzipSync(docxBytes);
  const mhtName = Object.keys(zip).find((n) => n.endsWith(".mht"));
  if (!mhtName) throw new Error("zip 内无 .mht 附件");

  // 单个 part 解码失败由 parseMhtParts 降级为 warning 跳过
  const parts = parseMhtParts(zip[mhtName], warnings);
  const htmlPart = parts.find((p) => /^text\/html/i.test(p.contentType));
  if (!htmlPart) throw new Error("MHT 无 text/html part");
  let html = new TextDecoder("utf-8").decode(htmlPart.body);

  const images: string[] = [];
  let idx = 0;
  for (const p of parts) {
    if (!/^image\//i.test(p.contentType) || !p.location) continue;
    idx++;
    const ext = p.location.split(".").pop()?.toLowerCase() || "png";
    images.push(saveImage(sink, idx, ext, p.body));
    // src 改写为外联相对路径（非 data: 开头，不会被库截断）
    html = html.split(p.location).join(`${sink.relPrefix}/img${idx}.${ext}`);
  }

  return { html, images };
}

// 普通 docx：按 document.xml 中 r:embed 出现顺序提取 word/media/ 图片字节
function extractDocxImagesInOrder(docxBytes: Uint8Array): { bytes: Uint8Array; ext: string }[] {
  const zip = unzipSync(docxBytes);
  const docXml = new TextDecoder("utf-8").decode(zip["word/document.xml"]);
  const relsXml = zip["word/_rels/document.xml.rels"]
    ? new TextDecoder("utf-8").decode(zip["word/_rels/document.xml.rels"])
    : "";
  // rId → media 目标
  const relMap = new Map<string, string>();
  for (const m of relsXml.matchAll(/Id="(rId\d+)"[^>]*Target="([^"]+)"/g)) {
    relMap.set(m[1], m[2]);
  }
  const out: { bytes: Uint8Array; ext: string }[] = [];
  for (const m of docXml.matchAll(/r:embed="(rId\d+)"/g)) {
    const target = relMap.get(m[1]);
    if (!target) continue;
    // rels Target 以 / 开头为包内绝对路径（如 /word/media/a.png），否则相对 word/（与 mammoth 的 uriToZipEntryName 一致）
    const path = target.startsWith("/") ? target.slice(1) : "word/" + target;
    const bytes = zip[path];
    if (!bytes) continue;
    const ext = (target.split(".").pop() || "png").toLowerCase();
    out.push({ bytes, ext });
  }
  return out;
}

/**
 * docx 智能转换入口：自动判定 altChunk（腾讯文档导出）与普通 docx，双通道转换，
 * 图片真实字节落盘为 imgN.<ext>，md 中按序改写为 ${sink.relPrefix}/imgN.<ext> 外联引用。
 */
export async function convertDocxSmart(srcAbs: string, sink: ImageSink): Promise<ConvertResult> {
  const bytes = readFileSync(srcAbs);
  const zip = unzipSync(bytes);
  const docXml = new TextDecoder("utf-8").decode(zip["word/document.xml"]);
  const images: string[] = [];
  const warnings: string[] = [];

  // 通道判定：document.xml 含 altChunk 且 zip 内带 .mht → MHT 补偿通道
  if (docXml.includes("altChunk") && Object.keys(zip).some((n) => n.endsWith(".mht"))) {
    const { html, images: imgs } = convertAltChunkDocx(bytes, sink, warnings);
    images.push(...imgs);
    const r = await mdConverter.convert(new File([new TextEncoder().encode(html)], "embedded.html"), {});
    return { markdown: r?.markdown ?? "", via: "altChunk(mht→html)", images, warnings };
  }

  // 普通 docx：库转换产出占位符，按序替换为外联引用，图片真实字节落盘
  const r = await mdConverter.convert(new File([bytes], srcAbs), {});
  let markdown = r?.markdown ?? "";

  const ordered = extractDocxImagesInOrder(bytes);
  let idx = 0;
  let unmatched = 0;
  let emptySkipped = 0;
  markdown = markdown.replace(PLACEHOLDER_RE, (_full, alt: string) => {
    const img = ordered[idx++];
    if (!img) {
      // 占位符多于实际图片：引用置空（序号已推进，不回补后续图）
      unmatched++;
      return `![${alt}]()`;
    }
    // 源文件里就存在的 0 字节损坏图：不落盘、引用置空并告警（序号照常推进）
    if (img.bytes.length === 0) {
      emptySkipped++;
      warnings.push(`源文件 0 字节损坏图: ${srcAbs.split("/").pop()} 第${idx}张，引用置空`);
      return `![${alt}]()`;
    }
    images.push(saveImage(sink, idx, img.ext, img.bytes));
    return `![${alt}](${sink.relPrefix}/img${idx}.${img.ext})`;
  });
  if (unmatched > 0 || ordered.length > idx) {
    warnings.push(`图片数量不齐: ${srcAbs.split("/").pop()}: 占位符=${idx + unmatched} 实际图片=${ordered.length}`);
  }
  if (emptySkipped > 0) {
    warnings.push(`${srcAbs.split("/").pop()}: 共跳过 ${emptySkipped} 张 0 字节损坏图`);
  }
  return { markdown, via: "docx(mammoth)", images, warnings };
}
