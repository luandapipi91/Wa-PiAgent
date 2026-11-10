// 知识库切块器：索引管线第三阶段——把抽取出的纯文本按结构切成 KnowledgeChunk 供索引编排器落库。
// 分派：md/docx/html 走标题栈结构切块（块目标 450 token；docx/html 剥壳后无 # 标题时自然退化为
// 段落累加）；txt/pdf 走段落累加（块目标 550 token）。
// 所有块最终做嵌入预算再切：prefixContent ≤ 448 token（512 × 87.5%），按 空行→换行→句号→空白
// 优先级二分；分隔符全无时按字符硬切——宁可重切不静默截断。单段 > 6000 字符先按 6000 字符硬切。
// estimateTokens 用 CJK 字符数 + ASCII 词数估算（计划既定决策：不加载 tokenizer，测试同款公式）。
import { createHash, randomUUID } from "node:crypto";
import type { KbFileType } from "./scan";

/** 切块产物：id 为新生成的 uuid；contentHash = sha256(relPath␀startLine␀endLine␀content)（␀ 即 \0） */
export interface KnowledgeChunk {
	id: string;
	relPath: string;
	fileType: KbFileType;
	/** 块所属最内层标题（无标题结构 / 纯文本路径时为 undefined） */
	title?: string;
	/** 标题栈 breadcrumb，如「产品 > 定价」（有才出现） */
	breadcrumb?: string;
	startLine: number;
	endLine: number;
	/** 块正文 = 当前标题 + 空行 + 节内容（无标题时即节内容） */
	content: string;
	/** 前缀（File:/Type:/Section:）+ 空行 + content，作嵌入输入，恒 ≤ 448 token */
	prefixContent: string;
	contentHash: string;
}

/** chunkDocument 输入：extractText 产物的纯内存投影（relPath 缺省为空串、startLine 缺省为 1） */
export interface ChunkerDoc {
	type: KbFileType;
	text: string;
	relPath?: string;
	startLine?: number;
}

/** 块目标 token：Markdown/结构 450，纯文本 550（全局约束） */
const STRUCT_TARGET = 450;
const PLAIN_TARGET = 550;
/** 嵌入预算：512 × 87.5% = 448，prefixContent 硬上限 */
const EMBED_BUDGET = 448;
/** 标题前缀最多占预算的 30%：留出正文份额，避免深层/超长标题栈把预算吃满 */
const HEAD_BUDGET = Math.floor(EMBED_BUDGET * 0.3);
/** 单段超过该字符数按 6000 字符硬切（全局约束） */
const HARD_CUT_CHARS = 6000;

/** CJK 类字符（汉字/假名/谚文/全角标点等），按 1 字符 ≈ 1 token 计（全角标点按 1 token，偏安全侧） */
const CJK_RE = /[\u3000-\u303f\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff01-\uff5e]/g;

/**
 * token 估算：CJK 类字符数 + 其余文本按空白分词的词数。
 * 与测试共用同一公式（数量级对齐 transformers：CJK≈1 字 1 token），不加载 tokenizer。
 */
export function estimateTokens(text: string): number {
	const cjk = text.match(CJK_RE)?.length ?? 0;
	const words = text.replace(CJK_RE, " ").split(/\s+/).filter(Boolean).length;
	// 无空白文本（压缩 JS/CSS、长 URL、连续标识符）按空白分词会严重低估：
	// 用「4 字符 ≈ 1 token」的非 CJK 兜底并取较大者（英文散文下词数更大，不受影响）
	const denseRest = Math.ceil(text.replace(CJK_RE, "").replace(/\s+/g, "").length / 4);
	return cjk + Math.max(words, denseRest);
}

/**
 * sha256 十六进制摘要，输入按 \0（NUL）分隔拼接，6 字段：
 * relPath␀fileType␀startLine␀endLine␀breadcrumb␀content。
 * 面包屑进身份的原因：块的嵌入输入（prefixContent）含完整标题链，只改祖先标题时
 * 本层正文不变——若 hash 不含面包屑，会复用旧向量却写入新前缀，语义检索按旧含义召回。
 */
function contentHashOf(
	relPath: string,
	fileType: string,
	startLine: number,
	endLine: number,
	breadcrumb: string | undefined,
	content: string,
): string {
	return createHash("sha256")
		.update(`${relPath}\0${fileType}\0${startLine}\0${endLine}\0${breadcrumb ?? ""}\0${content}`)
		.digest("hex");
}

/** 子串内换行数（行号推算用：切点前完整换行数 + 子段自身换行数） */
function countNewlines(s: string): number {
	return s.length === 0 ? 0 : s.split("\n").length - 1;
}

/** 一个段落/块的最小载体：文本 + 源文件 1 基行号范围 */
interface Para {
	text: string;
	startLine: number;
	endLine: number;
}

/**
 * 切块行号推算：合成标题前导（headLen 个字符）不是源文件行，不计入源行数；
 * 正文部分在 sourceBody 中的偏移决定起始行，子块自身正文的换行数决定结束行。
 */
function lineRangeOf(text: string, offset: number, headLen: number, sourceBody: string, anchorStart: number): Para {
	const bodyOffset = Math.max(0, offset - headLen);
	const bodyInText = text.slice(Math.max(0, headLen - offset));
	const startLine = anchorStart + countNewlines(sourceBody.slice(0, bodyOffset));
	return { text, startLine, endLine: startLine + countNewlines(bodyInText) };
}

/** 段落 > 6000 字符时按 6000 字符硬切（全局约束），行号按切点处换行数推算 */
function hardCutLong(para: Para): Para[] {
	if (para.text.length <= HARD_CUT_CHARS) return [para];
	const parts: Para[] = [];
	let offset = 0;
	while (offset < para.text.length) {
		const text = para.text.slice(offset, offset + HARD_CUT_CHARS);
		parts.push(lineRangeOf(text, offset, 0, para.text, para.startLine));
		offset += text.length;
	}
	return parts;
}

/** 行数组按空行切段（段内保留换行），段超 6000 字符再硬切；baseIndex = lines[0] 在全文档的 0 基行索引 */
function splitParas(lines: string[], baseIndex: number, docStartLine: number): Para[] {
	const out: Para[] = [];
	let buf: string[] = [];
	let relStart = -1;
	const push = () => {
		if (!buf.length) return;
		const startLine = docStartLine + baseIndex + relStart;
		out.push(...hardCutLong({ text: buf.join("\n"), startLine, endLine: startLine + buf.length - 1 }));
		buf = [];
		relStart = -1;
	};
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim() === "") {
			push();
		} else {
			if (relStart < 0) relStart = i;
			buf.push(lines[i]);
		}
	}
	push();
	return out;
}

/** 结构切块待组装块（预算再切与前缀注入之前）；headLen = 合成标题前导长度（行号推算时剔除） */
interface RawBlock {
	title?: string;
	breadcrumb?: string;
	content: string;
	headLen: number;
	startLine: number;
	endLine: number;
}

/** 段落累加至目标 token：装不下且已有累积时先出块；单段超预算自成一块（由预算再切兜底） */
function accumulate(headText: string, paras: Para[], target: number): RawBlock[] {
	const headTokens = estimateTokens(headText);
	const blocks: RawBlock[] = [];
	let acc: Para[] = [];
	let accTokens = headTokens;
	const emit = () => {
		if (!acc.length) return;
		blocks.push({
			content: headText + acc.map(p => p.text).join("\n\n"),
			headLen: headText.length,
			startLine: acc[0].startLine,
			endLine: acc[acc.length - 1].endLine,
		});
		acc = [];
		accTokens = headTokens;
	};
	for (const p of paras) {
		const t = estimateTokens(p.text);
		if (acc.length && accTokens + t > target) emit();
		acc.push(p);
		accTokens += t;
	}
	emit();
	return blocks;
}

/** md 标题行：H1–H4 入栈（H5+ 不识别为结构，当普通文本行） */
const MD_HEADING_RE = /^(#{1,4})\s+(.+?)\s*$/;
/** 围栏（``` 或 ~~~）开关：围栏内的 # 行是代码，不是标题 */
const FENCE_RE = /^\s*(?:```|~~~)/;

/** 一节：标题栈 + 节内容行（保留原始空行）+ 节内容首行在全文档行数组中的 0 基索引 */
interface MdSection {
	stack: string[];
	lines: string[];
	baseIndex: number;
}

/** 按标题栈把 md 行序列解析成节列表；文档开头无标题的行归入空栈节；全空白节不产出 */
function parseMdSections(lines: string[]): MdSection[] {
	const sections: MdSection[] = [];
	let stack: string[] = [];
	let buf: string[] = [];
	let baseIndex = 0;
	let inFence = false;
	const flush = () => {
		if (buf.some(l => l.trim() !== "")) sections.push({ stack: [...stack], lines: buf, baseIndex });
		buf = [];
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (FENCE_RE.test(line)) inFence = !inFence;
		const m = inFence ? null : MD_HEADING_RE.exec(line);
		if (m) {
			flush();
			baseIndex = i + 1;
			while (stack.length >= m[1].length) stack.pop();
			stack.push(m[2]);
		} else {
			if (buf.length === 0) baseIndex = i;
			buf.push(line);
		}
	}
	flush();
	return sections;
}

/** 预算再切分隔符优先级：空行 → 换行 → 句号 → 空白（全局约束）；全无时按字符比例硬切兜底 */
/** 按 token 预算截断文本（二分字符边界；estimateTokens 单调非降） */
function truncateToTokens(text: string, budget: number): string {
	if (estimateTokens(text) <= budget) return text;
	let lo = 0;
	let hi = text.length;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (estimateTokens(text.slice(0, mid)) <= budget) lo = mid;
		else hi = mid - 1;
	}
	return text.slice(0, lo);
}

function splitBudget(content: string, target: number): string[] {
	if (estimateTokens(content) <= target) return [content];
	const mid = content.length / 2;
	for (const sep of ["\n\n", "\n", "。", "."]) {
		const point = nearestOccurrence(content, sep, mid);
		if (point !== null) {
			return [...splitBudget(content.slice(0, point), target), ...splitBudget(content.slice(point), target)];
		}
	}
	const wsPoint = nearestWhitespaceCut(content, mid);
	if (wsPoint !== null) {
		return [...splitBudget(content.slice(0, wsPoint), target), ...splitBudget(content.slice(wsPoint), target)];
	}
	// 无任何分隔符（如整段重复单字）：按 target token 对应的字符比例硬切
	const cut = Math.max(1, Math.floor((content.length * target) / estimateTokens(content)));
	return [...splitBudget(content.slice(0, cut), target), ...splitBudget(content.slice(cut), target)];
}

/** sep 所有出现位置中距 mid 最近者（切点 = 出现结束处，分隔符保留在左块尾部；排除首尾边界） */
function nearestOccurrence(content: string, sep: string, mid: number): number | null {
	let best: number | null = null;
	let i = content.indexOf(sep);
	while (i !== -1) {
		const point = i + sep.length;
		if (point < content.length && (best === null || Math.abs(point - mid) < Math.abs(best - mid))) best = point;
		i = content.indexOf(sep, i + 1);
	}
	return best;
}

function nearestWhitespaceCut(content: string, mid: number): number | null {
	let best: number | null = null;
	for (const m of content.matchAll(/\s+/g)) {
		const point = m.index + m[0].length;
		if (point < content.length && (best === null || Math.abs(point - mid) < Math.abs(best - mid))) best = point;
	}
	return best;
}

/**
 * 把抽取文本切成 KnowledgeChunk：
 * 1) 按类型分派结构切块（450）/ 段落累加（550），单段 > 6000 字符先硬切；
 * 2) 每块做嵌入预算再切，保证 prefixContent ≤ 448 token（前缀自身占额从内容份额扣除）；
 * 3) 生成 uuid id 与 contentHash = sha256(relPath␀fileType␀startLine␀endLine␀breadcrumb␀content)。
 * 空白文本返回 []。块行号取正文实际源行（合成标题前导行不计入）。
 */
export function chunkDocument(doc: ChunkerDoc): KnowledgeChunk[] {
	const relPath = doc.relPath ?? "";
	const docStartLine = doc.startLine ?? 1;
	const structural = doc.type === "md" || doc.type === "docx" || doc.type === "html";
	const lines = doc.text.split("\n");
	const raw: RawBlock[] = [];

	if (structural) {
		for (const sec of parseMdSections(lines)) {
			const title = sec.stack.at(-1);
			const head = title !== undefined ? `${title}\n\n` : "";
			const paras = splitParas(sec.lines, sec.baseIndex, docStartLine);
			for (const b of accumulate(head, paras, STRUCT_TARGET)) {
				raw.push({ ...b, title, breadcrumb: sec.stack.length > 0 ? sec.stack.join(" > ") : undefined });
			}
		}
	} else {
		raw.push(...accumulate("", splitParas(lines, 0, docStartLine), PLAIN_TARGET));
	}

	const chunks: KnowledgeChunk[] = [];
	for (const b of raw) {
		const rawHead =
			`File: ${relPath}\nType: ${doc.type}` +
			(b.breadcrumb !== undefined ? `\nSection: ${b.breadcrumb}` : "") +
			"\n\n";
		// 前缀只允许吃 30% 预算：超长标题栈直接截断前缀，保证正文始终有份额可分
		// （此前 contentTarget < 1 时整块原样返回，会被 tokenizer 静默截断，尾部内容等于丢失）
		const head = truncateToTokens(rawHead, HEAD_BUDGET);
		const contentTarget = Math.max(1, EMBED_BUDGET - estimateTokens(head));
		const parts = splitBudget(b.content, contentTarget);
		const sourceBody = b.content.slice(b.headLen);
		let offset = 0;
		for (const part of parts) {
			// 未再切（单块）：content 里的合成 join 会压缩段间空行，直接用原块的精确源行号；
			// 再切子块才有必要按正文偏移推算行号
			const { startLine, endLine } = parts.length === 1
				? { startLine: b.startLine, endLine: b.endLine }
				: lineRangeOf(part, offset, b.headLen, sourceBody, b.startLine);
			chunks.push({
				id: randomUUID(),
				relPath,
				fileType: doc.type,
				title: b.title,
				breadcrumb: b.breadcrumb,
				startLine,
				endLine,
				content: part,
				prefixContent: head + part,
				contentHash: contentHashOf(relPath, doc.type, startLine, endLine, b.breadcrumb, part),
			});
			offset += part.length;
		}
	}
	return chunks;
}
