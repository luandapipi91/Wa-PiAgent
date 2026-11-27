import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ThinkingLevel } from "@wa-pi/shared";
import { resolveProviderSlug } from "@wa-pi/shared";
import { useProvidersStore } from "../../store/providers";
import { useTranslation } from "../../i18n/useTranslation";
import { Icon } from "./Icon";

export interface MainAgentSelectorProps {
	/** 当前模型，形如 "providerSlug/modelId"；null = 未选（允许时自动选第一个） */
	value: string | null;
	thinking: ThinkingLevel;
	onModelChange: (modelId: string) => void;
	onThinkingChange: (level: ThinkingLevel) => void;
	/** 是否允许 auto-select（默认 true）。会话 prefs 冷加载间隙（value 暂为 null 但 DB 里
	 *  可能有值）必须传 false，否则 auto-select 会抢在 loadSession 完成前把第一个模型
	 *  写进会话 prefs 与 defaults。 */
	autoSelectEnabled?: boolean;
}

/** 思考栏四档，与 DelegateSelector 一致（直接显示档位原名；default 排最前） */
const THINKING_LEVELS: ThinkingLevel[] = ["default", "disabled", "high", "max"];

/**
 * 主代理「模型 + 思考强度」一体式选择器（自绘按钮 + 双栏面板），与 DelegateSelector 同形态：
 * 按钮显示「厂商/模型 | 思考」（如「Z.AI Coding CN/glm-5.4 | max」），点开左栏模型列表、
 * 右栏四档思考强度；按钮文字与箭头用主题色，与普通文字色的子代理选择器区分主次。模型列表与原 ModelSelector 下拉项同源（id = "providerSlug/modelId"，
 * label = "providerName/modelId"），并保留它的两条既有逻辑：未选时自动选第一个模型、
 * 已保存的值失效时按 id 重钉。
 *
 * 面板经 createPortal 挂到 body（fixed z-50），定位模式与 DelegateSelector 一致：
 * 按按钮矩形固定定位、底部空间不足向上翻转、水平视口钳制；点选项即生效、面板保持打开
 * （切模型后档位会重算，正好顺手在同一面板里调），点面板外才关闭；滚动时只重新定位不关闭。
 * 定位逻辑本次刻意复制而非抽取共用：DelegateSelector 带有在途未提交改动，不去搅动。
 */
export function MainAgentSelector({
	value,
	thinking,
	onModelChange,
	onThinkingChange,
	autoSelectEnabled = true,
}: MainAgentSelectorProps) {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const autoSelectedRef = useRef(false);
	const { t } = useTranslation();
	const providers = useProvidersStore((s) => s.providers);

	// 模型列表（含不可选的占位项由按钮文案处理）：id = "providerSlug/modelId"，
	// label = "providerName/modelId"，与 DelegateSelector 的 models 入参同算法
	const models = useMemo(() => {
		const slugs: string[] = [];
		return providers.flatMap((p) => {
			const slug = resolveProviderSlug(p, slugs);
			slugs.push(slug);
			return p.models.map((m) => ({
				id: `${slug}/${m.id}`,
				label: `${p.name}/${m.id}`,
			}));
		});
	}, [providers]);

	// 未选模型时自动选择第一个可用模型，避免发送按钮被 disabled placeholder 卡死。
	// 用 ref 确保每个实例仅触发一次（新会话、新建模型等场景）；value 清空时重置 ref，允许再次 auto-select。
	useEffect(() => {
		if (!value) autoSelectedRef.current = false;
	}, [value]);
	useEffect(() => {
		if (
			!autoSelectEnabled ||
			value ||
			models.length === 0 ||
			autoSelectedRef.current
		)
			return;
		autoSelectedRef.current = true;
		onModelChange(models[0].id);
	}, [autoSelectEnabled, value, models, onModelChange]);

	// 兼容旧数据：已保存的值匹配不上任何选项时，按 id 部分兜底匹配——覆盖裸 model id 与
	// 过期 slug（provider 改名后残留），唯一命中时自动重钉到正确的 id，避免发送闸门被失效 prefs 卡死。
	useEffect(() => {
		if (!value) return;
		if (models.some((m) => m.id === value)) return;
		const idPart = value.slice(value.lastIndexOf("/") + 1);
		const matches = models.filter(
			(m) => m.id.slice(m.id.lastIndexOf("/") + 1) === idPart,
		);
		if (matches.length === 1) onModelChange(matches[0].id);
	}, [value, models, onModelChange]);

	// 定位：按按钮矩形固定定位（fixed + portal），底部溢出向上翻转 + 水平视口钳制。
	// 幂等，只依赖 refs；每次渲染后与每次滚动事件后各执行一次。
	const positionMenu = useCallback(() => {
		const m = menuRef.current;
		const b = buttonRef.current;
		if (!m || !b) return;
		const br = b.getBoundingClientRect();
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
	}, []);

	// 每次渲染后重算（open 变化引起面板尺寸变化、按钮文案变宽、输入框增高时按钮移位）
	useLayoutEffect(() => {
		if (!open) return;
		positionMenu();
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

	// 滚动跟随：fixed 浮层不随外部滚动容器移动 → 任意滚动容器（捕获阶段）滚动后按按钮
	// 矩形重新定位，不关闭（流式回复期间消息列表会被程序化自动贴底，关闭会让面板自己消失）。
	useEffect(() => {
		if (!open) return;
		window.addEventListener("scroll", positionMenu, true);
		return () => window.removeEventListener("scroll", positionMenu, true);
	}, [open, positionMenu]);

	// 无可用模型：显示占位文字（放在所有 hooks 之后，保证 hooks 顺序稳定）
	if (models.length === 0) {
		return (
			<span className="text-xs text-tertiary">
				{t("ui.mainSelector.notConfigured")}
			</span>
		);
	}

	const current = value ? models.find((m) => m.id === value) : undefined;
	const label = current
		? `${current.label} | ${thinking}`
		: t("ui.mainSelector.placeholder");
	const buttonTone = open
		? "text-brand bg-surface-hover"
		: "text-brand";

	return (
		<div className="relative min-w-0 max-w-[240px]" ref={rootRef}>
			<button
				type="button"
				ref={buttonRef}
				data-testid="main-selector"
				data-value={value ?? ""}
				data-thinking={thinking}
				onClick={() => setOpen((o) => !o)}
				className={`inline-flex max-w-full items-center gap-1 rounded-sm px-1 -mx-1 text-xs whitespace-nowrap cursor-pointer transition-colors ${buttonTone}`}
				aria-label={t("ui.mainSelector.ariaLabel")}
			>
				<span className="min-w-0 truncate">{label}</span>
				{/* chevron 随按钮文字同为主题色（1.5em 盒子 ≈9px 可见箭头，观感与 DelegateSelector 一致） */}
				<Icon
					name="chevron-down"
					size="1.5em"
					className="pointer-events-none flex-none text-brand"
				/>
			</button>

			{open &&
				createPortal(
					<div
						ref={menuRef}
						data-testid="main-selector-menu"
						// 初始藏屏外，布局 effect 按按钮矩形定位（防闪烁）；测试环境（零尺寸）不定位
						style={{ left: -9999, top: -9999 }}
						className="fixed z-50 flex gap-[18px] bg-surface border border-hairline rounded-md shadow-lg p-3 max-w-[calc(100vw-16px)]"
					>
						{/* 模型栏（主代理没有可跟随的对象，无「跟随」首项） */}
						<div data-testid="main-col-model" className="flex-1 min-w-0">
							<h4 className="mb-1.5 text-[11px] font-medium tracking-wide text-tertiary">
								{t("ui.mainSelector.columnModel")}
							</h4>
							<div className="flex max-h-[280px] flex-col overflow-y-auto">
								{models.map((m) => (
									<PanelItem
										key={m.id}
										testId={`main-item-model-${m.id}`}
										label={m.label}
										selected={value === m.id}
										onClick={() => onModelChange(m.id)}
									/>
								))}
							</div>
						</div>
						{/* 思考强度栏 */}
						<div data-testid="main-col-thinking" className="flex-1 min-w-0">
							<h4 className="mb-1.5 text-[11px] font-medium tracking-wide text-tertiary">
								{t("ui.mainSelector.columnThinking")}
							</h4>
							<div className="flex max-h-[280px] flex-col overflow-y-auto">
								{THINKING_LEVELS.map((level) => (
									<PanelItem
										key={level}
										testId={`main-item-thinking-${level}`}
										label={level}
										selected={thinking === level}
										onClick={() => onThinkingChange(level)}
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

/** 双栏面板菜单项：右侧品牌绿 ✓ 标识选中（与 DelegateSelector.PanelItem 一致） */
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
				selected ? "font-medium text-primary" : "text-secondary hover:bg-surface-hover"
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
