import { useState } from "react";
import { useTranslation } from "../../i18n/useTranslation";
import { Icon } from "../ui/Icon";
import { useVersionHistoryStore } from "../../store/version-history";
import {
	MAX_VERSION_ENTRIES,
	countItems,
	type VersionEntry,
} from "../../util/version-history";
import { VersionEntryBody } from "./VersionEntryBody";

/** 详情区折叠前展示的条目数（跨分类累计） */
const COLLAPSED_ITEMS = 4;

/**
 * 更新历史：左右分栏。左列是版本列表（版本号 + 日期 + 条目数，最新版带点），
 * 右列是选中版本的更新内容；条目超过 4 项时先折叠，标题行右侧「展开全部 N 项」。
 * 数据来自 useVersionHistoryStore（内置 + 缓存 + 线上合并，最多 100 条）。
 */
export function VersionTimeline({
	maxEntries = MAX_VERSION_ENTRIES,
}: {
	maxEntries?: number;
}) {
	const entries = useVersionHistoryStore((s) => s.entries).slice(0, maxEntries);
	const { t } = useTranslation();
	const [picked, setPicked] = useState<string | null>(null);
	const [expanded, setExpanded] = useState(false);

	const current: VersionEntry | null =
		entries.find((e) => e.version === picked) ?? entries[0] ?? null;

	const pick = (version: string) => {
		setPicked(version);
		setExpanded(false);
	};

	return (
		<div
			data-testid="version-timeline"
			className="flex-1 min-h-0 flex border-t border-hairline"
		>
			<div
				data-testid="version-history-list"
				className="w-[172px] shrink-0 overflow-y-auto py-2 pr-2"
			>
				{entries.map((entry, i) => {
					const active = current?.version === entry.version;
					return (
						<button
							key={entry.version}
							type="button"
							data-testid={`toggle-${entry.version}`}
							onClick={() => pick(entry.version)}
							className="block w-full text-left cursor-pointer border-l-2 rounded-r-sm py-1.5 pl-2.5 pr-2 transition-colors"
							style={{
								borderLeftColor: active ? "var(--brand)" : "transparent",
								background: active ? "var(--accent-soft)" : "transparent",
							}}
						>
							<div
								className="flex items-center gap-1.5 text-[13px] font-medium leading-tight"
								style={active ? { color: "var(--brand)" } : undefined}
							>
								{i === 0 && (
									<span
										className="w-[5px] h-[5px] rounded-full shrink-0"
										style={{ background: "var(--brand)" }}
									/>
								)}
								<span className={active ? "" : "text-primary"}>
									v{entry.version}
								</span>
							</div>
							<div className="flex justify-between gap-2 mt-0.5 text-[11px] text-tertiary">
								<span>{entry.date}</span>
								<span>{t("settings.about.itemCount", { count: countItems(entry) })}</span>
							</div>
						</button>
					);
				})}
			</div>

			{current && (
				<div
					key={current.version}
					data-testid="version-history-detail"
					className="flex-1 min-w-0 overflow-y-auto py-3 pl-4 pr-1.5"
				>
					<div className="flex items-baseline gap-2.5 mb-3">
						<span className="text-[15px] font-semibold text-primary">
							v{current.version}
						</span>
						<span className="text-xs text-tertiary">{current.date}</span>
						{countItems(current) > COLLAPSED_ITEMS ? (
							<button
								type="button"
								data-testid="expand-all"
								onClick={() => setExpanded((v) => !v)}
								className="ml-auto inline-flex items-center gap-1 cursor-pointer bg-transparent border-0 p-0 text-xs"
								style={{ color: "var(--brand)" }}
							>
								{expanded
									? t("settings.about.collapse")
									: t("settings.about.expandAll", {
											count: countItems(current),
										})}
								<Icon name={expanded ? "chevron-up" : "chevron-down"} size={12} />
							</button>
						) : (
							<span className="ml-auto text-[11px] text-tertiary">
								{t("settings.about.itemCount", { count: countItems(current) })}
							</span>
						)}
					</div>
					<VersionEntryBody
						entry={current}
						visibleLimit={expanded ? "all" : COLLAPSED_ITEMS}
					/>
				</div>
			)}
		</div>
	);
}
