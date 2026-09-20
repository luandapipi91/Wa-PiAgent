// DatePickerButton — 记忆列表「日期范围」筛选（react-day-picker v10 封装）
// 视觉/交互经用户 PoC 确认后落地（设计定稿见
// docs/superpowers/plans/2026-09-19-memory-date-pagination.md）：
// 双月并排 + 快捷片 + 底部预览 + 清除/确定；深色适配走项目 CSS 变量。
// 受控契约：from/to 由外部持有，本组件只在「确定/清除」时通过 onChange 上报。
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DayPicker, type DateRange } from "react-day-picker";
import { zhCN, enUS } from "react-day-picker/locale";
import { useTranslation } from "../../i18n/useTranslation";
import "react-day-picker/style.css";
import "./memory-datepicker.css";

// 本地日期 → YYYY-MM-DD（不用 toISOString，避免时区偏移）
function fmtLocal(d: Date): string {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

interface Props {
	from: string | null;
	to: string | null;
	onChange: (from: string | null, to: string | null) => void;
}

export function DatePickerButton({ from, to, onChange }: Props) {
	const { t, i18n } = useTranslation();
	const [open, setOpen] = useState(false);
	// 弹层内暂存：确定才回调（draft 用 Date 对象与 DayPicker 对接）
	const [draft, setDraft] = useState<DateRange | undefined>();
	const wrapRef = useRef<HTMLDivElement | null>(null);
	const btnRef = useRef<HTMLButtonElement | null>(null);
	const popRef = useRef<HTMLDivElement | null>(null);

	// 弹层经 portal 挂到 body 并改用 fixed 定位：原实现挂在工具栏（relative wrapper）内做
	// absolute + left:0，而 MemoryPage 根容器是 overflow:hidden——锚点在页面右上角、弹层宽
	// 508px，向右/向下越出的部分被直接裁掉（用户报「选择器超出边界」）。
	// 定位口径与 AgentDropdown 一致：贴按钮左缘向下展开 6px，右溢出左移、底部不足向上翻转。
	useLayoutEffect(() => {
		if (!open) return;
		const pop = popRef.current;
		const btn = btnRef.current;
		if (!pop || !btn) return;
		const pr = btn.getBoundingClientRect();
		if (pr.width === 0 && pr.height === 0) return; // 未布局（测试/首帧）不定位
		pop.style.left = `${pr.left}px`;
		pop.style.top = `${pr.bottom + 6}px`;
		const r = pop.getBoundingClientRect();
		if (r.width === 0 && r.height === 0) return;
		// 底部空间不足 → 向上翻转（贴按钮顶部）
		if (pr.bottom + 6 + r.height > window.innerHeight - 8) {
			pop.style.top = `${Math.max(8, pr.top - r.height - 6)}px`;
		}
		// 水平钳制：右溢出左移，仍溢出则贴左缘
		if (pr.left + r.width > window.innerWidth - 8) {
			pop.style.left = `${Math.max(8, window.innerWidth - 8 - r.width)}px`;
		}
	}, [open]);

	// ESC 或点击组件外部关闭（仅弹层打开时挂监听）
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
		const onDown = (e: MouseEvent) => {
			const target = e.target as Node;
			// 弹层已 portal 到 body，不在 wrapRef 子树内，需单独判 popRef——否则点弹层内部会误关
			if (wrapRef.current?.contains(target) || popRef.current?.contains(target)) return;
			setOpen(false);
		};
		document.addEventListener("keydown", onKey);
		document.addEventListener("mousedown", onDown);
		return () => {
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("mousedown", onDown);
		};
	}, [open]);

	// 滚动即关闭：fixed 浮层不跟随外部滚动容器（列表一滚弹层就脱锚），
	// 但弹层自身滚动（max-height 兜底触发）不关闭。
	useEffect(() => {
		if (!open) return;
		const onScroll = (ev: Event) => {
			const el = ev.target as Node | null;
			if (el instanceof Node && popRef.current?.contains(el)) return;
			setOpen(false);
		};
		window.addEventListener("scroll", onScroll, true);
		return () => window.removeEventListener("scroll", onScroll, true);
	}, [open]);

	const hasValue = !!(from && to);
	const previewText =
		draft?.from && draft?.to
			? `${fmtLocal(draft.from)} ~ ${fmtLocal(draft.to)}`
			: draft?.from
				? `${fmtLocal(draft.from)} ~ ${t("memory.datePickEnd")}`
				: t("memory.datePickStart");

	// 快捷片：直接把范围灌进 draft（底部预览可见，点确定生效）
	function applyQuick(kind: string) {
		const now = new Date();
		const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
		let start: Date;
		if (kind === "today") start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		else if (kind === "7d") { start = new Date(now); start.setDate(start.getDate() - 6); }
		else if (kind === "30d") { start = new Date(now); start.setDate(start.getDate() - 29); }
		else start = new Date(now.getFullYear(), now.getMonth(), 1); // 本月
		setDraft({ from: start, to: end });
	}

	return (
		<div ref={wrapRef} style={{ position: "relative" }}>
			<button
				type="button"
				ref={btnRef}
				className={`dp-btn${hasValue ? " active" : ""}`}
				data-testid="memory-date-btn"
				// 每次打开都从外部 props 重建 draft，外部状态变化不会残留旧 draft
				onClick={() => { setOpen((v) => !v); setDraft(from && to ? { from: new Date(`${from}T00:00:00`), to: new Date(`${to}T23:59:59.999`) } : undefined); }}
			>
				📅 <span>{hasValue ? `${from} ~ ${to}` : t("memory.dateRange")}</span>
				<span style={{ color: "var(--text-tertiary)" }}>▾</span>
				{hasValue && (
					<span
						className="dp-clear"
						data-testid="memory-date-clear"
						title={t("memory.dateClear")}
						onClick={(e) => { e.stopPropagation(); onChange(null, null); setOpen(false); }}
					>✕</span>
				)}
			</button>
			{open &&
				createPortal(
					<div ref={popRef} className="dp-pop poc-dp" data-testid="memory-date-pop">
						<div className="dp-quick">
							<button type="button" className="q" onClick={() => applyQuick("today")}>{t("memory.quickToday")}</button>
							<button type="button" className="q" onClick={() => applyQuick("7d")}>{t("memory.quick7d")}</button>
							<button type="button" className="q" onClick={() => applyQuick("30d")}>{t("memory.quick30d")}</button>
							<button type="button" className="q" onClick={() => applyQuick("month")}>{t("memory.quickMonth")}</button>
						</div>
						{/* 日历框架文案（月名/星期/aria-label）随应用语言切换，避免英文界面下日历仍是中文 */}
						<DayPicker
							mode="range"
							locale={i18n.language === "en" ? enUS : zhCN}
							numberOfMonths={2}
							selected={draft}
							onSelect={(r) => setDraft(r)}
							defaultMonth={draft?.from ?? new Date()}
							showOutsideDays
						/>
						<div className="dp-foot">
							<span className="dp-preview">{previewText}</span>
							<div className="dp-foot-btns">
								{/* 路径一：弹层内清除按钮 */}
								<button type="button" className="f-btn" onClick={() => { onChange(null, null); setOpen(false); }}>{t("memory.dateClear")}</button>
								<button
									type="button"
									className="f-btn f-primary"
									data-testid="memory-date-ok"
									onClick={() => {
										// 单点=只看当天（to 缺省取 from）
										const f = draft?.from, t2 = draft?.to ?? draft?.from;
										onChange(f ? fmtLocal(f) : null, t2 ? fmtLocal(t2) : null);
										setOpen(false);
									}}
								>{t("memory.dateOk")}</button>
							</div>
						</div>
						<div className="dp-tip">{t("memory.datePickHint")}</div>
					</div>,
					document.body,
				)}
		</div>
	);
}
