import { useState, type CSSProperties } from "react";
import { useTranslation } from "../../i18n/useTranslation";
import { type SkillScope } from "../../store/skills";

/** 范围筛选下拉：全部 / 🌐 全局技能 / 📁 各项目（样式与交互对照记忆页的 MemoryScopeDropdown） */
export function SkillScopeDropdown({
	scope,
	selectedProjectId,
	projects,
	onSelect,
}: {
	scope: SkillScope;
	selectedProjectId: string | null;
	projects: { id: string; name: string }[];
	onSelect: (scope: SkillScope, projectId?: string) => void;
}) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const current = projects.find((p) => p.id === selectedProjectId);
	const label =
		scope === "all"
			? t("settings.skill.scopeAll")
			: scope === "global"
				? t("settings.skill.scopeGlobal")
				: current
					? t("settings.skill.scopeProjectOption", { name: current.name })
					: t("settings.skill.scopeAll");

	const itemStyle = (active: boolean): CSSProperties => ({
		color: active ? "var(--accent)" : "var(--text-primary)",
		background: active ? "var(--accent-soft)" : "transparent",
	});

	return (
		<div className="relative shrink-0">
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				className="flex items-center gap-1 text-[calc(11.5px*var(--font-scale))] px-2.5 py-1.5 rounded-md"
				style={{ background: "var(--surface)", border: "1px solid var(--hairline)" }}
				data-testid="skill-scope-select"
			>
				{label}
				<span className="text-[calc(9px*var(--font-scale))] opacity-70">▾</span>
			</button>
			{open && (
				<>
					{/* 透明遮罩：点击外部关闭菜单 */}
					<div
						className="fixed inset-0 z-10"
						data-testid="skill-scope-backdrop"
						onClick={() => setOpen(false)}
					/>
					<div
						className="absolute left-0 z-20 mt-1 py-1 rounded-md min-w-[148px] max-h-80 overflow-y-auto shadow-lg"
						style={{ background: "var(--surface)", border: "1px solid var(--hairline)" }}
						data-testid="skill-scope-menu"
					>
						<button
							type="button"
							onClick={() => {
								onSelect("all");
								setOpen(false);
							}}
							className="block w-full text-left text-[calc(11.5px*var(--font-scale))] px-3 py-1.5"
							style={itemStyle(scope === "all")}
							data-testid="skill-scope-option-all"
						>
							{t("settings.skill.scopeAll")}
						</button>
						<button
							type="button"
							onClick={() => {
								onSelect("global");
								setOpen(false);
							}}
							className="block w-full text-left text-[calc(11.5px*var(--font-scale))] px-3 py-1.5"
							style={itemStyle(scope === "global")}
							data-testid="skill-scope-option-global"
						>
							{t("settings.skill.scopeGlobal")}
						</button>
						{projects.length > 0 && (
							<div className="my-1" style={{ borderTop: "1px solid var(--hairline)" }} />
						)}
						{projects.map((p) => (
							<button
								key={p.id}
								type="button"
								onClick={() => {
									onSelect("project", p.id);
									setOpen(false);
								}}
								className="block w-full text-left text-[calc(11.5px*var(--font-scale))] px-3 py-1.5 truncate"
								style={itemStyle(scope === "project" && selectedProjectId === p.id)}
								data-testid={`skill-scope-option-project-${p.id}`}
								title={p.name}
							>
								{t("settings.skill.scopeProjectOption", { name: p.name })}
							</button>
						))}
					</div>
				</>
			)}
		</div>
	);
}
