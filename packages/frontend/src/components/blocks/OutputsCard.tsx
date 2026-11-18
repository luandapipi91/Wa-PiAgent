import type { ReactNode } from "react";

/**
 * 合并输出卡片：把本轮所有正式输出装进一个外框，段间用细虚线分割。
 * 内部段落由调用方渲染（`MessageList` 用 `renderSeg(seg, key, streaming, "plain")`），
 * 不再套二级气泡，避免「卡片里套气泡」的双层边框。
 *
 * `joined`：与下方最终回复气泡连成一体（去掉下边框与下圆角、去掉两者之间的间隙），
 * 用于精简模式展开过程输出——视觉上是一张卡片的上下两段，参考完整输出模式的整块观感。
 */
export function OutputsCard({
	children,
	joined = false,
}: {
	children: ReactNode;
	joined?: boolean;
}) {
	return (
		<div
			data-testid="outputs-card"
			data-joined={joined ? "true" : "false"}
			className={[
				"bg-surface border border-hairline shadow-sm",
				joined
					? "rounded-t-sm border-b-0"
					: "rounded-sm [&>*+*]:border-t [&>*+*]:border-dashed [&>*+*]:border-hairline",
			].join(" ")}
		>
			{children}
		</div>
	);
}
