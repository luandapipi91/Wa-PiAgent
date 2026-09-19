// DatePickerButton — 记忆列表「日期范围」筛选（react-day-picker v10 封装）
// 视觉/交互已经 PoC 确认（packages/frontend/src/poc-date.tsx，用户认可后落地）：
// 双月并排 + 快捷片 + 底部预览 + 清除/确定；深色适配走项目 CSS 变量。
// 受控契约：from/to 由外部持有，本组件只在「确定/清除」时通过 onChange 上报。
import { useEffect, useRef, useState } from "react";
import { DayPicker, type DateRange } from "react-day-picker";
import { zhCN } from "react-day-picker/locale";
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
	const [open, setOpen] = useState(false);
	// 弹层内暂存：确定才回调（draft 用 Date 对象与 DayPicker 对接）
	const [draft, setDraft] = useState<DateRange | undefined>();
	const wrapRef = useRef<HTMLDivElement | null>(null);

	// ESC 或点击组件外部关闭（仅弹层打开时挂监听）
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
		const onDown = (e: MouseEvent) => {
			if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("keydown", onKey);
		document.addEventListener("mousedown", onDown);
		return () => {
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("mousedown", onDown);
		};
	}, [open]);

	const hasValue = !!(from && to);
	const previewText =
		draft?.from && draft?.to
			? `${fmtLocal(draft.from)} ~ ${fmtLocal(draft.to)}`
			: draft?.from
				? `${fmtLocal(draft.from)} ~ 选择结束日期`
				: "选择起始日期";

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
				className={`dp-btn${hasValue ? " active" : ""}`}
				data-testid="memory-date-btn"
				// 每次打开都从外部 props 重建 draft，外部状态变化不会残留旧 draft
				onClick={() => { setOpen((v) => !v); setDraft(from && to ? { from: new Date(`${from}T00:00:00`), to: new Date(`${to}T23:59:59.999`) } : undefined); }}
			>
				📅 <span>{hasValue ? `${from} ~ ${to}` : "日期范围"}</span>
				<span style={{ color: "var(--text-tertiary)" }}>▾</span>
				{hasValue && (
					<span
						className="dp-clear"
						data-testid="memory-date-clear"
						title="清除"
						onClick={(e) => { e.stopPropagation(); onChange(null, null); setOpen(false); }}
					>✕</span>
				)}
			</button>
			{open && (
				<div className="dp-pop poc-dp" data-testid="memory-date-pop">
					<div className="dp-quick">
						<button type="button" className="q" onClick={() => applyQuick("today")}>今天</button>
						<button type="button" className="q" onClick={() => applyQuick("7d")}>近 7 天</button>
						<button type="button" className="q" onClick={() => applyQuick("30d")}>近 30 天</button>
						<button type="button" className="q" onClick={() => applyQuick("month")}>本月</button>
					</div>
					<DayPicker
						mode="range"
						locale={zhCN}
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
							<button type="button" className="f-btn" onClick={() => { onChange(null, null); setOpen(false); }}>清除</button>
							<button
								type="button"
								className="f-btn f-primary"
								data-testid="memory-date-ok"
								onClick={() => {
									if (draft?.from && !draft.to) setDraft({ from: draft.from, to: draft.to }); // 单点=只看当天
									const f = draft?.from, t = draft?.to ?? draft?.from;
									onChange(f ? fmtLocal(f) : null, t ? fmtLocal(t) : null);
									setOpen(false);
								}}
							>确定</button>
						</div>
					</div>
					<div className="dp-tip">点起点 → 点终点；ESC 或点击外部关闭</div>
				</div>
			)}
		</div>
	);
}
