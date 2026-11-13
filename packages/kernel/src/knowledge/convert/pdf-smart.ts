/**
 * pdf 智能转换（双路径）：文本层优先 + 内嵌图片提取
 *
 * 背景：unpdf 只抽文本层；扫描件无文本层时输出为空。
 *
 * 两条路径：
 * 1. 有文本层：extractPdfText（unpdf）抽出的文本非空，直接作为 markdown 返回；
 * 2. 无文本层（扫描件）：正则切 PDF 字节流里的 /Subtype /Image 对象，
 *    FlateDecode 流 inflateSync 解压后按 ColorSpace 转 RGBA，jpeg-js 重编码为
 *    jpeg data URI，按「## 第 N 页」段落组织；DCTDecode 流即 jpeg 原字节。
 *
 * 单个图片流不可解码/不支持（非 Flate·DCT filter、非 RGB/Gray 色彩空间、非 8bpc）
 * 记 warnings 跳过，不中断转换。扫描件产物为 data URI，外联化由任务 5 编排层统一
 * 处理，本函数不落盘（images 恒为空，sink 参数留作编排层接口一致性）。
 */
import { inflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import jpeg from "jpeg-js";
import { extractPdfText } from "../extract";
import type { ConvertResult, ImageSink } from "./types";

/** 字节级正则切出的内嵌图片对象（未解码） */
interface RawImage {
  width: number;
  height: number;
  filter: string; // FlateDecode / DCTDecode / ...
  colorSpace: string; // DeviceRGB / DeviceGray / ...
  bpc: number; // BitsPerComponent
  stream: Uint8Array; // 未解码的流字节（按 /Length 直接量切割）
}

/** latin1 无损字符串：PDF 二进制当字符串正则匹配，按 /Length 直接量切回字节零失真 */
function parseEmbeddedImages(pdfBytes: Uint8Array): RawImage[] {
  const latin = Buffer.from(pdfBytes).toString("latin1");
  const re = /<<([^<>]*?\/Subtype\s*\/Image[^<>]*?)>>[ \t\r\n]*stream/g;
  const images: RawImage[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(latin))) {
    const dict = m[1];
    const width = parseInt(dict.match(/\/Width\s+(\d+)/)?.[1] ?? "0");
    const height = parseInt(dict.match(/\/Height\s+(\d+)/)?.[1] ?? "0");
    const filter = dict.match(/\/Filter\s*\/(\w+)/)?.[1] ?? "";
    const colorSpace = dict.match(/\/ColorSpace\s*\/(\w+)/)?.[1] ?? "";
    const bpc = parseInt(dict.match(/\/BitsPerComponent\s+(\d+)/)?.[1] ?? "8");
    const lenM = dict.match(/\/Length\s+(\d+)/);
    if (!width || !height || !lenM) continue; // 间接 /Length 引用：扫描件场景不出现，跳过
    let start = m.index + m[0].length;
    if (latin[start] === "\r") start++;
    if (latin[start] === "\n") start++;
    const stream = Buffer.from(latin.slice(start, start + parseInt(lenM[1])), "latin1");
    images.push({ width, height, filter, colorSpace, bpc, stream });
  }
  return images;
}

/** 单张图片字节 → jpeg；不支持/解不开返回 null（由调用方记 warning 跳过），inflate 抛错上抛 */
function imageToJpeg(img: RawImage): Buffer | null {
  if (img.filter === "DCTDecode") return Buffer.from(img.stream); // 流本身即 jpeg
  if (img.filter !== "FlateDecode") return null;
  if (img.bpc !== 8) return null;
  if (img.colorSpace !== "DeviceRGB" && img.colorSpace !== "DeviceGray") return null;
  const rgb = inflateSync(img.stream);
  const px = img.width * img.height;
  const expected = img.colorSpace === "DeviceGray" ? px * 1 : px * 3;
  if (rgb.length < expected) return null;
  const rgba = Buffer.alloc(px * 4);
  if (img.colorSpace === "DeviceGray") {
    for (let i = 0; i < px; i++) {
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = rgb[i];
      rgba[i * 4 + 3] = 255;
    }
  } else {
    for (let i = 0; i < px; i++) {
      rgba[i * 4] = rgb[i * 3];
      rgba[i * 4 + 1] = rgb[i * 3 + 1];
      rgba[i * 4 + 2] = rgb[i * 3 + 2];
      rgba[i * 4 + 3] = 255;
    }
  }
  return Buffer.from(jpeg.encode({ data: rgba, width: img.width, height: img.height }, 85).data);
}

/** pdf 双路径转换：文本层非空直接返回；空文本走内嵌图片提取 */
export async function convertPdfSmart(srcAbs: string, sink: ImageSink): Promise<ConvertResult> {
  void sink; // 扫描件产物为 data URI 不落盘；参数留作任务 5 编排层的接口一致性
  const warnings: string[] = [];

  // 路径 1：文本层优先（unpdf；损坏结构由此抛 ExtractionError，调用方处理）
  const { text } = await extractPdfText(srcAbs);
  if (text.trim().length > 0) {
    return { markdown: text, images: [], via: "pdf(unpdf)", warnings };
  }

  // 路径 2：无文本层 → 内嵌图片逐页提取为 jpeg data URI
  const bytes = readFileSync(srcAbs);
  const images = parseEmbeddedImages(new Uint8Array(bytes));
  const title = basename(srcAbs).replace(/\.[^.]+$/, "");
  const sections: string[] = [];
  let page = 0;
  for (const [i, img] of images.entries()) {
    try {
      const jpg = imageToJpeg(img);
      if (!jpg) {
        warnings.push(
          `第 ${i + 1} 个图片流不支持 ${img.filter || "未知 filter"} / ${img.colorSpace || "未知色彩空间"} / ${img.bpc}bpc，已跳过`,
        );
        continue;
      }
      page++;
      sections.push(
        `## 第 ${page} 页\n\n![${title}-第${page}页](data:image/jpeg;base64,${jpg.toString("base64")})`,
      );
    } catch {
      warnings.push(`第 ${i + 1} 个图片流不可解码（inflate 失败），已跳过`);
    }
  }
  if (images.length > 0 && page === 0) {
    warnings.push("PDF 无文本层且未提取到可解码的内嵌图片");
  }
  return { markdown: sections.join("\n\n"), images: [], via: "pdf(内嵌图片提取)", warnings };
}
