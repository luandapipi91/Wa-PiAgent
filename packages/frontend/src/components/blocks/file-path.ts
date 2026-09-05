export interface ParsedFilePath {
 path: string;
 line?: number;
 col?: number;
}

const PATH_RE =
 /^((?:[a-zA-Z]:[\\/][^\s:]+|(?:~|\.{1,2})?\/[^\s:]+|[\w@+.-]+(?:\/[\w@+.-]+)+))(?::(\d+))?(?::(\d+))?$/;

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
 return {
  path: p,
  line: m[2] ? Number(m[2]) : undefined,
  col: m[3] ? Number(m[3]) : undefined,
 };
}

// 图片/视频扩展名：路径芯片（FilePill）点击分发到媒体画廊用
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
const VIDEO_EXT_RE = /\.(mp4|webm|mov|mkv|avi|m4v)$/i;

/** 按扩展名判断媒体类型；非媒体返回 null。入参为 parseFilePath 的 path（已去行号/无 query） */
export function mediaKindOf(path: string): "image" | "video" | null {
 if (IMAGE_EXT_RE.test(path)) return "image";
 if (VIDEO_EXT_RE.test(path)) return "video";
 return null;
}
