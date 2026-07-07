// 目录选择已改为前端树选择器（DirTreePicker），本文件仅保留 basename 工具函数。

/** 取路径的 basename 作项目名（/Users/x/work/my-app → my-app） */
export function basename(path: string): string {
  // 处理尾部斜杠
  const clean = path.replace(/[\\/]+$/, "");
  const idx = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  return clean.slice(idx + 1) || clean;
}
