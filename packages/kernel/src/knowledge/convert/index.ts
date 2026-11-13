/**
 * 知识库转换编排器：格式分发 + mirror 落盘 + 降级信号
 *
 * convertToMirror 是 indexer 的唯一入口：按扩展名分发到各转换通道，
 * 产物 md 统一落盘到 join(mirrorDir, srcRel + ".md")，图片落
 * _assets/<srcRel>/，md 中以相对路径引用。任何通道抛错（转换失败、
 * 源文件不存在、复制失败）一律收敛为 { ok:false, reason }——
 * indexer 靠 ok:false 做降级索引（原文直读），绝不向上泄漏异常。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import TurndownService from "turndown";
import { convertDocxSmart } from "./docx-smart";
import { convertPdfSmart } from "./pdf-smart";
import { externalizeImages, relativeRef } from "./inline-images";
import type { ImageSink } from "./types";

/** 转换器版本：改动转换语义时递增，indexer 据此判断 mirror 是否需要重转 */
export const CONVERTER_VERSION = 1;

/** 编排成功结果 */
export interface ConvertOutcome {
  ok: true;
  mdPath: string; // mirror 产物 md 绝对路径
  images: string[]; // 实际落盘的图片绝对路径列表
  via: string; // 转换通道标识（透传自各通道）
  warnings: string[]; // 非致命告警（透传自各通道）
  converterVersion: number;
}

/** 编排失败（降级信号）：reason 为异常消息或 "unsupported" */
export interface ConvertFailure {
  ok: false;
  reason: string;
}

// 分发集合：扩展名 → 处理通道；集合外一律 unsupported
const DOCX_EXTS = new Set([".docx"]);
const PDF_EXTS = new Set([".pdf"]);
const HTML_EXTS = new Set([".html", ".htm"]);
const PASSTHROUGH_EXTS = new Set([".txt", ".md"]);

// html/htm → markdown 库转换（atx 标题 + fenced 代码块，与 web-access 侧配置一致）
const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

/**
 * 把单个源文件转换为 mirror 副本。
 *
 * @param srcAbs    源文件绝对路径
 * @param srcRel    源文件相对知识库根的路径（含扩展名，决定 md/assets 落盘位置）
 * @param mirrorDir mirror 根目录（md 落 <mirrorDir>/<srcRel>.md，图落 <mirrorDir>/_assets/<srcRel>/）
 * @returns 成功给 ConvertOutcome，失败给 ConvertFailure；任何异常不外漏
 */
export async function convertToMirror(
  srcAbs: string,
  srcRel: string,
  mirrorDir: string
): Promise<ConvertOutcome | ConvertFailure> {
  const ext = extname(srcAbs).toLowerCase();
  const isPassthrough = PASSTHROUGH_EXTS.has(ext);
  const isDocx = DOCX_EXTS.has(ext);
  const isPdf = PDF_EXTS.has(ext);
  const isHtml = HTML_EXTS.has(ext);
  if (!isPassthrough && !isDocx && !isPdf && !isHtml) {
    return { ok: false, reason: "unsupported" };
  }

  try {
    const mdPath = join(mirrorDir, srcRel + ".md");
    const assetsRoot = join(mirrorDir, "_assets");
    const assetsDir = join(assetsRoot, srcRel);
    // 通道 sink：图片落盘目录 + md 中的相对引用前缀（与 externalizeImages 内部
    // 引用形态同源，均走 relativeRef，保证两条产引路径不漂移）
    const sink: ImageSink = { dirAbs: assetsDir, relPrefix: relativeRef(mdPath, assetsDir) };

    let markdown: string;
    let via: string;
    let images: string[];
    let warnings: string[];

    if (isPassthrough) {
      // txt/md：直通，不解析，原文即正文（由末尾统一写盘）
      markdown = readFileSync(srcAbs, "utf8");
      via = "passthrough";
      images = [];
      warnings = [];
    } else if (isDocx) {
      // docx：产物已外联化（图片已按 sink 落盘），直接写盘
      const r = await convertDocxSmart(srcAbs, sink);
      markdown = r.markdown;
      via = r.via;
      images = r.images;
      warnings = r.warnings;
    } else {
      // pdf / html：产物为 data URI 内联图片，先过 externalizeImages 外联化再写盘
      let raw: string;
      if (isPdf) {
        const r = await convertPdfSmart(srcAbs, sink);
        raw = r.markdown;
        via = r.via;
        warnings = r.warnings;
      } else {
        raw = turndown.turndown(readFileSync(srcAbs, "utf8"));
        via = "html(turndown)";
        warnings = [];
      }
      const ex = externalizeImages(raw, mdPath, srcRel, assetsRoot);
      markdown = ex.markdown;
      images = ex.images;
    }

    // md 落盘（recursive 建出 <mirrorDir>/<srcRel 的中间目录>）
    mkdirSync(dirname(mdPath), { recursive: true });
    writeFileSync(mdPath, markdown);

    return { ok: true, mdPath, images, via, warnings, converterVersion: CONVERTER_VERSION };
  } catch (e) {
    // 降级信号：任何异常（转换抛错 / 源文件不存在 / 复制失败）都收敛为 ok:false
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
