// 流式可见性预判缓存：从 MessageList 提取为独立纯模块，
// 便于 session store 在 message_end 时调用 clearStreamingVisibleCache 释放缓存。
import { markdownLookBack } from "@llm-ui/markdown";
import { codeBlockLookBack } from "@llm-ui/code";

const _cache = new Map<string, boolean>();
const _MAX = 256;

/**
 * 流式 text 段可见性预判：llm-ui 的 markdownLookBack/codeBlockLookBack 会扣留
 * 未闭合的 markdown 语法尾巴（工具调用前 text 常定格在 ``` 或 **）。
 * 若两种 lookBack 都扣留为空（无可见文本），该段渲染后是空 → 气泡容器产生
 * 空白气泡，应跳过。定稿段（MarkdownBlock 直接渲染全文）不受此影响，不走本判断。
 *
 * markdownLookBack 内部做两次 mdast 全量解析——模块级缓存避免每帧重复解析。
 * 带上限：超出清空（流式文本不断增长，早期缓存自然失效，无需 LRU）。
 */
export function isStreamingTextVisible(text: string): boolean {
	if (!text?.trim()) return false;
	const cached = _cache.get(text);
	if (cached !== undefined) return cached;
	const params = {
		output: text,
		isComplete: false,
		visibleTextLengthTarget: Infinity,
		isStreamFinished: false,
	};
	const mdVisible = markdownLookBack()(params).visibleText.trim();
	const codeVisible = codeBlockLookBack()(params).visibleText.trim();
	const visible = mdVisible.length > 0 || codeVisible.length > 0;
	if (_cache.size >= _MAX) {
		_cache.clear();
	}
	_cache.set(text, visible);
	return visible;
}

/** 清空流式可见性缓存——message_end（回合结束）时调用，释放流式中间状态字符串。 */
export function clearStreamingVisibleCache(): void {
	_cache.clear();
}

/** 返回缓存条目数（仅供测试断言用）。 */
export function getStreamingVisibleCacheSize(): number {
	return _cache.size;
}
