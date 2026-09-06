import { useCallback, useEffect, useMemo, useState } from "react";
import {
	layoutGitLanes,
	type GitCommitInfo,
	type GitGraphRow,
	type GitRef,
} from "@wa-pi/shared";
import { useTranslation } from "../../i18n/useTranslation";
import { useGitStore } from "../../store/git";
import { Modal } from "../ui/Modal";
import { Icon } from "../ui/Icon";

interface Props {
	projectId: string;
	onClose: () => void;
}

// 泳道调色板（按 layoutGitLanes 返回的 color 索引取模）
const LANE_COLORS = [
	"#4f8ef7",
	"#f7744f",
	"#3fbf7f",
	"#b06ef7",
	"#e8b93f",
	"#4fc3d4",
	"#ef6aa5",
];

const ROW_H = 28;
const LANE_W = 14;
/** 首屏条数 / 每次「加载更多」增量 */
const PAGE_SIZE = 200;

/** ISO 日期 → MM/DD HH:mm（本地时区） */
export function formatCommitDate(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const laneColor = (i: number) => LANE_COLORS[i % LANE_COLORS.length];

/** 单行泳道 SVG：圆点 + 竖线 + 分叉/合并斜线 */
function GraphCell({ row }: { row: GitGraphRow }) {
	const x = (lane: number) => lane * LANE_W + LANE_W / 2;
	const width = Math.max(row.laneCount, row.lane + 1) * LANE_W;
	return (
		<svg
			data-testid="git-graph-svg"
			width={width}
			height={ROW_H}
			className="block flex-none"
			aria-hidden="true"
		>
			{/* 竖直延续线（整条泳道贯穿本行，节点圆点盖在上面） */}
			{row.verticals.map((v, i) => (
				<line
					key={`v${i}`}
					x1={x(v.fromLane)}
					y1={0}
					x2={x(v.toLane)}
					y2={ROW_H}
					stroke={laneColor(v.color)}
					strokeWidth={1.5}
				/>
			))}
			{/* 斜线：并入节点泳道的从上方下来；分支出新泳道的向下方走去 */}
			{row.curves.map((c, i) =>
				c.toLane === row.lane ? (
					<line
						key={`c${i}`}
						x1={x(c.fromLane)}
						y1={0}
						x2={x(c.toLane)}
						y2={ROW_H / 2}
						stroke={laneColor(c.color)}
						strokeWidth={1.5}
					/>
				) : (
					<line
						key={`c${i}`}
						x1={x(c.fromLane)}
						y1={ROW_H / 2}
						x2={x(c.toLane)}
						y2={ROW_H}
						stroke={laneColor(c.color)}
						strokeWidth={1.5}
					/>
				),
			)}
			<circle
				cx={x(row.lane)}
				cy={ROW_H / 2}
				r={4}
				fill={laneColor(row.color)}
			/>
		</svg>
	);
}

/** 描述列装饰 chip：HEAD 高亮、分支普通、tag 不同底色、origin/* 弱化 */
function RefChip({ r }: { r: GitRef }) {
	const cls =
		r.kind === "head"
			? "border border-accent text-accent"
			: r.kind === "tag"
				? "bg-warning-soft text-warning border border-warning-soft"
				: r.kind === "remote"
					? "border border-hairline text-tertiary"
					: "bg-surface-hover text-secondary border border-hairline";
	return (
		<span
			className={`inline-block rounded-pill px-1.5 py-px text-[calc(10px*var(--font-scale))] ${cls}`}
		>
			{r.name}
		</span>
	);
}

/**
 * Git 图谱模态弹窗：标题栏（刷新/关闭）+ 五列表格（图|描述|日期|作者|提交）。
 * 首屏拉 200 条，「加载更多」每次 +200（返回数不足 limit 视为没有更多）。
 */
export function GitGraphModal({ projectId, onClose }: Props) {
	const { t } = useTranslation();
	const [commits, setCommits] = useState<GitCommitInfo[]>([]);
	const [limit, setLimit] = useState(PAGE_SIZE);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(
		async (n: number) => {
			setLoading(true);
			setError(null);
			try {
				setCommits(await useGitStore.getState().loadLog(projectId, n));
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			} finally {
				setLoading(false);
			}
		},
		[projectId],
	);

	useEffect(() => {
		void load(limit);
	}, [load, limit]);

	// 泳道布局按提交列表一次性计算（输入已是时间倒序）
	const rows = useMemo(() => layoutGitLanes(commits), [commits]);
	const rowByHash = useMemo(
		() => new Map(rows.map((r) => [r.hash, r])),
		[rows],
	);
	// 返回数达到 limit 说明可能还有更多
	const hasMore = commits.length >= limit;

	return (
		<Modal onClose={onClose} width={880} data-testid="git-graph-modal">
			{/* 标题栏 */}
			<div className="p-3 px-4 border-b border-hairline flex items-center gap-2">
				<Icon name="gitGraph" size={14} className="text-secondary" />
				<div className="text-primary font-bold text-sm flex-1">
					{t("git.graph")}
				</div>
				<button
					data-testid="git-graph-refresh"
					onClick={() => void load(limit)}
					className="text-tertiary hover:text-primary transition-colors"
					aria-label={t("common.reload")}
				>
					<Icon name="refresh" size={13} />
				</button>
				<button
					data-testid="git-graph-close"
					onClick={onClose}
					className="text-tertiary hover:text-primary transition-colors text-xs"
					aria-label={t("common.close")}
				>
					✕
				</button>
			</div>
			{/* 内容区 */}
			<div className="flex-1 overflow-auto" style={{ maxHeight: "70vh" }}>
				{error ? (
					<div className="p-6 text-center text-danger text-sm">{error}</div>
				) : loading && commits.length === 0 ? (
					<div className="p-6 text-center text-tertiary text-sm">
						{t("common.loading")}
					</div>
				) : commits.length === 0 ? (
					<div className="p-6 text-center text-tertiary text-sm">
						{t("git.logEmpty")}
					</div>
				) : (
					<table className="w-full text-[calc(12px*var(--font-scale))]">
						<thead>
							<tr className="text-tertiary text-left border-b border-hairline">
								<th className="px-3 py-1.5 font-normal">{t("git.colGraph")}</th>
								<th className="px-3 py-1.5 font-normal">{t("git.colDesc")}</th>
								<th className="px-3 py-1.5 font-normal">{t("git.colDate")}</th>
								<th className="px-3 py-1.5 font-normal">{t("git.colAuthor")}</th>
								<th className="px-3 py-1.5 font-normal">{t("git.colCommit")}</th>
							</tr>
						</thead>
						<tbody>
							{commits.map((c) => {
								const row = rowByHash.get(c.hash);
								return (
									<tr
										key={c.hash}
										data-testid={`git-log-row-${c.hash.slice(0, 7)}`}
										className="border-b border-hairline"
									>
										<td className="px-3 py-0 align-middle">
											{row && <GraphCell row={row} />}
										</td>
										<td className="px-3 py-1 align-middle max-w-0">
											<div className="flex items-center gap-1 min-w-0">
												{c.refs.length > 0 && (
													<span className="flex items-center gap-1 flex-none">
														{c.refs.map((r, i) => (
															<RefChip key={`${r.kind}-${r.name}-${i}`} r={r} />
														))}
													</span>
												)}
												<span className="text-primary truncate">
													{c.subject}
												</span>
											</div>
										</td>
										<td className="px-3 py-1 align-middle text-secondary whitespace-nowrap">
											{formatCommitDate(c.date)}
										</td>
										<td className="px-3 py-1 align-middle text-secondary">
											{c.author}
										</td>
										<td className="px-3 py-1 align-middle text-tertiary font-mono">
											{c.hash.slice(0, 7)}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				)}
			</div>
			{/* 底部加载更多 */}
			{!error && hasMore && commits.length > 0 && (
				<div className="p-2 border-t border-hairline flex justify-center">
					<button
						onClick={() => setLimit((n) => n + PAGE_SIZE)}
						disabled={loading}
						className="px-3 py-1 rounded-sm text-[calc(12px*var(--font-scale))] bg-surface-hover text-secondary border border-hairline transition-colors hover:text-primary disabled:opacity-50"
					>
						{t("git.loadMore")}
					</button>
				</div>
			)}
		</Modal>
	);
}
