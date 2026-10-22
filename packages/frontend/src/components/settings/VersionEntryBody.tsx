import { useTranslation } from "../../i18n/useTranslation";
import { sectionColor, type VersionEntry } from "../../util/version-history";

/**
 * 单个版本的更新内容：按分类分组（彩色标签 + 条目圆点）。
 * visibleLimit = "all" 时全量渲染；数字时只渲染前 N 条（跨分类累计），
 * 供「关于」页把长版本折叠成「展开全部 N 项」。
 */
export function VersionEntryBody({
	entry,
	visibleLimit = "all",
}: {
	entry: VersionEntry;
	visibleLimit?: number | "all";
}) {
	const { t } = useTranslation();
	let shown = 0;
	return (
		<>
			{Object.entries(entry.sections).map(([category, items]) => {
				if (!items || !items.length) return null;
				const visible =
					visibleLimit === "all"
						? items
						: items.slice(0, Math.max(0, visibleLimit - shown));
				shown += visible.length;
				if (!visible.length) return null;
				const color = sectionColor(category);
				return (
					<div key={category} className="mb-3.5 last:mb-0">
						<div className="flex items-center gap-2 mb-1.5">
							<span
								className="text-[11px] font-medium px-2 py-px rounded-full"
								style={{ color: color.fg, background: color.bg }}
							>
								{category}
							</span>
							<span className="text-[11px] text-tertiary">
								{t("settings.about.itemCount", { count: items.length })}
							</span>
						</div>
						<ul className="space-y-0.5">
							{visible.map((item, i) => (
								<li
									key={i}
									className="flex gap-2 text-[13px] leading-relaxed text-secondary"
								>
									<span
										className="w-1 h-1 rounded-full shrink-0 mt-[9px]"
										style={{ background: color.fg }}
									/>
									<span>{item}</span>
								</li>
							))}
						</ul>
					</div>
				);
			})}
		</>
	);
}
