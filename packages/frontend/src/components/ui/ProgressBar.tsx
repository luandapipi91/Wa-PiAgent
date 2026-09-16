// ProgressBar — 通用进度条。
// determinate：传 percent（0-100）；indeterminate：呼吸脉冲动画（无真实百分比时表示"处理中"）。
export function ProgressBar({
	percent,
	indeterminate,
	testId,
}: {
	percent?: number;
	indeterminate?: boolean;
	testId?: string;
}) {
	return (
		<div
			className="w-full h-1.5 rounded-full overflow-hidden"
			style={{ background: "var(--hairline)" }}
			data-testid={testId ?? "progress-bar"}
		>
			{indeterminate ? (
				<>
					{/* 无真实百分比时用「呼吸脉冲」：满宽条透明度渐变，视觉是"处理中"；
					   不用滑块往返循环——滑块每次跳回起点会被误读为进度回退/重置 */}
					<style>{`@keyframes wapi-progress-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }`}</style>
					<div
						className="h-full rounded-full"
						style={{
							width: "100%",
							background: "var(--brand)",
							animation: "wapi-progress-pulse 1.6s ease-in-out infinite",
						}}
						data-testid="progress-bar-indeterminate"
					/>
				</>
			) : (
				<div
					className="h-full rounded-full transition-all duration-300"
					style={{
						width: `${Math.min(100, Math.max(0, percent ?? 0))}%`,
						background: "var(--brand)",
					}}
					data-testid="progress-bar-fill"
				/>
			)}
		</div>
	);
}
