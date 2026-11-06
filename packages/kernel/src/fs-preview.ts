/**
 * 文件预览判定：文本/图片白名单 + 5MB 上限 + 头部 NUL 嗅探。
 *
 * 唯一实现：WS 入口（ws-server.ts 的 fs:readFile 事件）与 REST 入口
 * （routes/fs.ts 的 POST /api/fs/read-file）都 import 这里。此前两份拷贝靠注释
 * 「保持同步」维护，改一侧忘另一侧，WS/REST 两条入口的预览行为就会分叉。
 *
 * getMimeType 的映射表是判定的输入（决定 isText/isImage），一并放在本模块而非
 * ws-server：否则 fs-preview 要反向 import ws-server，形成循环依赖。
 */
import { stat } from "node:fs/promises";
import { extname } from "node:path";

/** 预览上限：5MB，超过则跳过内容读取 */
export const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;

/** 二进制嗅探字节数：头部 8KB 含 NUL 字节判为二进制（Git 同款策略） */
export const BINARY_SNIFF_BYTES = 8000;

/** 文本嗅探：头部含 NUL 字节 → 二进制。用于 mime 未识别文件的纯文本兑底判定 */
export async function looksBinary(absPath: string): Promise<boolean> {
	try {
		const head = new Uint8Array(
			await Bun.file(absPath).slice(0, BINARY_SNIFF_BYTES).arrayBuffer(),
		);
		for (const b of head) if (b === 0) return true;
		return false;
	} catch {
		// 读不到内容按二进制处理（后续 stat 也会拒绝）
		return true;
	}
}

/** 预览判定结果：不可预览时携带 code/params 供前端按字典渲染 */
export type PreviewCheckResult =
	| { ok: true }
	| {
			ok: false;
			reason: string;
			code?: string;
			params?: Record<string, string | number>;
	  };

/** 检查文件是否可预览（文本类型 + 图片 + 大小不超标） */
export async function checkPreviewable(
	absPath: string,
): Promise<PreviewCheckResult> {
	const mime = getMimeType(absPath);
	const isText =
		mime.startsWith("text/") ||
		mime === "application/json" ||
		mime === "application/xml" ||
		mime === "image/svg+xml";
	// 放行图片预览：前端 FileViewer 拿到 base64 拼 data URI 展示，支持缩放
	const isImage = mime.startsWith("image/");
	if (!isText && !isImage) {
		// 兑底纯文本策略：扩展名未识别/未映射（dotfile、无后缀、新格式）的文件，
		// 只要内容是文本就按纯文本预览；头部含 NUL 的真二进制才拒绝
		if (await looksBinary(absPath))
			return {
				ok: false,
				reason: `二进制文件不支持预览: ${mime}`,
				code: "attachment.unsupportedType",
				params: { mime },
			};
	}
	try {
		const s = await stat(absPath);
		if (s.size > MAX_PREVIEW_BYTES)
			return {
				ok: false,
				reason: `文件过大 (${(s.size / 1024 / 1024).toFixed(1)}MB > ${MAX_PREVIEW_BYTES / 1024 / 1024}MB)`,
				code: "attachment.previewTooLarge",
				params: {
					sizeMb: (s.size / 1024 / 1024).toFixed(1),
					maxMb: MAX_PREVIEW_BYTES / 1024 / 1024,
				},
			};
	} catch {
		return {
			ok: false,
			reason: "无法获取文件信息",
			code: "attachment.statFailed",
		};
	}
	return { ok: true };
}

export function getMimeType(filePath: string): string {
	const map: Record<string, string> = {
		".txt": "text/plain",
		".md": "text/markdown",
		".html": "text/html",
		".css": "text/css",
		".js": "text/javascript",
		".mjs": "text/javascript",
		".cjs": "text/javascript",
		".json": "application/json",
		".ts": "text/typescript",
		".tsx": "text/typescript-jsx",
		// 前端框架文件：无映射时 Bun 兑底返回 application/octet-stream，
		// checkPreviewable 判非文本直接拒绝 → .vue 代码预览报「不支持的文件类型」
		".jsx": "text/jsx",
		".vue": "text/x-vue",
		// 主流代码文件：无映射时 Bun 兑底多为 application/*（非 text/*），
		// checkPreviewable 判非文本直接拒绝 → 预览报「不支持的文件类型」；
		// 统一显式映射 text/x-* 放行（前端按扩展名选 Prism 语言高亮）
		".sh": "text/x-shellscript",
		".bash": "text/x-shellscript",
		".zsh": "text/x-shellscript",
		".go": "text/x-go",
		".py": "text/x-python",
		".rs": "text/x-rust",
		".java": "text/x-java",
		".kt": "text/x-kotlin",
		".kts": "text/x-kotlin",
		".swift": "text/x-swift",
		".cs": "text/x-csharp",
		".rb": "text/x-ruby",
		".php": "text/x-php",
		".sql": "text/x-sql",
		".toml": "text/x-toml",
		".scala": "text/x-scala",
		".png": "image/png",
		".jpg": "image/jpeg",
		".jpeg": "image/jpeg",
		".gif": "image/gif",
		".svg": "image/svg+xml",
		".pdf": "application/pdf",
		".webm": "audio/webm",
		".weba": "audio/webm",
		// 视频类型：对话内联预览 <video> 直出（.webm 保持 audio/webm——录音附件既有语义，
		// <video> 对容器内容嗅探，audio/webm 映射不影响 webm 视频播放）
		".mp4": "video/mp4",
		".mov": "video/quicktime",
		".mkv": "video/x-matroska",
		".m4v": "video/x-m4v",
		".avi": "video/x-msvideo",
	};
	const ext = extname(filePath).toLowerCase();
	return map[ext] ?? (Bun.file(filePath).type || "application/octet-stream");
}
