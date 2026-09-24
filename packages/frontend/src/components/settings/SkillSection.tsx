import { useState } from "react";
import { useTranslation } from "../../i18n/useTranslation";
import { filterSkillsByScope, useSkillsStore } from "../../store/skills";
import { useProjectsStore } from "../../store/projects";
import { SkillScopeDropdown } from "./SkillScopeDropdown";
import type { SkillInfo, SkillSourceType } from "@wa-pi/shared";

export function SkillSection() {
	const {
		allSkills,
		dirs,
		disabledSkills,
		builtinDir,
		skillScope,
		selectedProjectId,
		toggleSkill,
		setSkillScope,
		load,
	} = useSkillsStore();
	// 项目列表与记忆页同源，避免在技能 store 内重复存储
	const projects = useProjectsStore((s) => s.projects);
	const { t } = useTranslation();
	const [dirExpanded, setDirExpanded] = useState(true);
	const [expandedSkills, setExpandedSkills] = useState<Set<string>>(new Set());
	const [search, setSearch] = useState("");

	/** 来源大类：builtin → 全局；project → 项目；extension → Plugin */
	const sourceKindOf = (
		source?: { type: SkillSourceType },
	): "global" | "project" | "extension" => {
		if (source?.type === "extension") return "extension";
		if (source?.type === "project") return "project";
		return "global";
	};

	/** 来源标签：全局 skill / 项目 skill（项目名）/ Plugin skill（包名） */
	const sourceLabel = (skill: SkillInfo): string => {
		const kind = sourceKindOf(skill.source);
		if (kind === "extension")
			return t("settings.skill.sourcePluginName", {
				name: skill.source?.name ?? "",
			});
		if (kind === "project")
			return t("settings.skill.sourceProjectName", {
				name: skill.source?.projectName ?? "",
			});
		return t("settings.skill.sourceGlobal");
	};

	const toggleExpand = (name: string) => {
		setExpandedSkills((prev) => {
			const next = new Set(prev);
			next.has(name) ? next.delete(name) : next.add(name);
			return next;
		});
	};

	// 范围过滤（消费 allSkills：被禁用技能仍列出并标注「禁用」）→ 再按名称搜索
	const keyword = search.trim().toLowerCase();
	const scoped = filterSkillsByScope(allSkills, skillScope, selectedProjectId);
	const filteredSkills = keyword
		? scoped.filter((s) => s.name.toLowerCase().includes(keyword))
		: scoped;

	// 分组：全局技能 / 各项目技能（仅显示有内容者）/ Plugin 技能
	const globalSkills = filteredSkills.filter(
		(s) => sourceKindOf(s.source) === "global",
	);
	const pluginSkills = filteredSkills.filter(
		(s) => sourceKindOf(s.source) === "extension",
	);
	const projectGroups = projects
		.map((p) => ({
			project: p,
			items: filteredSkills.filter(
				(s) => s.source?.type === "project" && s.source.projectId === p.id,
			),
		}))
		.filter((g) => g.items.length > 0);

	const groups: { key: string; label: string; items: SkillInfo[] }[] = [
		{ key: "global", label: t("settings.skill.groupGlobal"), items: globalSkills },
		...projectGroups.map((g) => ({
			key: `project:${g.project.id}`,
			label: t("settings.skill.groupProjectWithName", { name: g.project.name }),
			items: g.items,
		})),
		{
			key: "extension",
			label: t("settings.skill.groupExtension"),
			items: pluginSkills,
		},
	].filter((g) => g.items.length > 0);

	return (
		<div className="flex flex-col gap-3 p-4 overflow-auto">
			{/* 技能目录（上方，默认展开）：只读展示路径与范围，仅保留「打开文件夹」 */}
			<div className="flex flex-col gap-1">
				<div
					className="flex items-center justify-between"
					data-testid="skill-dir-header"
				>
					<button
						onClick={() => setDirExpanded(!dirExpanded)}
						className="flex items-center gap-2 text-sm text-primary text-left"
						data-testid="skill-dir-toggle"
					>
						<span>
							{t("settings.skill.dirTitle")}
							{!dirExpanded ? `：${builtinDir}` : ""}
						</span>
						<span>{dirExpanded ? "▾" : "▸"}</span>
					</button>
					<div className="flex items-center gap-1">
						{/* 范围筛选与刷新同行（范围选择器在刷新按钮左侧），搜索框独立在下一行 */}
						<SkillScopeDropdown
							scope={skillScope}
							selectedProjectId={selectedProjectId}
							projects={projects}
							onSelect={setSkillScope}
						/>
						<button
							onClick={() => load()}
							className="p-1 text-secondary hover:text-primary"
							title={t("settings.skill.refresh")}
							aria-label={t("settings.skill.refresh")}
							data-testid="skill-refresh-btn"
						>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="14"
								height="14"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
							>
								<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
								<path d="M21 3v5h-5" />
								<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
								<path d="M8 16H3v5" />
							</svg>
						</button>
					</div>
				</div>

				{dirExpanded && (
					<div className="flex flex-col gap-1 pl-4">
						{dirs.map((d) => (
							<div
								key={d.path}
								className="flex items-center justify-between py-1 gap-2"
							>
								<span className="text-sm text-secondary truncate">{d.path}</span>
								<div className="flex items-center gap-1 shrink-0">
									<button
										onClick={() =>
											void window.waPiApp?.showItemInFolder?.(d.path)
										}
										className="p-1 text-secondary hover:text-primary"
										title={t("settings.skill.openDir")}
										aria-label={t("settings.skill.openDir")}
										data-testid={`skill-dir-open-${d.path}`}
									>
										<svg
											xmlns="http://www.w3.org/2000/svg"
											width="14"
											height="14"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											strokeWidth="2"
											strokeLinecap="round"
											strokeLinejoin="round"
										>
											<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
										</svg>
									</button>
									<span className="text-xs text-tertiary">
										{d.type === "builtin"
											? t("settings.skill.dirTagGlobal")
											: t("settings.skill.dirTagNamed", {
													name: d.projectName ?? d.name ?? "",
												})}
									</span>
								</div>
							</div>
						))}
					</div>
				)}
			</div>

			{/* 工具栏：搜索框（范围筛选已移到上面的技能目录行） */}
			<div className="flex flex-col gap-2">
				<input
					type="text"
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					placeholder={t("settings.skill.searchPlaceholder")}
					className="px-2 py-1 text-sm text-primary bg-transparent border border-hairline rounded-sm outline-none"
					data-testid="skill-search-input"
				/>
			</div>

			{/* 技能分组列表 */}
			{allSkills.length === 0 && (
				<span className="text-sm text-tertiary py-2">
					{t("settings.skill.empty")}
				</span>
			)}
			{allSkills.length > 0 && filteredSkills.length === 0 && (
				<span className="text-sm text-tertiary py-2">
					{t("settings.skill.noMatch")}
				</span>
			)}

			{groups.map((group) => (
				<div key={group.key} className="flex flex-col gap-1">
					{/* 分组标题 */}
					<div className="text-xs font-bold text-secondary tracking-wide border-b border-hairline pb-1 mb-1">
						{group.label} {t("settings.skill.itemCount", { count: group.items.length })}
					</div>

					{group.items.map((skill) => {
						const disabled = disabledSkills.includes(skill.name);
						const expanded = expandedSkills.has(skill.name);

						return (
							<div
								key={skill.name}
								className="flex flex-col py-1.5 select-none"
								style={{ opacity: disabled ? 0.5 : 1 }}
								data-testid={`skill-row-${skill.name}`}
							>
								{/* 行头部：名称 + 标签 + 展开箭头（左）| switch 开关（右） */}
								<div
									className="flex items-center gap-2 cursor-pointer"
									onClick={() => toggleExpand(skill.name)}
								>
									<span className="text-sm font-semibold text-primary">
										{skill.name}
									</span>
									<span
										className="text-[calc(10px*var(--font-scale))] px-1.5 py-0.5 rounded-full"
										style={{
											background: "var(--hairline)",
											color: "var(--text-tertiary)",
										}}
									>
										{sourceLabel(skill)}
									</span>
									{disabled && (
										<span
											className="text-[calc(10px*var(--font-scale))] font-semibold"
											style={{ color: "var(--danger)" }}
										>
											{t("settings.skill.disabled")}
										</span>
									)}
									<span className="text-xs text-tertiary flex-1">
										{expanded ? "▾" : "▸"}
									</span>

									{/* switch 开关，最右侧 */}
									<div
										onClick={(e) => {
											e.stopPropagation();
											toggleSkill(skill.name);
										}}
										className="relative shrink-0 cursor-pointer"
										style={{
											width: 38,
											height: 22,
											borderRadius: 9999,
											background: disabled ? "var(--hairline-strong)" : "var(--brand)",
											transition: "background 0.2s",
										}}
										data-testid={`skill-switch-${skill.name}`}
										data-on={disabled ? "false" : "true"}
									>
										<span
											className="absolute top-0.5 rounded-full bg-white transition-all"
											style={{
												width: 18,
												height: 18,
												left: disabled ? 2 : undefined,
												right: disabled ? undefined : 2,
												boxShadow: "0 1px 2px rgba(0,0,0,.1)",
											}}
										/>
									</div>
								</div>

								{/* 描述 */}
								{expanded && skill.description && (
									<div className="pl-0 pt-1">
										<span className="text-[calc(11px*var(--font-scale))] text-tertiary">
											{skill.description}
										</span>
									</div>
								)}
							</div>
						);
					})}
				</div>
			))}
		</div>
	);
}
