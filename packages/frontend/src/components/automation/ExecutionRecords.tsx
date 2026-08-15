import { useState, useEffect } from "react";
import { useSchedulerStore } from "../../store/scheduler";

/**
 * 执行记录列表：顶部筛选栏（按天/周/月 + 任务筛选 + 状态筛选）+ 记录卡片。
 * 挂载时拉取全部执行记录，按选定条件过滤后渲染。
 */
export function ExecutionRecords() {
	const { tasks, records, loadRecords, openRecordDetail } = useSchedulerStore();
	const [period, setPeriod] = useState<"day" | "week" | "month">("day");
	const [taskFilter, setTaskFilter] = useState("");
	const [statusFilter, setStatusFilter] = useState("");

	useEffect(() => {
		loadRecords();
	}, [loadRecords]);

	let filtered = records;
	if (taskFilter) filtered = filtered.filter((r) => r.taskId === taskFilter);
	if (statusFilter)
		filtered = filtered.filter((r) => r.status === statusFilter);

	// 时间过滤
	const now = Date.now();
	const periodMs =
		period === "day" ? 86400000 : period === "week" ? 604800000 : 2592000000;
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
								color:
									period === k ? "var(--text-primary)" : "var(--text-tertiary)",
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
									background:
										r.status === "success"
											? "rgba(34,197,94,0.1)"
											: r.status === "failed"
												? "rgba(239,68,68,0.1)"
												: "rgba(59,130,246,0.1)",
									color:
										r.status === "success"
											? "#4ade80"
											: r.status === "failed"
												? "#f87171"
												: "#60a5fa",
								}}
							>
								{r.status === "success"
									? "✓"
									: r.status === "failed"
										? "✕"
										: "⟳"}
							</div>
							<div className="flex-1">
								<div
									className="text-xs"
									style={{ color: "var(--text-primary)" }}
								>
									{r.taskName}
								</div>
								<div
									className="text-[10px] flex gap-2 mt-0.5"
									style={{ color: "var(--text-tertiary)" }}
								>
									<span>{new Date(r.startedAt).toLocaleString("zh-CN")}</span>
									{r.durationMs && (
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
											📨 已推送
										</span>
									)}
									{r.error && (
										<span style={{ color: "#f87171" }}>{r.error}</span>
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
		</div>
	);
}
