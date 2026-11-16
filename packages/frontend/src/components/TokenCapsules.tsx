import { useTranslation } from "../i18n/useTranslation";
import { fmtTok } from "../util/format";

/**
 * SessionView 顶栏的 token 数据条（本轮 / 占用 / 累计 + 旁边的缓存胶囊）。
 *
 * 为什么从 SessionView 抽出来：1138 行的组件再塞会失控；更要紧的是数值必须
 * **单独成元素**（`data-testid="token-value-*"`）——主题装饰层要把数字做成
 * 深灰方块白字（鎏金）或白字加重（战术），拼成一整条 i18n 字符串就无从下手。
 * i18n 只保留标签文案（「本轮」「占用」「累计」「缓存」），数值由本组件拼。
 *
 * 分组对齐两张设计稿：本轮/占用/累计是同一根数据条（.token-bar），
 * 缓存是旁边独立的一格（两张设计稿的 markup 都是 grp + ok 两个元素）。
 */
export interface TokenCapsulesProps {
	/** 最近一轮的 input/output 用量 */
	lastUsage?: { input: number; output: number } | null;
	/** 整会话累计（官方 stats 口径，含子代理） */
	tokenTotal?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
		main?: number;
		subagent?: number;
	} | null;
	/** 当前上下文窗口占用（官方 stats，无则不出占用/进度条） */
	contextUsage?: { used: number; total: number; ratio: number } | null;
	/** stats 未返回：在胶囊位置先占骨架，避免胶囊组晚到导致顶栏跳变 */
	skeleton?: boolean;
}

export function TokenCapsules({
	lastUsage,
	tokenTotal,
	contextUsage,
	skeleton = false,
}: TokenCapsulesProps) {
	const { t } = useTranslation();
	// 无本轮用量也没在等 stats：整个胶囊组不占位（与拆分前行为一致）
	if (!lastUsage && !skeleton) return null;

	const cacheDenom = tokenTotal
		? tokenTotal.input + tokenTotal.cacheRead + tokenTotal.cacheWrite
		: 0;
	// 向下取整到 0.1%：99.95% 显示 99.9%，不冒充 100%
	const cacheRate =
		cacheDenom > 0 ? (tokenTotal!.cacheRead / cacheDenom) * 100 : 0;
	const cacheDanger = cacheRate < 90;
	const occupancy =
		contextUsage?.used != null && contextUsage.total > 0
			? Math.max(
					Math.round(
						Math.min(contextUsage.used / contextUsage.total, 1) * 100,
					),
					2,
				)
			: null;

	return (
		<div
			className="flex flex-wrap items-center gap-x-2 gap-y-2 min-w-0 max-w-full"
			data-testid="token-capsules"
		>
			{/* 数据条：本轮 / 占用 / 累计 三格 */}
			<div className="token-bar" data-testid="token-bar">
				{lastUsage && (
					<span
						className="token-capsule token-capsule--turn"
						data-testid="token-capsule-turn"
					>
						{t("session.thisTurn")}
						<span className="token-turn-up">
							↑
							<span className="token-value" data-testid="token-value-input">
								{fmtTok(lastUsage.input)}
							</span>
						</span>
						<span className="token-turn-sep" aria-hidden="true">
							/
						</span>
						↓
						<span className="token-value" data-testid="token-value-output">
							{fmtTok(lastUsage.output)}
						</span>
					</span>
				)}
				{/* stats 未返回：占用（含进度条）/ 累计 / 缓存 三格骨架占位 */}
				{skeleton && !tokenTotal && (
					<span
						className="flex items-center gap-x-2"
						data-testid="token-capsules-skeleton"
						aria-hidden="true"
					>
						<span className="block h-[26px] w-[68px] rounded-[10px] bg-hairline animate-pulse" />
						<span className="block h-[18px] w-[56px] rounded-[10px] bg-hairline animate-pulse" />
						<span className="block h-[18px] w-[44px] rounded-[10px] bg-hairline animate-pulse" />
					</span>
				)}
				{/* 占用 + 进度条（只认官方 contextUsage，无本地估算） */}
				{occupancy != null && (
					<span className="token-capsule token-capsule--stack">
						<span className="token-occupied" data-testid="token-occupied">
							{t("session.occupied")}
							<span className="token-value" data-testid="token-value-used">
								{fmtTok(contextUsage!.used)}
							</span>
						</span>
						<span className="token-progress" data-testid="token-progress">
							<span
								className="token-progress-fill"
								style={{ width: `${occupancy}%` }}
							/>
						</span>
					</span>
				)}
				{/* 累计：独立一列；有子代理消耗时第二行拆分主/子 */}
				{tokenTotal && (
					<span
						className={`token-capsule token-capsule--total${tokenTotal.subagent ? " token-capsule--stack" : ""}`}
						data-testid="token-total"
					>
						{t("session.total")}
						<span className="token-value" data-testid="token-value-total">
							{fmtTok(tokenTotal.total)}
						</span>
						{tokenTotal.subagent ? (
							<span className="token-split" data-testid="token-split">
								{t("session.totalSplitMain", {
									main: fmtTok(
										tokenTotal.main ?? tokenTotal.total - tokenTotal.subagent,
									),
								})}{" "}
								·{" "}
								{t("session.totalSplitSub", {
									sub: fmtTok(tokenTotal.subagent),
								})}
							</span>
						) : null}
					</span>
				)}
			</div>
			{/* 缓存胶囊：整会话累计口径（主代理+子代理+warming 用量），
				数据源 tokenTotals（session:stats 的 tokens，官方/降级两路同口径） */}
			{cacheDenom > 0 && (
				<span
					className={`token-capsule token-capsule--cache${cacheDanger ? " token-capsule--cache-danger" : ""}`}
				>
					{t("session.cache")}
					<span className="token-value" data-testid="token-value-cache">
						{Math.floor(cacheRate * 10) / 10}%
					</span>
				</span>
			)}
		</div>
	);
}
