export interface ParsedFilePath { path: string; line?: number; col?: number; }

const PATH_RE = /^((?:[a-zA-Z]:[\\/][^\s:]+|(?:~|\.{1,2})?\/[^\s:]+|[\w@+.-]+(?:\/[\w@+.-]+)+))(?::(\d+))?(?::(\d+))?$/;

/**
 * 保守识别文件路径：必须含 "/" 且末段带扩展名（1-10 字符），可选 :行:列 后缀。
 * 支持 Windows 盘符绝对路径（C:/、C:\，反斜杠归一化为正斜杠）。
 * 无斜杠的裸文件名（README.md）与 URL 不识别，避免误伤普通行内代码。
 */
export function parseFilePath(text: string): ParsedFilePath | null {
  const t = text.trim();
  if (t.length < 3 || t.length > 300 || t.includes("://")) return null;
  const m = PATH_RE.exec(t);
  if (!m) return null;
  const p = m[1].replace(/\\/g, "/");
  const last = p.split("/").pop() ?? "";
  if (!/\.[A-Za-z0-9]{1,10}$/.test(last)) return null;
  return { path: p, line: m[2] ? Number(m[2]) : undefined, col: m[3] ? Number(m[3]) : undefined };
}
