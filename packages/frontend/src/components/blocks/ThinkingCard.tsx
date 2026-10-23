import { memo } from "react";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ProcessCard, Spinner } from "./ProcessCard";
import { useAutoCollapse } from "./useAutoCollapse";
import { Markdown } from "./Markdown";
import { MarkdownLink } from "./markdown-components";
import { CodeBlockCard } from "./CodeBlockCard";
import { remarkSoftBreaks } from "./remark-soft-breaks";
import { useTranslation } from "../../i18n/useTranslation";
import { useUiPrefsStore } from "../../store/ui-prefs";
import { Icon } from "../ui/Icon";

/** 思考过程的 markdown 映射：只读渲染（不挂文件 chip / 图片 / 媒体等会话内交互组件，
 *  思考内容里的路径多为推理草稿，不应触发预览副作用），保留链接新标签页打开与代码块高亮。
 *  模块级常量保证引用稳定，避免 Markdown 内 components 的 useMemo 每次失效。 */
const THINKING_MD_COMPONENTS: Components = {
	a: MarkdownLink,
	pre: (props: any) => {
		const codeEl = props.children;
		const className: string = codeEl?.props?.className ?? "";
		const m = /language-([\w+-]+)/.exec(className);
		return (
			<CodeBlockCard
				language={m?.[1] ?? ""}
				code={String(codeEl?.props?.children ?? "")}
			/>
		);
	},
};

/** gfm + 软换行：思考内容里的单换行渲染为 <br>（不靠容器 pre-wrap，否则
 *  react-markdown 插入的块间换行也会占整行，列表圆点与正文被拆成两行）。
 *  模块级常量保证引用稳定，避免 Markdown 内部每帧重新解析插件列表。 */
const THINKING_REMARK_PLUGINS = [remarkGfm, remarkSoftBreaks];

/** 思考过程卡片：流式中展开实时可见，整轮结束自动折叠并弱化;
 *  开启「回复过程默认折叠」后，流式中也默认折叠（用户仍可手动展开）。
 *  memo：同消息内其他块流式更新时 props 不变，整块跳过（thinking 往往是回复中
 *  最长部分，markdown 解析不能被连坐重渲染）。
 *  正文与聊天正文一致走 Markdown（模型输出的思考内容本身是 markdown）；流式解析
 *  节流由 Markdown 的 streaming/throttleMs 承担（不逐帧全量解析，避免卡顿/闪烁）。 */
export const ThinkingCard = memo(function ThinkingCard({
	thinking,
	isStreaming,
	throttleMs = 20,
}: {
	thinking: string;
	isStreaming?: boolean;
	throttleMs?: number;
}) {
	const collapseProcessByDefault = useUiPrefsStore(
		(s) => s.collapseProcessByDefault,
	);
	const { open, toggle } = useAutoCollapse({
		isStreaming,
		isDone: !isStreaming,
		defaultCollapsed: collapseProcessByDefault,
	});
	const { t } = useTranslation();
	return (
		<ProcessCard
			tone="accent"
			icon={<Icon name="thought" />}
			title={t("blocks.thinking.title")}
			meta={
				isStreaming ? (
					<>
						<Spinner />
						<span>{t("blocks.thinking.thinking")}</span>
					</>
				) : (
					t("blocks.thinking.done")
				)
			}
			open={open}
			onToggle={toggle}
			muted={!isStreaming}
			testId="thinking-panel"
		>
			<Markdown
				text={thinking}
				interactive={false}
				components={THINKING_MD_COMPONENTS}
				streaming={!!isStreaming}
				throttleMs={throttleMs}
				remarkPlugins={THINKING_REMARK_PLUGINS}
				className="prose prose-sm max-w-none italic text-tertiary thinking-md"
				testId={null}
			/>
		</ProcessCard>
	);
});
