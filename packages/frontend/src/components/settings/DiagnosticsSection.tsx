import { useTranslation } from "../../i18n/useTranslation";
import { useDiagnosticsStore } from "../../store/diagnostics";

/**
 * 诊断区块：扩展错误持久列表（toast 会消失，这里留痕供排障/截图反馈）。
 * 数据来自 pi extension_error 事件（内存态，最近 50 条）。
 */
export function DiagnosticsSection() {
	const entries = useDiagnosticsStore((s) => s.entries);
	const clear = useDiagnosticsStore((s) => s.clear);
	const { t } = useTranslation();

	const fmtTime = (ts: number) => {
		const d = new Date(ts);
		const p = (n: number) => String(n).padStart(2, "0");
		return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
	};

	return (
		<div className="flex flex-col gap-2 p-4 overflow-auto">
			<div className="flex items-center">
				<span className="text-sm font-medium text-primary">
					{t("settings.diagnostics.title", { count: entries.length })}
				</span>
				{entries.length > 0 && (
					<button
						onClick={clear}
						className="ml-auto text-[calc(11.5px*var(--font-scale))] px-2.5 py-0.5 rounded-pill border-0 bg-danger-soft text-danger cursor-pointer"
						data-testid="diag-clear-btn"
					>
						{t("settings.diagnostics.clear")}
					</button>
				)}
			</div>
			{entries.length === 0 && (
				<div className="text-tertiary text-sm text-center py-10">
					{t("settings.diagnostics.empty")}
				</div>
			)}
			{entries.map((e) => (
				<div
					key={e.id}
					className="flex items-baseline gap-2.5 px-3 py-2 rounded-md border border-hairline text-[calc(12px*var(--font-scale))]"
					data-testid="diag-row"
				>
					<span className="text-tertiary text-[calc(11px*var(--font-scale))] whitespace-nowrap">
						{fmtTime(e.timestamp)}
					</span>
					<span className="font-semibold text-primary whitespace-nowrap">
						{e.extension}
					</span>
					<span className="text-tertiary font-mono text-[calc(11px*var(--font-scale))] whitespace-nowrap">
						{e.event}
					</span>
					<span
						className="flex-1 min-w-0 truncate"
						style={{ color: "var(--danger)" }}
						title={e.error}
					>
						{e.error}
					</span>
				</div>
			))}
		</div>
	);
}
