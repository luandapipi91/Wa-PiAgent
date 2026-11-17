/**
 * 合并输出卡片：把本轮所有正式输出装进一个外框，段间用细虚线分割。
 * 内部段落由调用方渲染（`MessageList` 用 `renderSeg(seg, key, streaming, "plain")`），
 * 不再套二级气泡，避免「卡片里套气泡」的双层边框。
 */
export function OutputsCard({ children }: { children: React.ReactNode }) {
	return (
		<div
			data-testid="outputs-card"
			className="bg-surface border border-hairline shadow-sm rounded-sm [&>*+*]:border-t [&>*+*]:border-dashed [&>*+*]:border-hairline"
		>
			{children}
		</div>
	);
}
