// mirror 目录管理：markdown 副本与外联图片存放在【源文件夹】下的「知识库资源」目录
// （<folderPath>/知识库资源/，跟随源文件夹、对用户可见可管理），md 按源相对路径镜像
// （<资源目录>/<srcRel>.md），图片外联落 <资源目录>/_assets/<srcRel>/
// （与 convert/index.ts 编排器的落盘约定同源）。
// 该目录必须在扫描层整棵排除（scan.ts）：副本是派生中间产物，不得被当作源文件索引，
// 否则「写副本→watcher 感知→重索引→再写副本」会形成递归死循环。
import { readFileSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** 知识库资源目录名（源文件夹下，md 副本与外联图片都放这里） */
export const RESOURCE_DIR_NAME = "知识库资源";

/** mirror 根目录：<源文件夹>/知识库资源（跟随源文件夹，对用户可见可管理） */
export function mirrorDirFor(folderPath: string): string {
  return join(folderPath, RESOURCE_DIR_NAME);
}

/** 源文件对应的副本 md 路径：srcRel + ".md"（srcRel 为相对知识库根、含扩展名的路径） */
export function mirrorMdPath(mirrorDir: string, srcRel: string): string {
  return join(mirrorDir, srcRel + ".md");
}

/**
 * srcRel 安全守卫（最终审查 I-1）：绝对路径或含 .. 段一律拒绝。
 * srcRel 可能来自外部输入（knowledge_read filePath 候选直通 readMirrorMd），
 * 不设防时 join(mirrorDir, "../../x") 会读出/删除 mirror 目录外的文件。
 * 三个入口（readMirrorMd/isMirrorFresh/removeMirrorFile）统一拦截：
 * 读返回 null、新鲜度返回 false、删除静默跳过。
 */
function isUnsafeSrcRel(srcRel: string): boolean {
  if (isAbsolute(srcRel)) return true;
  return srcRel.split(/[\\/]+/).includes("..");
}

/**
 * 副本是否新鲜：源 mtime 与 size 双条件比对（§6.3 增量快筛语义）。
 * 副本不存在 → false；任一条件不符 → false（源更新过，需重转）。
 * srcRelWithoutExt 为去掉扩展名的源相对路径（副本 md = 该路径 + ".md"）。
 */
export function isMirrorFresh(
  mirrorDir: string,
  srcRelWithoutExt: string,
  srcMtimeMs: number,
  srcSize: number,
): boolean {
  if (isUnsafeSrcRel(srcRelWithoutExt)) return false;
  let st;
  try {
    st = statSync(mirrorMdPath(mirrorDir, srcRelWithoutExt));
  } catch {
    return false; // 副本不存在
  }
  return st.mtimeMs === srcMtimeMs && st.size === srcSize;
}

/**
 * 删除单个源文件的副本：md 与 _assets/<srcRel> 整目录一并清掉。
 * 两者不存在时幂等（force 删除，不抛错）。
 */
export function removeMirrorFile(mirrorDir: string, srcRel: string): void {
  if (isUnsafeSrcRel(srcRel)) return; // 静默跳过：外部 .. 段不得驱动递归删除
  rmSync(mirrorMdPath(mirrorDir, srcRel), { force: true });
  rmSync(join(mirrorDir, "_assets", srcRel), { recursive: true, force: true });
}

/** 读副本 md 全文；不存在返回 null（读取方据此走降级原文直读） */
export function readMirrorMd(mirrorDir: string, srcRel: string): string | null {
  if (isUnsafeSrcRel(srcRel)) return null; // 外部 .. 段/绝对路径不得读出 mirror 外文件
  try {
    return readFileSync(mirrorMdPath(mirrorDir, srcRel), "utf8");
  } catch {
    return null;
  }
}
