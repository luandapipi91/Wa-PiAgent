// ProgressBar — 通用进度条。
// determinate：传 percent（0-100）；indeterminate：往返滑动动画（无真实百分比时用）。
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
					<style>{`@keyframes wapi-progress-slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(350%); } }`}</style>
					<div
						className="h-full rounded-full"
						style={{
							width: "30%",
							background: "var(--brand)",
							animation: "wapi-progress-slide 1.2s ease-in-out infinite",
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
