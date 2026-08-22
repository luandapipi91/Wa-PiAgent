import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentConfig, AgentName } from "@wa-pi/shared";
import { useTranslation } from "../../i18n/useTranslation";
import { filterItems } from "../../quick-invoke/trigger";
import { AgentMenuItem } from "./AgentMenuItem";

interface Props {
	agents: AgentConfig[];
	value: AgentName | null;
	onPick: (name: AgentName) => void;
	/** value 在 agents 中找不到（已删除）时 pill 显示警示态 */
	missing?: boolean;
	placeholder?: string;
	/** 列表顶部固定的「默认」项文案（如不绑定具体智能体的场景）；点击回调 onPick("" as AgentName) */
	defaultLabel?: string;
	/** pill 按钮的 testid，默认 "agent-select" */
	pillTestId?: string;
	/** 搜索框/列表项 testid 前缀，默认 "agent"（衍生 ${prefix}-search / ${prefix}-item-${name} / ${prefix}-missing） */
	itemTestIdPrefix?: string;
}

/**
 * 智能体选择下拉（pill 按钮 + 搜索框 + 列表）。
 * 纯展示受控组件：不读 session、不发 WS、不弹确认框。
 * 用于 NewSessionPane（新建会话选智能体）与 AgentSwitcher（复用同一 UI，外层包确认框）。
 * 列表项渲染复用 AgentMenuItem，与 QuickInvokeMenu 的 @ 智能体弹窗视觉一致。
 *
 * 菜单经 createPortal 挂到 body（fixed z-50）：逃逸 Modal/滚动容器的 overflow 裁剪
 * （如新建任务弹窗内的执行角色选择）；底部空间不足时向上翻转。
 */
export function AgentDropdown({
	agents,
	value,
	onPick,
	missing = false,
	placeholder,
	defaultLabel,
	pillTestId = "agent-select",
	itemTestIdPrefix = "agent",
}: Props) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const rootRef = useRef<HTMLDivElement>(null);
	const pillRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const { t } = useTranslation();

	const toggleOpen = () => {
		setOpen((o) => !o);
		setQuery("");
	};

	const closeMenu = () => {
		setOpen(false);
		setQuery("");
	};

	// 定位：按 pill 按钮矩形固定定位（fixed + portal），底部溢出向上翻转 + 水平视口钳制。
	// 每次渲染后执行（open/query 变化引起菜单高度变化时重算），幂等。
	useLayoutEffect(() => {
		if (!open || !menuRef.current || !pillRef.current) return;
		const m = menuRef.current;
		const pr = pillRef.current.getBoundingClientRect();
		if (pr.width === 0 && pr.height === 0) return; // 未布局（测试环境）不定位
		m.style.left = `${pr.left}px`;
		m.style.top = `${pr.bottom + 4}px`;
		const r = m.getBoundingClientRect();
		if (r.width === 0 && r.height === 0) return;
		// 底部空间不足 → 向上翻转（贴 pill 顶部）
		if (pr.bottom + 4 + r.height > window.innerHeight - 8) {
			m.style.top = `${Math.max(8, pr.top - r.height - 4)}px`;
		}
		// 水平钳制：右溢出左移，仍溢出则贴左缘
		if (pr.left + r.width > window.innerWidth - 8) {
			m.style.left = `${Math.max(8, window.innerWidth - 8 - r.width)}px`;
		}
	});

	// 点击组件外部关闭下拉（菜单已 portal 到 body，不在 rootRef 子树内，需单独判 menuRef）
	useEffect(() => {
		if (!open) return;
		const onDown = (ev: MouseEvent) => {
			const t = ev.target as Node;
			if (rootRef.current?.contains(t) || menuRef.current?.contains(t)) return;
			setOpen(false);
		};
		window.addEventListener("mousedown", onDown);
		return () => window.removeEventListener("mousedown", onDown);
	}, [open]);

	// 滚动关闭：fixed 浮层不跟随外部滚动容器（弹窗内容区滚动会脱锚）→ 关闭；
	// 但菜单自身内部列表滚动（max-h overflow-y-auto）不关闭——否则滚不动列表，一滚就收起
	useEffect(() => {
		if (!open) return;
		const onScroll = (ev: Event) => {
			const t = ev.target as Node | null;
			// scroll 事件 target 为滚动容器；菜单内部（含列表）滚动不关闭
			if (t instanceof Node && menuRef.current?.contains(t)) return;
			closeMenu();
		};
		window.addEventListener("scroll", onScroll, true); // 捕获阶段：任意滚动容器都触发
		return () => window.removeEventListener("scroll", onScroll, true);
	}, [open]);

	const current = agents.find((a) => a.displayName === value);
	const showMissing = missing || (!current && !!value);
	// 按 displayName（用户可见名称）+ description 过滤；filterItems 默认取 item.name，故映射为 displayName
	const filtered = filterItems(
		agents.map((a) => ({
			agent: a,
			name: a.displayName,
			description: a.description,
		})),
		query,
	).map(({ agent }) => agent);

	const handlePick = (name: AgentName) => {
		// 选择当前项：不触发 onPick，直接关闭
		if (name === value) {
			closeMenu();
			return;
		}
		onPick(name);
		closeMenu();
	};
	// 固定「默认」项：仅在未搜索或命中搜索词时显示
	const showDefault =
		!!defaultLabel &&
		(!query || defaultLabel.toLowerCase().includes(query.toLowerCase()));

	return (
		<div className="relative min-w-0 max-w-full" ref={rootRef}>
			<button
				type="button"
				ref={pillRef}
				data-testid={pillTestId}
				onClick={toggleOpen}
				className={`min-w-0 w-full flex items-center gap-1.5 rounded-pill border px-2.5 py-1 text-[calc(12px*var(--font-scale))] cursor-pointer transition-colors ${
					showMissing
						? "bg-warning-soft text-warning border-warning-soft"
						: "bg-surface-elevated text-secondary border-hairline hover:text-primary"
				}`}
			>
				{showMissing ? (
					<span data-testid={`${itemTestIdPrefix}-missing`} className="truncate">
						{t("ui.agentDropdown.missingHint")}
					</span>
				) : current ? (
					<>
						<span
							className="w-[18px] h-[18px] rounded-sm flex items-center justify-center text-[calc(11px*var(--font-scale))] flex-none"
							style={{
								background: current.avatarColor?.includes("-")
									? `linear-gradient(135deg, ${current.avatarColor
											.split("-")
											.map((s) => s.trim())
											.join(", ")})`
									: current.avatarColor || undefined,
							}}
						>
							{current.avatar}
						</span>
						<span className="max-w-[180px] truncate">{current.displayName}</span>
						<span
							className="ml-auto flex-none"
							style={{ fontSize: "calc(10px * var(--font-scale))" }}
						>
							▾
						</span>
					</>
				) : (
					<>
						<span className="text-tertiary">
							{placeholder ?? t("ui.agentDropdown.placeholderDefault")}
						</span>
						<span
							className="ml-auto flex-none"
							style={{ fontSize: "calc(10px * var(--font-scale))" }}
						>
							▾
						</span>
					</>
				)}
			</button>

			{open &&
				createPortal(
					<div
						ref={menuRef}
						data-testid={`${itemTestIdPrefix}-menu`}
						// 初始藏屏外，布局 effect 按 pill 矩形定位（防闪烁）；测试环境（零尺寸）不定位
						style={{ left: -9999, top: -9999 }}
						className="fixed z-50 min-w-[220px] max-w-[calc(100vw-16px)] overflow-x-hidden bg-surface-elevated border border-hairline rounded-md shadow-lg p-1"
					>
						<div className="flex items-center gap-1.5 bg-surface border border-hairline rounded-sm px-2 py-1.5 mx-0.5 mb-1 text-tertiary">
							🔍
							<input
								data-testid={`${itemTestIdPrefix}-search`}
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								placeholder={t("ui.agentDropdown.searchPlaceholder")}
								className="flex-1 bg-transparent border-0 outline-none text-[calc(12px*var(--font-scale))] text-primary"
							/>
						</div>
						<div className="max-h-[280px] overflow-y-auto">
							{showDefault && (
								<AgentMenuItem
									name={defaultLabel}
									avatar="✨"
									selected={!value}
									onClick={() => handlePick("" as AgentName)}
									testId={`${itemTestIdPrefix}-item-default`}
								/>
							)}
							{filtered.map((a) => (
								<AgentMenuItem
									key={a.displayName}
									name={a.displayName}
									description={a.description}
									avatar={a.avatar}
									avatarColor={a.avatarColor}
									selected={a.displayName === value}
									onClick={() => handlePick(a.displayName)}
									testId={`${itemTestIdPrefix}-item-${a.displayName}`}
								/>
							))}
							{filtered.length === 0 && (
								<div className="px-3 py-3.5 text-center text-tertiary text-[calc(12px*var(--font-scale))]">
									{t("ui.agentDropdown.empty")}
								</div>
							)}
						</div>
					</div>,
					document.body,
				)}
		</div>
	);
}
