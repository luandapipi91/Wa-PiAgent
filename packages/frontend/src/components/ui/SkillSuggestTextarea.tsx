import { useEffect, useRef, useState } from "react";
import { detectTrigger, filterItems } from "../../quick-invoke/trigger";
import { useSkillsStore } from "../../store/skills";

interface Props {
	value: string;
	onChange: (v: string) => void;
	rows?: number;
	placeholder?: string;
	"data-testid"?: string;
}

/** 支持 $ 技能自动补全的纯文本输入框（仅 skill 一种触发；存储形态为 $[技能名] 纯文本 token） */
export function SkillSuggestTextarea({ value, onChange, rows = 3, placeholder, "data-testid": testId }: Props) {
	const skills = useSkillsStore((s) => s.skills);
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [activeIdx, setActiveIdx] = useState(0);
	const ref = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		if (skills.length === 0) useSkillsStore.getState().load();
	}, []);

	const items = open ? filterItems(skills, query) : [];

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
			{open && items.length > 0 && (
				<div
					className="absolute left-0 right-0 top-full mt-1 rounded-md border border-hairline overflow-hidden z-10"
					style={{ background: "var(--surface)", boxShadow: "var(--shadow-md)" }}
					data-testid="skill-suggest-list"
				>
					{items.map((s, i) => (
						<button
							key={s.name}
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
			)}
		</div>
	);
}
