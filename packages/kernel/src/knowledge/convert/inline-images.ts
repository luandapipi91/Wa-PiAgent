/**
 * markdown 图片外联化：把正文里的 data URI 内联图片抽取为独立文件，
 * 按源文件相对路径镜像落到 assets 目录（<assetsRoot>/<srcRel>/imgN.<ext>），
 * md 中改写为相对路径引用（整段 encodeURI，空格→%20、中文→%XX，引用内不含空格）。
 *
 * 注意：抽不出字节的形态（如被库截断的 data:image/x;base64... 占位符）不在此处理，
 * 那是 docx-smart 占位符替换与编排层告警的职责。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const DATA_URI_RE = /!\[([^\]]*)\]\(data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)\)/g;

/** mime → 扩展名：jpg 规范化为 jpeg，svg+xml 规范化为 svg，其余取子类型 */
function extOf(mime: string): string {
  const sub = mime.slice("image/".length).toLowerCase();
  if (sub === "jpg") return "jpeg";
  if (sub === "svg+xml") return "svg";
  return sub;
}

/**
 * @param markdown   转换产出的 markdown（图片为 data URI）
 * @param mdOutPath  该 md 的最终落盘路径（用于计算相对引用）
 * @param srcRel     源文件相对路径（含扩展名，保证同名不同格的图片目录不冲突）
 * @param assetsRoot 资产落盘目录根（与 output 目录平级）
 * @returns 外联化后的 markdown + 实际落盘的图片文件路径列表
 */
export function externalizeImages(
  markdown: string,
  mdOutPath: string,
  srcRel: string,
  assetsRoot: string
): { markdown: string; images: string[] } {
  const written: string[] = [];
  const out = markdown.replace(DATA_URI_RE, (_full, alt: string, mime: string, b64: string) => {
    const idx = written.length + 1; // 同一次调用内 imgN 序号从 1 递增
    const ext = extOf(mime);
    const imgDir = join(assetsRoot, srcRel);
    const imgPath = join(imgDir, `img${idx}.${ext}`);
    mkdirSync(imgDir, { recursive: true });
    writeFileSync(imgPath, Buffer.from(b64, "base64"));
    written.push(imgPath);
    // md 相对引用：/ 归一后整段 encodeURI，再显式转义 URL/markdown destination 结构字符
    // （# → %23 fragment 分隔符、? → %3F query 分隔符、( ) → %28 %29 防止 destination 被裸括号截断）
    const ref = encodeURI(relative(dirname(mdOutPath), imgPath).split("\\").join("/"))
      .replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/#/g, "%23").replace(/\?/g, "%3F");
    return `![${alt}](${ref})`;
  });
  return { markdown: out, images: written };
}
