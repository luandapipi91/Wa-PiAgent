import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { detectTrigger, filterItems } from "../../quick-invoke/trigger";
import { useSkillsStore } from "../../store/skills";

interface Props {
	value: string;
	onChange: (v: string) => void;
	rows?: number;
	placeholder?: string;
	"data-testid"?: string;
}

/** 弹层定位：fixed 视口坐标（portal 到 body，逃逸设置弹窗的 overflow 裁剪与层叠上下文） */
interface PopupPos {
	left: number;
	width: number;
	top?: number; // 向下展开：textarea 底边之下
	bottom?: number; // 向上展开：textarea 顶边之上（视口底部锚定）
	maxHeight: number;
}

/** 支持 $ 技能自动补全的纯文本输入框（仅 skill 一种触发；存储形态为 $[技能名] 纯文本 token） */
export function SkillSuggestTextarea({ value, onChange, rows = 3, placeholder, "data-testid": testId }: Props) {
	const skills = useSkillsStore((s) => s.skills);
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [activeIdx, setActiveIdx] = useState(0);
	const [pos, setPos] = useState<PopupPos | null>(null);
	const ref = useRef<HTMLTextAreaElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (skills.length === 0) useSkillsStore.getState().load();
	}, []);

	const items = open ? filterItems(skills, query) : [];

	/** 按 textarea 视口位置计算弹层坐标；下方空间不足且上方更宽时向上展开 */
	const calcPos = (): PopupPos | null => {
		const ta = ref.current;
		if (!ta) return null;
		const r = ta.getBoundingClientRect();
		const MAX = 240;
		const spaceBelow = window.innerHeight - r.bottom - 8;
		const spaceAbove = r.top - 8;
		if (spaceBelow >= 120 || spaceBelow >= spaceAbove) {
			return { left: r.left, width: r.width, top: r.bottom + 4, maxHeight: Math.max(80, Math.min(MAX, spaceBelow)) };
		}
		return { left: r.left, width: r.width, bottom: window.innerHeight - r.top + 4, maxHeight: Math.max(80, Math.min(MAX, spaceAbove)) };
	};

	// 打开期间跟随滚动/缩放重定位（设置弹窗内容区可滚动，弹层是 fixed 需手动跟随）
	useEffect(() => {
		if (!open) return;
		const update = () => setPos(calcPos());
		update();
		window.addEventListener("resize", update);
		window.addEventListener("scroll", update, true);
		return () => {
			window.removeEventListener("resize", update);
			window.removeEventListener("scroll", update, true);
		};
	}, [open]);

	// 键盘上下移动时保持高亮项可见
	useEffect(() => {
		const el = listRef.current?.querySelector('[data-active="true"]');
		(el as HTMLElement | null)?.scrollIntoView?.({ block: "nearest" });
	}, [activeIdx]);

	const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
		const v = e.target.value;
		onChange(v);
		const cursor = e.target.selectionStart ?? v.length;
		const trigger = detectTrigger(v.slice(0, cursor));
		if (trigger?.type === "skill") {
			setQuery(trigger.query);
			setActiveIdx(0);
			setOpen(true);
		} else {
			setOpen(false);
		}
	};

	/** 把光标前的 $query 片段替换为 $[name] token */
	const pick = (name: string) => {
		const ta = ref.current!;
		const cursor = ta.selectionStart ?? value.length;
		const before = value.slice(0, cursor);
		const m = before.match(/(?:^|\s)([$¥])([^\s]*)$/);
		const start = m ? cursor - m[1].length - m[2].length : cursor;
		const token = `$[${name}]`;
		const next = value.slice(0, start) + token + value.slice(cursor);
		onChange(next);
		setOpen(false);
		// 光标移到 token 之后
		requestAnimationFrame(() => {
			ta.focus();
			ta.selectionStart = ta.selectionEnd = start + token.length;
		});
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (!open || items.length === 0) return;
		if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((i) => (i + 1) % items.length); }
		else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((i) => (i - 1 + items.length) % items.length); }
		else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(items[activeIdx].name); }
		else if (e.key === "Escape") { e.stopPropagation(); setOpen(false); }
	};

	return (
		<div className="relative">
			<textarea
				ref={ref}
				value={value}
				onChange={handleChange}
				onKeyDown={handleKeyDown}
				onBlur={() => setTimeout(() => setOpen(false), 150)} // 延迟关闭让点击先触发
				rows={rows}
				placeholder={placeholder}
				className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none w-full"
				data-testid={testId}
			/>
			{open && items.length > 0 && pos && createPortal(
				<div
					className="fixed rounded-md border border-hairline overflow-hidden"
					style={{
						left: pos.left,
						width: pos.width,
						top: pos.top,
						bottom: pos.bottom,
						background: "var(--surface)",
						boxShadow: "var(--shadow-md)",
						zIndex: 1000,
					}}
					data-testid="skill-suggest-list"
				>
					<div ref={listRef} className="overflow-y-auto" style={{ maxHeight: pos.maxHeight }}>
						{items.map((s, i) => (
							<button
								key={s.name}
								data-active={i === activeIdx}
								onMouseDown={(e) => { e.preventDefault(); pick(s.name); }} // mousedown 抢在 blur 前
								className="w-full text-left px-2.5 py-1.5 border-0 cursor-pointer text-sm"
								style={{
									background: i === activeIdx ? "var(--surface-hover)" : "transparent",
									color: "var(--text-primary)",
								}}
								data-testid={`skill-suggest-item-${s.name}`}
							>
								⚡ {s.name}
								{s.description && <span className="text-xs text-tertiary ml-1.5">{s.description}</span>}
							</button>
						))}
					</div>
				</div>,
				document.body,
			)}
		</div>
	);
}
