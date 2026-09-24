import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { SYSTEM_PROJECT_ID, SYSTEM_PROJECT_NAME } from "@wa-pi/shared";
import { useTranslation } from "../../i18n/useTranslation";

/** 菜单与按钮的间距、距视口边缘的留白、菜单最大高度（与旧 max-h-80 一致） */
const MENU_GAP = 4;
const VIEWPORT_PAD = 8;
const MENU_MAX_H = 320;
/** 菜单最小宽度，与 class 里的 min-w-[148px] 保持一致 */
const MENU_MIN_W = 148;

/** 选中项目下拉：默认工作区在最前，其后按项目顺序列出各项目（样式与交互对照记忆页的 MemoryScopeDropdown） */
export function SkillScopeDropdown({
	selectedProjectId,
	projects,
	onSelect,
}: {
	selectedProjectId: string;
	projects: { id: string; name: string }[];
	onSelect: (projectId: string) => void;
}) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const btnRef = useRef<HTMLButtonElement | null>(null);
	const menuRef = useRef<HTMLDivElement | null>(null);
	// 选项：默认工作区排最前，其后按项目顺序；默认工作区不在项目列表时也保留该项
	const systemProject = projects.find((p) => p.id === SYSTEM_PROJECT_ID);
	const options = systemProject
		? [systemProject, ...projects.filter((p) => p.id !== SYSTEM_PROJECT_ID)]
		: [{ id: SYSTEM_PROJECT_ID, name: SYSTEM_PROJECT_NAME }, ...projects];
	const current = projects.find((p) => p.id === selectedProjectId);
	const label = t("settings.skill.scopeProjectOption", {
		name: current?.name ?? SYSTEM_PROJECT_NAME,
	});

	const itemStyle = (active: boolean): CSSProperties => ({
		color: active ? "var(--accent)" : "var(--text-primary)",
		background: active ? "var(--accent-soft)" : "transparent",
	});

	// 定位：菜单与遮罩经 portal 挂到 body 并改 fixed——照旧挂在按钮的 relative 包裹层里做
	// absolute，会被「技能目录」行所在的 SkillSection 根容器（overflow-auto）裁切，并把该容器
	// 撑出滚动条（用户报「只露出上半截 + 出现滚动条」）。口径与 AgentDropdown / DatePickerButton
	// 一致：贴按钮左缘向下展开，底部空间不足向上翻转，水平溢出时夹到视口内，超出部分菜单内滚动。
	const positionMenu = useCallback(() => {
		const btn = btnRef.current;
		const menu = menuRef.current;
		if (!btn || !menu) return;
		const br = btn.getBoundingClientRect();
		// 未布局（测试环境 / 首帧零尺寸）不定位，避免把菜单钉到左上角
		if (br.width === 0 && br.height === 0) return;
		// 宽度不小于按钮宽度（class 的 min-w 为下限，按钮更宽时按按钮宽度撑开）
		menu.style.minWidth = br.width > MENU_MIN_W ? `${br.width}px` : "";
		// 先按「按钮下方」占位量一次菜单自然高度，再据此决定翻转与限高
		menu.style.maxHeight = "none";
		menu.style.left = `${br.left}px`;
		menu.style.top = `${br.bottom + MENU_GAP}px`;
		const mr = menu.getBoundingClientRect();
		const spaceBelow = window.innerHeight - br.bottom - MENU_GAP - VIEWPORT_PAD;
		const spaceAbove = br.top - MENU_GAP - VIEWPORT_PAD;
		const needH = Math.min(mr.height, MENU_MAX_H);
		let avail = spaceBelow;
		let top = br.bottom + MENU_GAP;
		// 下方空间不够且上方更宽裕 → 向上翻转（贴按钮上方）
		if (spaceBelow < needH && spaceAbove > spaceBelow) {
			avail = spaceAbove;
			top = br.top - MENU_GAP - Math.min(needH, Math.max(0, avail));
		}
		menu.style.top = `${Math.max(VIEWPORT_PAD, top)}px`;
		// 可用空间与 320px 取小，超出时菜单自身滚动（overflow-y-auto）
		menu.style.maxHeight = `${Math.max(0, Math.min(MENU_MAX_H, avail))}px`;
		// 水平夹取到视口内：右溢出左移，仍溢出则贴左缘
		const width = menu.getBoundingClientRect().width;
		let left = br.left;
		if (left + width > window.innerWidth - VIEWPORT_PAD) {
			left = window.innerWidth - VIEWPORT_PAD - width;
		}
		menu.style.left = `${Math.max(VIEWPORT_PAD, left)}px`;
	}, []);

	// 打开即定位；resize 与任意容器滚动（capture）都重算——fixed 浮层不跟随滚动锚点
	useLayoutEffect(() => {
		if (!open) return;
		positionMenu();
		const onScroll = (ev: Event) => {
			// 菜单自身滚动（maxHeight 兜底触发）不重算，否则滚动位置会被重排打断
			const target = ev.target as Node | null;
			if (target instanceof Node && menuRef.current?.contains(target)) return;
			positionMenu();
		};
		window.addEventListener("resize", onScroll);
		window.addEventListener("scroll", onScroll, true);
		return () => {
			window.removeEventListener("resize", onScroll);
			window.removeEventListener("scroll", onScroll, true);
		};
	}, [open, positionMenu]);

	// ESC 关闭；点击菜单外部关闭由遮罩负责（行为与改造前一致）
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open]);

	return (
		<div className="relative shrink-0">
			<button
				type="button"
				ref={btnRef}
				aria-expanded={open}
				onClick={() => setOpen((o) => !o)}
				className="flex items-center gap-1 text-[calc(11.5px*var(--font-scale))] px-2.5 py-1.5 rounded-md"
				style={{ background: "var(--surface)", border: "1px solid var(--hairline)" }}
				data-testid="skill-scope-select"
			>
				{label}
				<span className="text-[calc(9px*var(--font-scale))] opacity-70">▾</span>
			</button>
			{open &&
				createPortal(
					<>
						{/* 透明遮罩：点击外部关闭菜单。与菜单一并挂到 body，层级需高于设置弹窗遮罩(z-50) */}
						<div
							className="fixed inset-0"
							style={{ zIndex: 60 }}
							data-testid="skill-scope-backdrop"
							onClick={() => setOpen(false)}
						/>
						<div
							ref={menuRef}
							// 初始藏屏外，布局 effect 按按钮矩形定位（防首帧闪一下左上角）；测试环境（零尺寸）不定位
							style={{
								left: -9999,
								top: -9999,
								background: "var(--surface)",
								border: "1px solid var(--hairline)",
								zIndex: 70,
							}}
							className="fixed py-1 rounded-md min-w-[148px] overflow-y-auto shadow-lg"
							data-testid="skill-scope-menu"
						>
							{options.map((p) => (
								<button
									key={p.id}
									type="button"
									onClick={() => {
										onSelect(p.id);
										setOpen(false);
									}}
									className="block w-full text-left text-[calc(11.5px*var(--font-scale))] px-3 py-1.5 truncate"
									style={itemStyle(selectedProjectId === p.id)}
									data-testid={`skill-scope-option-project-${p.id}`}
									title={p.name}
								>
									{t("settings.skill.scopeProjectOption", { name: p.name })}
								</button>
							))}
						</div>
					</>,
					document.body,
				)}
		</div>
	);
}
