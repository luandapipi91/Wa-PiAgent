// 知识库扫描器：索引管线第一阶段「先数不写」的只读预览（规格 §6.3）。
// 三层过滤，优先级从高到低：
//   1. 用户显式排除（excludePaths，整棵子树剪掉，不记 skips——六类枚举无 user_excluded）
//      ⚠️ 当前未接线：产品层没有排除入口，preview/indexer/watcher 三处调用都省略该参数
//      （= 空数组）。实现保留完整，后续给 knowledge_bases 加 exclude_paths 列并透传 events 即可启用。
//   2. 建议排除（SUGGESTED_EXCLUDES ~40 条内置规则）——当前是固定规则，用户不可覆盖
//      （设计上的「确认后覆盖」尚未实现）
//   3. 技术跳过（不可覆盖）：>10MiB oversized → 前 512B 含 0x00 binary（docx/pdf 容器格式豁免）
//      → 读失败 unreadable/inaccessible
// 只读约束：不向源目录写任何文件；符号链接一律不跟随（防止逃出源目录边界）。
// 两版入口：scanFolder（同步 I/O，首建/预览等低频路径）与 scanFolderAsync（异步 I/O，
// 60s 轮询快照——不能阻塞事件循环）。两版共用同一个遍历器（walkScan）与同一套谓词，
// 差别只在注入的 fs 适配器，故结果逐项相等由结构保证，不靠人工同步两份代码。
import {
  readdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  type Dirent,
  type Stats,
} from "node:fs";
import { open as openAsync, readdir as readdirAsync, stat as statAsync } from "node:fs/promises";
import { join } from "node:path";

/** 单文件索引上限：10 MiB（规格硬性，不可绕过） */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** 二进制探测窗口：前 512 字节含 0x00 判二进制 */
const BINARY_SNIFF_BYTES = 512;

/**
 * 建议排除模式列表（内置 ~40 条量级，用户新建时可确认覆盖）。
 * 匹配语义：
 *   - 纯名称（无 *）：匹配 relPath 的任意一段（目录或文件名按段精确匹配）
 *   - 含 *：对文件名（basename）做通配，* 匹配任意字符（不跨段）
 */
export const SUGGESTED_EXCLUDES: readonly string[] = [
  // 依赖与构建产物目录
  "node_modules", "vendor", "dist", "build", "out", "target", "coverage",
  // 版本控制与缓存目录
  ".git", ".cache", "__pycache__", ".venv",
  // IDE 配置目录
  ".idea",
  // 密钥与凭据
  ".env", "*.pem", "*.key", "*.p12", "id_rsa*", "*secret*",
  // 依赖锁文件
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb",
  "Cargo.lock", "poetry.lock", "Pipfile.lock", "composer.lock",
  // 压缩包
  "*.zip", "*.tar", "*.gz", "*.rar", "*.7z",
  // 图片二进制
  "*.png", "*.jpg", "*.jpeg", "*.gif", "*.webp", "*.ico", "*.bmp",
  // 视频二进制
  "*.mp4", "*.mkv", "*.mov",
  // 音频二进制
  "*.mp3", "*.wav",
  // 字体二进制
  "*.woff", "*.woff2", "*.ttf",
  // 原生二进制与字节码（刻意不含 *.bin——big.bin 类文件走 oversized 判定）
  "*.exe", "*.dll", "*.so", "*.wasm", "*.pyc",
  // 数据库 / 系统 / 日志
  "*.sqlite", "*.db", ".DS_Store", "Thumbs.db", "*.log",
];

/** 模式的小写副本：NTFS/APFS 大小写不敏感，匹配时目标 relPath 也归一小写（见 matchSuggested） */
const SUGGESTED_EXCLUDES_LOWER = SUGGESTED_EXCLUDES.map(p => p.toLowerCase());

/** 可索引文件的类型分类（与 extractText / chunkDocument 的 type 参数对接） */
export type KbFileType = "md" | "txt" | "docx" | "pdf" | "html";

/** 六类跳过原因（枚举与 @wa-pi/shared KbScanPreview 逐字一致；extraction_failed 仅由抽取阶段产生，扫描不产出） */
export type KbSkipReason =
  | "suggested_excluded"
  | "oversized"
  | "binary"
  | "unreadable"
  | "inaccessible"
  | "extraction_failed";

/** 可索引文件条目 */
export interface ScannedFile {
  /** POSIX 风格相对路径（一律 / 分隔，跨平台稳定） */
  relPath: string;
  absPath: string;
  type: KbFileType;
  /** 字节数 */
  size: number;
  /** 修改时间（毫秒时间戳，增量快照对比用） */
  mtime: number;
}

/** 跳过条目（path 为 relPath） */
export interface ScanSkip {
  path: string;
  reason: KbSkipReason;
}

/** 扫描预览（后端内部形状；routes 层映射为 @wa-pi/shared KbScanPreview） */
export interface ScanPreview {
  indexable: ScannedFile[];
  skips: ScanSkip[];
}

/** 扩展名 → 类型映射；未识别扩展名/无扩展名按 txt 尝试（binary 探测兜底） */
const TYPE_BY_EXT: Record<string, KbFileType> = {
  ".md": "md",
  ".markdown": "md",
  ".mdx": "md",
  ".txt": "txt",
  ".docx": "docx",
  ".pdf": "pdf",
  ".html": "html",
  ".htm": "html",
};

function detectType(name: string): KbFileType {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "txt";
  return TYPE_BY_EXT[name.slice(dot).toLowerCase()] ?? "txt";
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 仅支持 * 通配的 basename 匹配（模式不跨路径段） */
function globMatch(pattern: string, base: string): boolean {
  const re = new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`);
  return re.test(base);
}

/** EACCES/EPERM 视为无权限（inaccessible），其余读错误视为不可读（unreadable） */
export function isAccessDenied(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return code === "EACCES" || code === "EPERM";
}

/** 排除模式归一化：反斜杠转 POSIX 分隔、去掉开头 ./ 与结尾 /（两版共用） */
function normalizeExcludes(excludePaths: string[]): string[] {
  return excludePaths
    .map(ex => ex.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, ""))
    .filter(Boolean);
}

/** 第 1 层：用户显式排除——命中即整棵剪掉（不记 skips） */
function isUserExcluded(relPath: string, normExcludes: string[]): boolean {
  const segments = relPath.split("/");
  return normExcludes.some(ex =>
    ex.includes("/")
      ? relPath === ex || relPath.startsWith(`${ex}/`)
      : segments.includes(ex),
  );
}

/**
 * 第 2 层：建议排除——目录命中时只展开一层记录直接子项（避免 node_modules 深层万级条目撑爆预览）。
 * 大小写归一：Windows 文件系统大小写不敏感，server.PEM/.ENV/MySecret.TXT 等变体必须同样命中。
 */
function matchSuggested(relPath: string): boolean {
  const segments = relPath.toLowerCase().split("/");
  const base = segments[segments.length - 1];
  return SUGGESTED_EXCLUDES_LOWER.some(pattern =>
    pattern.includes("*") ? globMatch(pattern, base) : segments.includes(pattern),
  );
}

/** 跳过归因（两版共用）：EACCES/EPERM → inaccessible，其余读错误 → unreadable */
function skipReasonFor(e: unknown): KbSkipReason {
  return isAccessDenied(e) ? "inaccessible" : "unreadable";
}

/** 技术跳过第一步（两版共用）：>10MiB 判 oversized，判定先于二进制嗅探 */
function isOversized(size: number): boolean {
  return size > MAX_FILE_BYTES;
}

// docx/pdf 是容器格式（ZIP / 压缩流），前 512 字节必然含 0x00——嗅探只对可能被
// 当纯文本读的文本类与未识别扩展名有意义，对这两类声明支持的格式探测会把整类误杀
function skipsBinarySniff(type: KbFileType): boolean {
  return type === "docx" || type === "pdf";
}

/**
 * 扫描所需的三种只读操作。同步版与异步版各注入一套实现，遍历、过滤与判定顺序
 * （本模块唯一一份）完全共用——两版结果逐项相等由结构保证，不靠人工同步两份代码。
 */
interface ScanFs {
  readdir(absDir: string): Dirent[] | Promise<Dirent[]>;
  stat(absPath: string): Stats | Promise<Stats>;
  /** 前 512 字节是否含 0x00 */
  sniffBinary(absFile: string): boolean | Promise<boolean>;
}

function sniffBinarySync(absFile: string): boolean {
  const fd = openSync(absFile, "r");
  try {
    const buf = Buffer.alloc(BINARY_SNIFF_BYTES);
    const n = readSync(fd, buf, 0, BINARY_SNIFF_BYTES, 0);
    return buf.subarray(0, n).includes(0);
  } finally {
    closeSync(fd);
  }
}

const SYNC_FS: ScanFs = {
  readdir: absDir => readdirSync(absDir, { withFileTypes: true }),
  stat: absPath => statSync(absPath),
  sniffBinary: sniffBinarySync,
};

const ASYNC_FS: ScanFs = {
  readdir: absDir => readdirAsync(absDir, { withFileTypes: true }),
  stat: absPath => statAsync(absPath),
  sniffBinary: async absFile => {
    const fh = await openAsync(absFile, "r");
    try {
      const buf = Buffer.alloc(BINARY_SNIFF_BYTES);
      const { bytesRead } = await fh.read(buf, 0, BINARY_SNIFF_BYTES, 0);
      return buf.subarray(0, bytesRead).includes(0);
    } finally {
      await fh.close();
    }
  },
};

/**
 * 唯一一份扫描实现：递归遍历、三层过滤，产出可索引清单与跳过清单。
 * 只读遍历，不写入源目录；符号链接一律不跟随。输出按路径排序保证跨平台确定性。
 * fsx 只决定「是否阻塞」：同步版供首建/预览，异步版供 60s 轮询快照（不能卡事件循环）。
 */
async function walkScan(
  fsx: ScanFs,
  folderPath: string,
  excludePaths: string[],
): Promise<ScanPreview> {
  const indexable: ScannedFile[] = [];
  const skips: ScanSkip[] = [];
  const normExcludes = normalizeExcludes(excludePaths);

  async function recordSuggestedSubtree(absDir: string, relDir: string): Promise<void> {
    let children: Dirent[];
    try {
      children = await fsx.readdir(absDir);
    } catch {
      return; // 目录本身已排除，展开失败无需记录
    }
    for (const c of children) {
      const childRel = `${relDir}/${c.name}`;
      if (isUserExcluded(childRel, normExcludes)) continue; // 用户显式排除优先：不进 skips
      skips.push({ path: childRel, reason: "suggested_excluded" });
    }
  }

  async function handleFile(absFile: string, relPath: string): Promise<void> {
    if (isUserExcluded(relPath, normExcludes)) return;
    if (matchSuggested(relPath)) {
      skips.push({ path: relPath, reason: "suggested_excluded" });
      return;
    }
    let size: number;
    let mtime: number;
    try {
      const st = await fsx.stat(absFile);
      if (!st.isFile()) return; // 竞态：遍历中已变为非常规文件，忽略
      size = st.size;
      mtime = st.mtimeMs;
    } catch (e) {
      skips.push({ path: relPath, reason: skipReasonFor(e) });
      return;
    }
    const type = detectType(relPath);
    if (isOversized(size)) {
      skips.push({ path: relPath, reason: "oversized" });
      return;
    }
    if (!skipsBinarySniff(type)) {
      try {
        if (await fsx.sniffBinary(absFile)) {
          skips.push({ path: relPath, reason: "binary" });
          return;
        }
      } catch (e) {
        skips.push({ path: relPath, reason: skipReasonFor(e) });
        return;
      }
    }
    indexable.push({ relPath, absPath: absFile, type, size, mtime });
  }

  async function walkDir(absDir: string, relDir: string): Promise<void> {
    const entries = await fsx.readdir(absDir); // 顶层失败直接抛给调用方
    for (const dirent of entries) {
      if (dirent.isSymbolicLink()) continue; // 安全：不跟随链接，防逃出源目录边界
      const childRel = relDir ? `${relDir}/${dirent.name}` : dirent.name;
      const childAbs = join(absDir, dirent.name);
      if (dirent.isDirectory()) {
        if (isUserExcluded(childRel, normExcludes)) continue;
        if (matchSuggested(childRel)) {
          await recordSuggestedSubtree(childAbs, childRel);
          continue;
        }
        try {
          await walkDir(childAbs, childRel);
        } catch (e) {
          skips.push({ path: childRel, reason: skipReasonFor(e) });
        }
      } else if (dirent.isFile()) {
        await handleFile(childAbs, childRel);
      }
      // 其余（fifo/socket/设备等非常规条目）：忽略
    }
  }

  await walkDir(folderPath, "");
  indexable.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  skips.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { indexable, skips };
}

/**
 * 扫描源目录（同步 I/O）：readdirSync/statSync 会阻塞调用线程。
 * 供首建、预览等低频长任务使用；返回 Promise 仅为沿用既有签名。
 */
export function scanFolder(
  folderPath: string,
  /** 用户显式排除（相对路径或目录名）；当前产品层未接线，调用方省略 = 不过滤 */
  excludePaths: string[] = [],
): Promise<ScanPreview> {
  return walkScan(SYNC_FS, folderPath, excludePaths);
}

/**
 * 扫描源目录（异步 I/O）：与 scanFolder 逐项等价（同一遍历器、同一套谓词与判定顺序），
 * 但用 node:fs/promises 让出事件循环——供 60s 轮询快照使用，大目录扫描不卡整个进程。
 */
export function scanFolderAsync(
  folderPath: string,
  /** 用户显式排除（相对路径或目录名）；语义同 scanFolder */
  excludePaths: string[] = [],
): Promise<ScanPreview> {
  return walkScan(ASYNC_FS, folderPath, excludePaths);
}
