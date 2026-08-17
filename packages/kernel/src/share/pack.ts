import { createHash } from "node:crypto";
import { readFileSync, statSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { zipSync, strToU8 } from "fflate";

/** 排序后路径拼接 → sha256 hex 前 12 位（项目名后缀） */
export function hashPaths(paths: string[]): string {
  const joined = [...paths].sort().join("\n");
  return createHash("sha256").update(joined).digest("hex").slice(0, 12);
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** 多选路径（文件+文件夹）→ 扁平条目；文件夹递归展开，路径相对 root 保持 */
export function collectZipEntries(paths: string[], root: string): ZipEntry[] {
  const entries: ZipEntry[] = [];
  const walk = (p: string) => {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const name of readdirSync(p)) walk(join(p, name));
    } else {
      const rel = relative(root, p).split(sep).join("/");
      entries.push({ name: rel, data: new Uint8Array(readFileSync(p)) });
    }
  };
  for (const p of paths) walk(p);
  return entries;
}

/** 条目 → zip buffer（fflate） */
export function buildZip(paths: string[], root: string): Uint8Array {
  const entries = collectZipEntries(paths, root);
  const files: Record<string, Uint8Array> = {};
  for (const e of entries) files[e.name] = e.data;
  return zipSync(files);
}

export { strToU8 };
