import { useState } from "react";
import versionHistory from "../../data/version-history.json";

interface VersionEntry {
	version: string;
	date: string;
	sections: Record<string, string[]>;
}

const DEFAULT_MAX_ENTRIES = 100;

/** 分类标签颜色映射 */
const SECTION_COLORS: Record<string, string> = {
	新增: "var(--success)",
	改进: "var(--accent)",
	修复: "var(--warning)",
};

/** 版本更新历史时间线：垂直排列，最新版本默认展开，旧版本点击展开。 */
export function VersionTimeline({
	maxEntries = DEFAULT_MAX_ENTRIES,
}: {
	maxEntries?: number;
}) {
	const entries = (versionHistory as VersionEntry[]).slice(0, maxEntries);
	const [expanded, setExpanded] = useState<Set<string>>(
		() => new Set([entries[0]?.version]),
	);

	const toggle = (version: string) => {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(version)) next.delete(version);
			else next.add(version);
			return next;
		});
	};

	return (
		<div data-testid="version-timeline" className="w-full">
			{entries.map((entry, i) => {
				const isOpen = expanded.has(entry.version);
				const isLast = i === entries.length - 1;
				return (
					<div key={entry.version} className="flex gap-3">
						{/* 时间线轨道：节点圆点 + 竖线 */}
						<div className="flex flex-col items-center">
							<button
								type="button"
								data-testid={`toggle-${entry.version}`}
								onClick={() => toggle(entry.version)}
								className="w-3 h-3 rounded-full border-2 cursor-pointer mt-1 shrink-0 transition-colors"
								style={{
									background: isOpen ? "var(--accent)" : "transparent",
									borderColor: isOpen
										? "var(--accent)"
										: "var(--hairline-strong)",
								}}
								aria-label={`v${entry.version}`}
							/>
							{!isLast && (
								<div
									className="w-px flex-1 min-h-[20px]"
									style={{ background: "var(--hairline)" }}
								/>
							)}
						</div>
						{/* 版本内容 */}
						<div className="flex-1 pb-4 min-w-0">
							<button
								type="button"
								onClick={() => toggle(entry.version)}
								className="flex items-center gap-2 cursor-pointer text-left"
							>
								<span className="text-sm font-semibold text-primary">
									v{entry.version}
								</span>
								<span className="text-xs text-tertiary">{entry.date}</span>
							</button>
							{isOpen && (
								<div className="mt-1.5 space-y-2">
									{Object.entries(entry.sections).map(([category, items]) => (
										<div key={category}>
											<div
												className="text-[11px] font-medium mb-0.5"
												style={{
													color:
														SECTION_COLORS[category] ?? "var(--text-secondary)",
												}}
											>
												{category}
											</div>
											<ul className="space-y-0.5">
												{items.map((item, j) => (
													<li
														key={j}
														className="text-xs text-secondary flex gap-1.5 leading-relaxed"
													>
														<span className="text-tertiary shrink-0">•</span>
														<span>{item}</span>
													</li>
												))}
											</ul>
										</div>
									))}
								</div>
							)}
						</div>
					</div>
				);
			})}
		</div>
	);
}
