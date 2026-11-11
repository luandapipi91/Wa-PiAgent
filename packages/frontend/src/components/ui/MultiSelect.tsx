// MultiSelect — 主题化多选下拉（单行摘要 + 复选面板）。
//
// 替代「一长排复选框」的绑定区：收起态只占一行，把已选项用「、」拼起来，
// 超出宽度由 truncate 出省略号（悬停 title 看全量）；点开才是复选面板。
//   · 摘要只取 options 里存在的选中项，按 options 顺序拼接（失效 id 不进摘要）
//   · 面板内点行 = 切换但不收起（多选语义，一次可以勾好几个）
//   · 外部 mousedown / Esc 收起；面板随宿主滚动，不做 portal（宿主多为弹窗内表单）
import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";

export interface MultiSelectOption {
	value: string;
	label: string;
	/** 次要说明（如知识库描述），单行省略 */
	description?: string;
	/** 行尾状态文字（如索引状态） */
	meta?: string;
	disabled?: boolean;
}

interface Props {
	/** 触发器 testid；派生 `-summary` / `-panel` / `-check-{value}` / `-hint` */
	testId: string;
	ariaLabel: string;
	options: MultiSelectOption[];
	selected: string[];
	onToggle: (value: string) => void;
	/** 未选中时触发器内的占位文案 */
	placeholder: string;
	/** 面板顶部说明（如「绑定知识库将自动启用搜索工具」） */
	hint?: string;
	disabled?: boolean;
}

/**
 * 摘要文案：只保留 options 里存在的选中项（清单可能已删除该库），按 options 顺序拼接。
 * 用「、」连接，不生成 chip——溢出由 CSS truncate 处理，保证始终单行。
 */
function summaryOf(options: MultiSelectOption[], selected: string[]): string {
	const set = new Set(selected);
	return options
		.filter((o) => set.has(o.value))
		.map((o) => o.label)
		.join("、");
}

export function MultiSelect({
	testId,
	ariaLabel,
	options,
	selected,
	onToggle,
	placeholder,
	hint,
	disabled,
}: Props) {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const summary = summaryOf(options, selected);

	// disabled 时立即收起（展开中被禁用的情况）
	useEffect(() => {
		if (disabled) setOpen(false);
	}, [disabled]);

	// 展开期间：外部 mousedown / Esc 收起
	useEffect(() => {
		if (!open) return;
		const onDown = (ev: MouseEvent) => {
			const target = ev.target as Node | null;
			if (target && rootRef.current?.contains(target)) return;
			setOpen(false);
		};
		// Esc 只收起面板：capture 阶段拦下并掐断传播，否则宿主弹窗（Modal 的 window 冒泡监听）
		// 会把「收起下拉」当成「关闭弹窗」一起执行
		const onKey = (ev: KeyboardEvent) => {
			if (ev.key !== "Escape") return;
			setOpen(false);
			ev.stopPropagation();
		};
		window.addEventListener("mousedown", onDown);
		window.addEventListener("keydown", onKey, true);
		return () => {
			window.removeEventListener("mousedown", onDown);
			window.removeEventListener("keydown", onKey, true);
		};
	}, [open]);

	return (
		<div className="relative" data-testid={`${testId}-root`} ref={rootRef}>
			{/* 触发器外观对齐表单输入框（inp）：同边框/圆角/内边距，右侧自绘 chevron */}
			<button
				type="button"
				data-testid={`${testId}-trigger`}
				aria-label={ariaLabel}
				aria-haspopup="listbox"
				aria-expanded={open}
				disabled={disabled}
				onClick={() => {
					// 无候选（清单空/未知）：不展开空面板，状态由宿主在触发器下方说明
					if (options.length === 0) return;
					setOpen((v) => !v);
				}}
				className={`flex w-full items-center gap-2 rounded-sm border border-hairline bg-surface px-2 py-1.5 text-left text-sm outline-none transition-colors focus:border-accent ${
					disabled
						? "cursor-not-allowed opacity-60"
						: "cursor-pointer hover:border-hairline-strong"
				}`}
			>
				<span
					data-testid={`${testId}-summary`}
					title={summary || undefined}
					className={`min-w-0 flex-1 truncate ${
						summary ? "text-primary" : "text-tertiary"
					}`}
				>
					{summary || placeholder}
				</span>
				<Icon
					name={open ? "chevron-up" : "chevron-down"}
					size="1.5em"
					className="pointer-events-none shrink-0 text-xs text-tertiary"
				/>
			</button>

			{open && (
				<div
					data-testid={`${testId}-panel`}
					className="absolute left-0 right-0 top-full z-20 mt-1 max-h-[240px] overflow-y-auto rounded-md border border-hairline bg-surface py-1 shadow-lg"
				>
					{hint && (
						<p
							data-testid={`${testId}-hint`}
							className="px-2 pb-1 pt-0.5 text-[calc(11px*var(--font-scale))] text-tertiary"
						>
							{hint}
						</p>
					)}
					{options.map((o) => (
						<label
							key={o.value}
							className="flex cursor-pointer items-center gap-2 px-2 py-1.5 hover:bg-surface-hover"
						>
							<input
								type="checkbox"
								data-testid={`${testId}-check-${o.value}`}
								checked={selected.includes(o.value)}
								disabled={o.disabled}
								onChange={() => onToggle(o.value)}
								className="shrink-0 accent-[var(--accent)]"
							/>
							<span className="shrink-0 whitespace-nowrap text-sm text-primary">
								{o.label}
							</span>
							{o.description && (
								<span className="block min-w-0 flex-1 truncate text-[calc(11px*var(--font-scale))] text-tertiary">
									{o.description}
								</span>
							)}
							{o.meta && (
								<span className="shrink-0 whitespace-nowrap text-[calc(10px*var(--font-scale))] text-tertiary">
									{o.meta}
								</span>
							)}
						</label>
					))}
				</div>
			)}
		</div>
	);
}
