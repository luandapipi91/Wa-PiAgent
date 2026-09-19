// 从 amaster-memory.ts 迁入（该文件本批删除）

/** 按 cwd 生成项目目录名（basename；与历史 projects-memory/<basename> 约定对齐）。
 *  净化 Windows 非法文件名字符（如盘根 cwd `H:` 的冒号），避免 mkdir 失败。 */
export function projectNameFromCwd(cwd: string): string {
  const parts = cwd.replace(/\\/g, "/").replace(/\/$/, "").split("/");
  const raw = (parts[parts.length - 1] || "default")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .trim();
  return raw || "default";
}
