import { Fragment, memo } from "react";
import type { ReactNode } from "react";

/**
 * 轻量 URL 链接化：把纯文本中的裸 http/https URL 转为可点击链接。
 *
 * 用途：agent 消息渲染中不走 ReactMarkdown 的纯文本位置
 * （流式子代理预览 / thinking / 工具结果），避免为了一个 URL 跑完整 markdown 管线
 * （流式中每 token 重跑 ReactMarkdown 是卡顿热点）。
 *
 * 与 remark-gfm autolink 的差异（有意简化）：
 * - 只链接 http/https 协议，杜绝 javascript: 等注入（href 白名单协议）。
 * - 裁剪 URL 结尾的常见标点（句号/逗号/括号/引号等），与 GFM trail 规则近似。
 * - 不做 HTML 实体（&...;）与括号配对的精细处理。
 */
const URL_RE = /(https?:\/\/[^\s<>"'`]+)/gi;
const TRAIL_RE = /[.,;:!?)\]}>"'，。；：！？、）】》"']+$/;

/** 纯函数：把文本中的 http/https URL 拆成 ReactNode 数组（URL 为 <a>，其余为文本）。 */
export function linkifyText(text: string): ReactNode[] {
	const parts = text.split(URL_RE);
	const out: ReactNode[] = [];
	for (let i = 0; i < parts.length; i++) {
		const p = parts[i];
		if (!p) continue;
		if (i % 2 === 1) {
			// URL 段（split 带捕获组，奇数索引）
			const trailM = TRAIL_RE.exec(p);
			const url = trailM ? p.slice(0, trailM.index) : p;
			const trail = trailM ? p.slice(trailM.index) : "";
			if (url) {
				out.push(
					<a
						key={`${i}-a`}
						href={url}
						target="_blank"
						rel="noopener noreferrer"
						className="text-accent underline underline-offset-2 hover:opacity-80"
					>
						{url}
					</a>,
				);
			}
			if (trail) out.push(<Fragment key={`${i}-t`}>{trail}</Fragment>);
		} else {
			out.push(<Fragment key={i}>{p}</Fragment>);
		}
	}
	return out;
}

/** 组件：把纯文本中的裸 URL 渲染为可点击链接（新标签页打开）。 */
export const Linkify = memo(function Linkify({
	text,
	className,
}: {
	text: string;
	className?: string;
}) {
	return <span className={className}>{linkifyText(text)}</span>;
});
