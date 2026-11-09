// 知识库文本抽取器：索引管线第二阶段——把 md/txt/docx/pdf/html 统一变成纯文本供切块器消费。
// md/txt 直读 utf8；html 正则剥壳取正文；docx/pdf 惰性 import 第三方解析库
// （mammoth/unpdf，选型 Spike 结论见任务 4 简报：安装包增量 ≈2.8MiB < 15MB 阈值）。
// 惰性 import 的目的：二进制解析库只在真正遇到 docx/pdf 文件时才加载，纯文本库不付出启动开销
// （不省编译产物体积——bundle 时静态可见——这是已知事实，不是优化承诺）。
// 所有失败统一包 ExtractionError（带文件路径与原因摘要），调用方据此记 extraction_failed 跳过。
import { readFileSync } from "node:fs";
import type { KbFileType } from "./scan";

/** 抽取失败（读文件/解析二进制均归此错误；message 含文件路径与原因摘要） */
export class ExtractionError extends Error {
	constructor(
		readonly filePath: string,
		reason: string,
		cause?: unknown,
	) {
		super(`文本抽取失败 ${filePath}: ${reason}`);
		this.name = "ExtractionError";
		if (cause !== undefined) this.cause = cause;
	}
}

/** 抽取结果：text 必填；title/headings 由来源文档显式给出时才填（当前各来源均不产出） */
export interface ExtractedText {
	text: string;
	title?: string;
	headings?: string[];
}

export type ExtractFileType = KbFileType;

/** md/txt：直读 utf8，不做任何转换（markdown 结构留给切块器按行处理）；IO 失败包 ExtractionError */
function readPlain(absPath: string): ExtractedText {
	try {
		return { text: readFileSync(absPath, "utf8") };
	} catch (e) {
		throw new ExtractionError(absPath, (e as Error).message, e);
	}
}

/** 统一在 readFileSync 外包一层 ExtractionError（含 ENOENT/EACCES 等 IO 失败） */
function readBufferOrThrow(absPath: string): Buffer {
	try {
		return readFileSync(absPath);
	} catch (e) {
		throw new ExtractionError(absPath, (e as Error).message, e);
	}
}

/** 少量高频 HTML 实体还原（不引入完整实体表——知识库正文不依赖冷门实体） */
function decodeHtmlEntities(s: string): string {
	return s
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

/**
 * html：正则剥壳取正文。
 * 1) 整块剔除 script/style/nav/header/footer（含内容——脚本、样式、页眉页脚不进切块）；
 * 2) 块级闭合标签转换行（保留正文段落结构），其余标签剥掉；
 * 3) 实体还原 + 空白归一。
 */
function extractHtmlText(absPath: string): ExtractedText {
	let html = readBufferOrThrow(absPath).toString("utf8");
	html = html
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<(script|style|nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
	const text = decodeHtmlEntities(
		html
			.replace(/<\/(p|div|section|article|h[1-6]|li|tr|blockquote|pre)\b>/gi, "\n")
			.replace(/<br\b[^>]*\/?>/gi, "\n")
			.replace(/<[^>]+>/g, " "),
	)
		.replace(/[ \t\r\f\v]+/g, " ")
		.replace(/ ?\n ?/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return { text };
}

/** docx：mammoth extractRawText（惰性加载）；mammoth 解不出内容时也不抛错，返回值即正文 */
async function extractDocxText(absPath: string): Promise<ExtractedText> {
	const buffer = readBufferOrThrow(absPath);
	try {
		const mammoth = await import("mammoth");
		const { value } = await mammoth.extractRawText({ buffer });
		return { text: value };
	} catch (e) {
		if (e instanceof ExtractionError) throw e;
		throw new ExtractionError(absPath, (e as Error).message, e);
	}
}

/** pdf：unpdf（内嵌 pdf.js）抽全部页文本合并（惰性加载）；损坏结构由 getDocumentProxy/extractText 抛错 */
async function extractPdfText(absPath: string): Promise<ExtractedText> {
	const buffer = readBufferOrThrow(absPath);
	try {
		const { extractText: pdfExtractText, getDocumentProxy } = await import("unpdf");
		const pdf = await getDocumentProxy(new Uint8Array(buffer));
		const { text } = await pdfExtractText(pdf, { mergePages: true });
		return { text };
	} catch (e) {
		if (e instanceof ExtractionError) throw e;
		throw new ExtractionError(absPath, (e as Error).message, e);
	}
}

/**
 * 按扫描类型抽取纯文本。docx/pdf 走第三方解析库（惰性 import），失败包 ExtractionError。
 * 调用方（索引管线）捕获 ExtractionError 后记 extraction_failed 跳过，不中断整批索引。
 */
export async function extractText(absPath: string, type: ExtractFileType): Promise<ExtractedText> {
	switch (type) {
		case "md":
		case "txt":
			return readPlain(absPath);
		case "html":
			return extractHtmlText(absPath);
		case "docx":
			return extractDocxText(absPath);
		case "pdf":
			return extractPdfText(absPath);
	}
}
