import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ThinkingLevel } from "@wa-pi/shared";
import { useTranslation } from "../../i18n/useTranslation";
import { delegateEcho } from "../../store/composer-prefs";
import { Icon } from "./Icon";

export interface DelegateSelectorProps {
	model?: string | null; // undefined/null = 跟随
	thinking?: ThinkingLevel | null;
	/** id 形如 "providerSlug/modelId"，与 ModelSelector 数据同源（由上层传入） */
	models: Array<{ id: string; label: string }>;
	onChange: (patch: {
		model?: string | null;
		thinking?: ThinkingLevel | null;
	}) => void;
	disabled?: boolean;
}

/** 思考栏四档，与 ThinkingSelector 一致（原型方案 A 直接显示档位原名） */
const THINKING_LEVELS: ThinkingLevel[] = ["default", "disabled", "high", "max"];

/**
 * 会话级委派设置（自绘按钮 + 双栏面板）。
 *
 * 按钮文案由 store 的 delegateEcho 给出结构化回显（两栏缺省合并/短名）+ 组件层
 * i18n 措辞（zh「委派 · 跟随」/ en "Delegate · Follow"），手动委派态整体品牌绿
 * （对齐原型 .wa-pi/delegate-setting-ui-poc.html 方案 A）。
 *
 * 面板经 createPortal 挂到 body（fixed z-50）：父容器是 overflow-hidden，
 * 绝对定位会被裁剪，必须逃逸到视口坐标；底部空间不足向上翻转、水平视口钳制
 * （定位模式与 AgentDropdown 一致）。
 *
 * 两栏（模型 / 思考强度）各自独立：首项「跟随主代理」回 null，具体项回单字段
 * patch；点选项即生效，面板保持打开（双栏连续调整不被打断），点面板外才关闭；滚动时收起。
 */
export function DelegateSelector({
	model,
	thinking,
	models,
	onChange,
	disabled,
}: DelegateSelectorProps) {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const { t } = useTranslation();

	const closeMenu = () => setOpen(false);

	// 定位：按按钮矩形固定定位（fixed + portal），底部溢出向上翻转 + 水平视口钳制。
	// 每次渲染后执行（open 变化引起面板尺寸变化时重算），幂等。
	useLayoutEffect(() => {
		if (!open || !menuRef.current || !buttonRef.current) return;
		const m = menuRef.current;
		const br = buttonRef.current.getBoundingClientRect();
		if (br.width === 0 && br.height === 0) return; // 未布局（测试环境）不定位
		m.style.left = `${br.left}px`;
		m.style.top = `${br.bottom + 4}px`;
		const r = m.getBoundingClientRect();
		if (r.width === 0 && r.height === 0) return;
		// 底部空间不足 → 向上翻转（贴按钮顶部）
		if (br.bottom + 4 + r.height > window.innerHeight - 8) {
			m.style.top = `${Math.max(8, br.top - r.height - 4)}px`;
		}
		// 水平钳制：右溢出左移，仍溢出则贴左缘
		if (br.left + r.width > window.innerWidth - 8) {
			m.style.left = `${Math.max(8, window.innerWidth - 8 - r.width)}px`;
		}
	});

	// 点击组件外部关闭面板（面板已 portal 到 body，不在 rootRef 子树内，需单独判 menuRef）
	useEffect(() => {
		if (!open) return;
		const onDown = (ev: MouseEvent) => {
			const target = ev.target as Node;
			if (rootRef.current?.contains(target) || menuRef.current?.contains(target))
				return;
			setOpen(false);
		};
		window.addEventListener("mousedown", onDown);
		return () => window.removeEventListener("mousedown", onDown);
	}, [open]);

	// 滚动关闭：fixed 浮层不跟随外部滚动容器（composer 滚动会脱锚）→ 关闭；
	// 面板自身内部列表滚动（max-h overflow-y-auto）不关闭
	useEffect(() => {
		if (!open) return;
		const onScroll = (ev: Event) => {
			const target = ev.target as Node | null;
			if (target instanceof Node && menuRef.current?.contains(target)) return;
			closeMenu();
		};
		window.addEventListener("scroll", onScroll, true); // 捕获阶段：任意滚动容器都触发
		return () => window.removeEventListener("scroll", onScroll, true);
	}, [open]);

	// 手动委派态（任一栏非「跟随」）：按钮整体品牌绿标识；open 时叠加 hover 背景
	// （与未委派 open 分支一致）。四个分支单一条件表达式，避免分支内外重复拼接。
	const delegated = !!(model || thinking);
	const echo = delegateEcho(model, thinking);
	const followText = t("ui.delegateSelector.followShort");
	const label = echo.collapsed
		? t("ui.delegateSelector.echoCollapsed", { follow: followText })
		: t("ui.delegateSelector.echoSplit", {
				model: echo.modelText ?? followText,
				thinking: echo.thinkingText ?? followText,
			});
	const buttonTone = delegated
		? open
			? "text-brand bg-surface-hover"
			: "text-brand"
		: open
			? "text-primary bg-surface-hover"
			: "text-secondary hover:text-primary";

	const pick = (patch: {
		model?: string | null;
		thinking?: ThinkingLevel | null;
	}) => {
		onChange(patch);
		// 选完不收起——双栏需连续调整（选完即收会打断另一栏），点面板外才关闭
	};

	return (
		<div className="relative min-w-0" ref={rootRef}>
			<button
				type="button"
				ref={buttonRef}
				data-testid="delegate-selector"
				onClick={() => setOpen((o) => !o)}
				disabled={disabled}
				className={`inline-flex items-center gap-1 rounded-sm px-1 -mx-1 text-xs whitespace-nowrap cursor-pointer transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${buttonTone}`}
				aria-label={t("ui.delegateSelector.ariaLabel")}
			>
				<span className="truncate">{label}</span>
				{/* chevron 观感对齐 AutoWidthSelect（1.5em 盒子 ≈9px 可见箭头）；
            手动委派态随文字一并品牌绿（原型 .sel.delegated .chev） */}
				<Icon
					name="chevron-down"
					size="1.5em"
					className={`pointer-events-none flex-none ${delegated ? "text-brand" : "text-tertiary"}`}
				/>
			</button>

			{open &&
				createPortal(
					<div
						ref={menuRef}
						data-testid="delegate-selector-menu"
						// 初始藏屏外，布局 effect 按按钮矩形定位（防闪烁）；测试环境（零尺寸）不定位
						style={{ left: -9999, top: -9999 }}
						className="fixed z-50 flex gap-[18px] bg-surface border border-hairline rounded-md shadow-lg p-3 max-w-[calc(100vw-16px)]"
					>
						{/* 模型栏 */}
						<div data-testid="delegate-col-model" className="flex-1 min-w-0">
							<h4 className="mb-1.5 text-[11px] font-medium tracking-wide text-tertiary">
								{t("ui.delegateSelector.columnModel")}
							</h4>
							<div className="flex max-h-[280px] flex-col overflow-y-auto">
								<PanelItem
									testId="delegate-item-follow-model"
									label={t("ui.delegateSelector.followMain")}
									selected={!model}
									onClick={() => pick({ model: null })}
								/>
								{models.map((m) => (
									<PanelItem
										key={m.id}
										testId={`delegate-item-model-${m.id}`}
										label={m.label}
										selected={model === m.id}
										onClick={() => pick({ model: m.id })}
									/>
								))}
							</div>
						</div>
						{/* 思考强度栏 */}
						<div
							data-testid="delegate-col-thinking"
							className="flex-1 min-w-0"
						>
							<h4 className="mb-1.5 text-[11px] font-medium tracking-wide text-tertiary">
								{t("ui.delegateSelector.columnThinking")}
							</h4>
							<div className="flex max-h-[280px] flex-col overflow-y-auto">
								<PanelItem
									testId="delegate-item-follow-thinking"
									label={t("ui.delegateSelector.followMain")}
									selected={!thinking}
									onClick={() => pick({ thinking: null })}
								/>
								{THINKING_LEVELS.map((level) => (
									<PanelItem
										key={level}
										testId={`delegate-item-thinking-${level}`}
										label={level}
										selected={thinking === level}
										onClick={() => pick({ thinking: level })}
									/>
								))}
							</div>
						</div>
					</div>,
					document.body,
				)}
		</div>
	);
}

/** 双栏面板菜单项：右侧品牌绿 ✓ 标识选中（原型 .menu-item .check） */
function PanelItem({
	label,
	selected,
	onClick,
	testId,
}: {
	label: string;
	selected: boolean;
	onClick: () => void;
	testId: string;
}) {
	return (
		<button
			type="button"
			data-testid={testId}
			onClick={onClick}
			className={`flex w-full cursor-pointer items-center justify-between gap-3 whitespace-nowrap rounded-sm px-2.5 py-1.5 text-left text-xs transition-colors ${
				selected
					? "font-medium text-primary"
					: "text-secondary hover:bg-surface-hover"
			}`}
		>
			<span className="truncate">{label}</span>
			<span
				className={`flex-none font-bold text-brand ${selected ? "visible" : "invisible"}`}
			>
				✓
			</span>
		</button>
	);
}
