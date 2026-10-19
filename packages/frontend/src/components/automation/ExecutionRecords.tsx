import { useState, useEffect, useCallback } from "react";
import { useSchedulerStore } from "../../store/scheduler";
import { formatRecordError } from "../../util/kernel-error";
import { recordShowsDuration, recordVisual } from "./record-visual";

// 初始加载窗口：按天/周/月对应的时间跨度（毫秒）
const PERIOD_MS = {
	day: 86400000,
	week: 604800000,
	month: 2592000000,
} as const;
const PAGE_LIMIT = 200; // 与后端单次返回上限一致

/**
 * 执行记录列表：顶部筛选栏（按天/周/月 + 任务筛选 + 状态筛选）+ 记录卡片。
 * 挂载/切换周期时按时间窗口增量拉取（不再默认全量拉历史）；任务/状态筛选本地过滤。
 * 窗口内记录打满单次上限时显示「加载更早」，向前扩一个窗口重拉。
 */
export function ExecutionRecords() {
	const { tasks, records, loadRecords, openRecordDetail } = useSchedulerStore();
	const [period, setPeriod] = useState<keyof typeof PERIOD_MS>("day");
	const [taskFilter, setTaskFilter] = useState("");
	const [statusFilter, setStatusFilter] = useState("");
	// 当前加载窗口起点（null = 未加载）；「加载更早」向前扩一个周期
	const [windowStart, setWindowStart] = useState<number | null>(null);

	const periodMs = PERIOD_MS[period];

	const loadWindow = useCallback(
		(start: number) => {
			void loadRecords({ since: start, limit: PAGE_LIMIT });
		},
		[loadRecords],
	);

	useEffect(() => {
		const start = Date.now() - periodMs;
		setWindowStart(start);
		loadWindow(start);
	}, [period, periodMs, loadWindow]);

	const loadEarlier = () => {
		if (windowStart == null) return;
		const start = windowStart - periodMs;
		setWindowStart(start);
		loadWindow(start);
	};
	// 窗口内打满单次上限 ⇒ 可能还有更早记录，展示「加载更早」
	const canLoadEarlier =
		windowStart != null &&
		records.filter((r) => r.startedAt >= windowStart).length >= PAGE_LIMIT;

	let filtered = records;
	if (taskFilter) filtered = filtered.filter((r) => r.taskId === taskFilter);
	if (statusFilter === "cancelled") {
		// 用户主动取消落在 failed + errorCode=scheduler.taskCancelled：单列筛选项便于区分
		filtered = filtered.filter(
			(r) => r.errorCode === "scheduler.taskCancelled",
		);
	} else if (statusFilter) {
		filtered = filtered.filter((r) => r.status === statusFilter);
	}

	// 时间过滤：SSE 兑底刷新可能拉回窗口外数据，展示时仍按当前周期窗口裁剪
	const now = Date.now();
	filtered = filtered.filter((r) => now - r.startedAt < periodMs);

	return (
		<div data-testid="execution-records">
			{/* 筛选栏 */}
			<div className="flex gap-1.5 mb-3 items-center">
				<div
					className="flex gap-0.5 rounded p-0.5"
					style={{ background: "var(--surface-hover)" }}
				>
					{(
						[
							["day", "按天"],
							["week", "按周"],
							["month", "按月"],
						] as const
					).map(([k, label]) => (
						<span
							key={k}
							onClick={() => setPeriod(k)}
							className="text-[10px] px-2 py-0.5 rounded cursor-pointer"
							style={{
								background: period === k ? "var(--surface)" : "transparent",
								color: period === k ? "var(--text-primary)" : "var(--text-tertiary)",
							}}
						>
							{label}
						</span>
					))}
				</div>
				<select
					value={taskFilter}
					onChange={(e) => setTaskFilter(e.target.value)}
					className="text-[10px] px-1.5 py-0.5 rounded border outline-none cursor-pointer"
					style={{
						background: "var(--surface-hover)",
						borderColor: "var(--hairline)",
						color: "var(--text-secondary)",
					}}
				>
					<option value="">全部任务</option>
					{tasks.map((t) => (
						<option key={t.id} value={t.id}>
							{t.name}
						</option>
					))}
				</select>
				<select
					value={statusFilter}
					onChange={(e) => setStatusFilter(e.target.value)}
					className="text-[10px] px-1.5 py-0.5 rounded border outline-none cursor-pointer"
					style={{
						background: "var(--surface-hover)",
						borderColor: "var(--hairline)",
						color: "var(--text-secondary)",
					}}
				>
					<option value="">全部状态</option>
					<option value="success">成功</option>
					<option value="failed">失败</option>
					<option value="running">运行中</option>
					<option value="cancelled">已取消</option>
				</select>
			</div>

			{/* 记录列表 */}
			{filtered.length === 0 ? (
				<div className="text-center py-12">
					<div className="text-3xl mb-2 opacity-30">🕐</div>
					<div className="text-sm" style={{ color: "var(--text-secondary)" }}>
						暂无执行记录
					</div>
					<div
						className="text-[10px] mt-1"
						style={{ color: "var(--text-tertiary)" }}
					>
						当定时任务开始执行后，记录将显示在这里
					</div>
				</div>
			) : (
				<div className="space-y-1.5">
					{filtered.map((r) => (
						<div
							key={r.id}
							className="flex gap-2.5 p-2.5 rounded-md cursor-pointer"
							style={{ background: "var(--surface-hover)" }}
							onClick={() => openRecordDetail(r.id, "records")}
							data-testid={`execution-record-row-${r.id}`}
						>
							<div
								className="w-7 h-7 rounded-full flex items-center justify-center text-xs flex-shrink-0"
								style={{
									background: recordVisual(r).bg,
									color: recordVisual(r).color,
								}}
							>
								{recordVisual(r).icon}
							</div>
							<div className="flex-1">
								<div className="text-xs" style={{ color: "var(--text-primary)" }}>
									{r.taskName}
								</div>
								<div
									className="text-[10px] flex gap-2 mt-0.5"
									style={{ color: "var(--text-tertiary)" }}
								>
									<span>{new Date(r.startedAt).toLocaleString("zh-CN")}</span>
									{r.durationMs != null && recordShowsDuration(r) && (
										<span>耗时 {(r.durationMs / 1000).toFixed(0)}s</span>
									)}
									{r.pushResults?.some((p) => p.success) && (
										<span
											className="px-1 rounded"
											style={{
												background: "rgba(34,197,94,0.08)",
												color: "#4ade80",
											}}
										>
											已推送
										</span>
									)}
									{r.error && (
										<span style={{ color: "#f87171" }}>{formatRecordError(r)}</span>
									)}
								</div>
							</div>
							{/* 详情入口：与整行 onClick 同效，给习惯找按钮的用户 */}
							<button
								onClick={() => openRecordDetail(r.id, "records")}
								className="text-[10px] px-2 py-1 rounded border cursor-pointer flex-shrink-0 self-center"
								style={{
									background: "var(--surface)",
									borderColor: "var(--hairline)",
									color: "var(--text-secondary)",
								}}
							>
								详情
							</button>
						</div>
					))}
				</div>
			)}

			{/* 加载更早：窗口内打满单次上限时展示，向前扩一个周期窗口重拉 */}
			{canLoadEarlier && filtered.length > 0 && (
				<button
					onClick={loadEarlier}
					data-testid="execution-records-load-earlier"
					className="w-full text-[10px] py-1.5 rounded border cursor-pointer"
					style={{
						background: "var(--surface-hover)",
						borderColor: "var(--hairline)",
						color: "var(--text-secondary)",
					}}
				>
					加载更早记录
				</button>
			)}
		</div>
	);
}
