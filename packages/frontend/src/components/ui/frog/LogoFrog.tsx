// 左上角 Logo 动态青蛙：静态 Logo 复刻 + 16 个随机小动作（10~20s 一次，平时静止）。
// 结构：Logo 图标（内联 SVG 复刻 logo.svg，部件带 wlf- class 供 A 组动作）+ 标题字母 span
// （B 组字母互动）+ 绝对定位迷你蛙 overlay（B 组跳出动作）。动画全部由 frog.css 驱动。
// 随机规则：16 选 1 不连续重复；窄侧边栏（无 " Agent"）时字母级动作自动退出动作池。
import { useEffect, useRef, useState } from "react";

export type LogoAction =
	| "blink"
	| "quack"
	| "peek"
	| "sleep"
	| "flip"
	| "hopUp"
	| "patrol"
	| "peekaboo"
	| "tongue"
	| "slide"
	| "lie"
	| "vault"
	| "push"
	| "drum";

const ACTIONS: LogoAction[] = [
	"blink",
	"quack",
	"peek",
	"sleep",
	"flip",
	"hopUp",
	"patrol",
	"peekaboo",
	"tongue",
	"slide",
	"lie",
	"vault",
	"push",
	"drum",
];

/** 依赖完整文字（" Agent" 存在）的字母级动作：窄侧边栏时退出动作池。 */
const FULL_TEXT_ONLY: ReadonlySet<string> = new Set(["tongue", "slide", "lie", "push"]);

/** Logo 自身动作（A 组）：加权 2 倍，让 Logo 本身动的概率过半。 */
const LOGO_INLINE: ReadonlySet<string> = new Set(["blink", "quack", "peek", "sleep", "flip"]);

/** 各动作动画时长（ms），与 frog.css 的 wlf- keyframes 一致。 */
export const LOGO_ACTION_MS: Record<LogoAction, number> = {
	blink: 2600,
	quack: 3000,
	peek: 2800,
	sleep: 4200,
	flip: 3000,
	hopUp: 3600,
	patrol: 4600,
	peekaboo: 4000,
	tongue: 3600,
	slide: 3600,
	lie: 4600,
	vault: 3600,
	push: 3600,
	drum: 3600,
};

let lastAction: LogoAction | null = null;

/** 随机挑一个动作，不与上一次重复；fullText=false 时排除字母级动作。rng 可注入。 */
/** 随机挑一个动作，不与上一次重复；fullText=false 时排除字母级动作。
 *  加权：A 组（Logo 自身动作）×2，保证“Logo 本身会动”的概率过半。 */
export function pickLogoAction(fullText: boolean, rng: () => number = Math.random): LogoAction {
	const weighted = ACTIONS.flatMap((a) => (LOGO_INLINE.has(a) ? [a, a] : [a]));
	const pool = weighted.filter((a) => a !== lastAction && (fullText || !FULL_TEXT_ONLY.has(a)));
	const picked = pool[Math.floor(rng() * pool.length)] ?? pool[0];
	lastAction = picked;
	return picked;
}

/** 重置轮换记忆（测试用）。 */
export function resetLogoActionCycle(): void {
	lastAction = null;
}

/** 标题字母 span（inline-block 才能吃 transform）。 */
function Ch({ c, cls, chRef }: { c: string; cls?: string; chRef?: React.Ref<HTMLSpanElement> }) {
	if (c === " ") {
		return (
			<span style={{ display: "inline-block", whiteSpace: "pre" }}>{c}</span>
		);
	}
	return (
		<span className={cls} style={{ display: "inline-block" }} ref={chRef}>
			{c}
		</span>
	);
}

/** 左上角 Logo + 标题（动态蛙版）。width 用于判断窄侧边栏（<240 无 " Agent"）。 */
export function LogoFrog({ width }: { width: number }) {
	const fullText = width >= 240;
	const [active, setActive] = useState<LogoAction | null>(null);
	const rowRef = useRef<HTMLDivElement>(null);
	const letterTRef = useRef<HTMLSpanElement>(null);

	// 调度：10~20s 随机触发一个动作；动作播完（哨兵 animationEnd → onSentinelEnd）复位并再排下一次。
	const scheduleRef = useRef<() => void>(() => {});
	useEffect(() => {
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout>;
		const schedule = () => {
			if (cancelled) return;
			timer = setTimeout(() => {
				if (cancelled) return;
				setActive(pickLogoAction(fullText));
			}, 10_000 + Math.random() * 10_000);
		};
		scheduleRef.current = schedule;
		schedule();
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [fullText]);

	const onSentinelEnd = () => {
		setActive(null);
		scheduleRef.current();
	};

	// 卷字/推字：把最后一个字母 t 的位置写入 CSS 变量，供 keyframes 定向。
	useEffect(() => {
		if (active !== "tongue" && active !== "push") return;
		const t = letterTRef.current?.getBoundingClientRect();
		const row = rowRef.current?.getBoundingClientRect();
		if (!t || !row || !rowRef.current) return;
		rowRef.current.style.setProperty("--wlf-tx", `${Math.round(t.left - row.left + t.width / 2)}px`);
		rowRef.current.style.setProperty("--wlf-ty", `${Math.round(t.top - row.top)}px`);
	}, [active]);

	return (
		<div
			ref={rowRef}
			data-testid="logo-frog"
			data-active={active ?? undefined}
			className={`wlf-row relative flex items-center gap-2 px-2 pb-2.5 min-w-0${active ? ` wlf-a-${active}` : ""}`}
			onAnimationEnd={(e) => {
				// 子元素（迷你蛙/字母）动画结束会冒泡，target 不是 currentTarget，忽略
				if (e.target !== e.currentTarget) return;
			}}
		>
			{/* 哨兵：驱动“动作总时长结束→复位→排下一次”（视觉无变化） */}
			{active && (
				<span
					aria-hidden="true"
					style={{
						position: "absolute",
						width: 1,
						height: 1,
						animation: `wlf-sentinel ${LOGO_ACTION_MS[active]}ms linear forwards`,
					}}
					onAnimationEnd={onSentinelEnd}
				/>
			)}
			{/* Logo 图标：复刻 logo.svg（部件带 class 供 A 组动作） */}
			<svg
				className="wlf-logo flex-shrink-0"
				width="38"
				height="38"
				viewBox="0 0 140 140"
				style={{ borderRadius: 9.5 }}
				aria-hidden="true"
			>
				<rect x="10" y="10" width="120" height="120" rx="26" fill="#4BA26F" />
				<g transform="translate(10,10)">
					<g className="wlf-face">
						<circle cx="60" cy="64" r="38" stroke="#FFFFFF" strokeWidth="2.5" fill="none" />
						<circle cx="38" cy="30" r="18" fill="#FFFFFF" />
						<circle cx="38" cy="30" r="18" stroke="#FFFFFF" strokeWidth="2.5" fill="none" />
						<circle cx="82" cy="30" r="18" fill="#FFFFFF" />
						<circle cx="82" cy="30" r="18" stroke="#FFFFFF" strokeWidth="2.5" fill="none" />
						<circle cx="38" cy="31" r="11" fill="#16171B" />
						<circle cx="82" cy="31" r="11" fill="#16171B" />
						<circle cx="33" cy="24" r="5" fill="#FFFFFF" />
						<circle cx="41" cy="34" r="2.5" fill="#FFFFFF" />
						<circle cx="77" cy="24" r="5" fill="#FFFFFF" />
						<circle cx="85" cy="34" r="2.5" fill="#FFFFFF" />
						<circle cx="24" cy="65" r="6" fill="#FFFFFF" opacity="0.18" />
						<circle cx="96" cy="65" r="6" fill="#FFFFFF" opacity="0.18" />
						<path
							d="M 40,78 Q 60,95 80,78"
							stroke="#FFFFFF"
							strokeWidth="2.8"
							fill="none"
							strokeLinecap="round"
						/>
					</g>
					{/* A 组动作部件：眼皮（眨眼/闭眼）、呱气泡、zzz——默认由 frog.css 隐藏 */}
					<g className="wlf-eyelids">
						<ellipse cx="38" cy="16" rx="19" ry="15" fill="#4BA26F" />
						<ellipse cx="82" cy="16" rx="19" ry="15" fill="#4BA26F" />
						<path d="M24 30 Q38 40 52 30" stroke="#FFFFFF" strokeWidth="2.5" fill="none" strokeLinecap="round" />
						<path d="M68 30 Q82 40 96 30" stroke="#FFFFFF" strokeWidth="2.5" fill="none" strokeLinecap="round" />
					</g>
					<g className="wlf-quack-bubble">
						<rect x="96" y="6" width="36" height="20" rx="10" fill="#fff" stroke="#3f6d33" strokeWidth="2" />
						<text x="114" y="21" textAnchor="middle" fontSize="13" fontWeight="700" fill="#3f8e4f">
							呱!
						</text>
					</g>
					<text className="wlf-zzz" x="108" y="34" fontSize="16" fontWeight="700" fill="#cfe6b8">
						z
					</text>
					<text className="wlf-zzz z2" x="118" y="22" fontSize="12" fontWeight="700" fill="#cfe6b8">
						z
					</text>
				</g>
			</svg>
			{/* 标题：字母拆 span（textContent 口径不变，字母可做互动动画） */}
			<span
				className="font-extrabold text-[calc(18px*var(--font-scale))] tracking-tight text-primary whitespace-nowrap truncate shrink"
				data-testid="sidebar-title"
			>
				<Ch c="W" cls="wlf-ch-w" />
				<Ch c="A" cls="wlf-ch-a2" />
				<Ch c=" " />
				<Ch c="P" cls="wlf-ch-p" />
				<Ch c="I" cls="wlf-ch-i" />
				{fullText && (
					<span data-testid="sidebar-title-agent">
						<Ch c=" " />
						<Ch c="A" />
						<Ch c="g" />
						<Ch c="e" />
						<Ch c="n" />
						<Ch c="t" cls="wlf-ch-t" chRef={letterTRef} />
					</span>
				)}
			</span>
			{/* B 组动作层：迷你蛙（平时隐藏，动作时跳出表演）+ 卷字舌头 */}
			<svg
				className="wlf-avatar absolute pointer-events-none"
				width="26"
				height="26"
				viewBox="0 0 28 28"
				aria-hidden="true"
			>
				<ellipse cx="14" cy="20" rx="10.5" ry="8.5" fill="#7ccb5e" />
				<ellipse cx="14" cy="22" rx="6.5" ry="5" fill="#dcf5c8" />
				<circle cx="9" cy="9" r="4.2" fill="#fff" stroke="#3f6d33" strokeWidth="1" />
				<circle cx="19" cy="9" r="4.2" fill="#fff" stroke="#3f6d33" strokeWidth="1" />
				<circle cx="9.5" cy="9.5" r="2" fill="#2b2b23" />
				<circle cx="19.5" cy="9.5" r="2" fill="#2b2b23" />
				<path d="M10 14 Q14 17 18 14" stroke="#2e4d26" strokeWidth="1.4" fill="none" strokeLinecap="round" />
				<ellipse cx="7" cy="26" rx="4" ry="2" fill="#4d9440" />
				<ellipse cx="21" cy="26" rx="4" ry="2" fill="#4d9440" />
			</svg>
			<span className="wlf-tongue absolute pointer-events-none" aria-hidden="true" />
		</div>
	);
}
