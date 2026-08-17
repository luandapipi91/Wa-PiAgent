/**
 * 全局 SVG 图标库：替代原 emoji/符号图标。
 * 风格统一对齐主题：24 viewBox、fill none、stroke currentColor、1.6 线宽、圆角端点，
 * 颜色全部继承上下文（currentColor），由调用方 CSS 控制主题色。
 * 实心类（dot/circle 勾选态等）在各自 path 上单独 fill="currentColor"。
 */
import type { ReactNode } from "react";

const S = { fill: "none", stroke: "currentColor" } as const;
const F = { fill: "currentColor", stroke: "none" } as const;

const ICONS = {
	// ── 文件/目录 ──
	folder: (
		<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
	),
	"folder-open": (
		<>
			<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v2" />
			<path d="M3 11h15.5a2 2 0 0 1 1.9 2.6l-1.6 4.8a2 2 0 0 1-1.9 1.4H5a2 2 0 0 1-2-2V11z" />
		</>
	),
	file: (
		<>
			<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z" />
			<path d="M14 3v5h5" />
		</>
	),
	home: (
		<>
			<path d="M3 11l9-8 9 8" />
			<path d="M5 10v9a1 1 0 0 0 1 1h4v-5h4v5h4a1 1 0 0 0 1-1v-9" />
		</>
	),
	// ── 状态/提示 ──
	warning: (
		<>
			<path d="M12 4L2.5 20h19L12 4z" />
			<path d="M12 10v4" />
			<circle cx="12" cy="17" r="0.6" {...F} />
		</>
	),
	lightbulb: (
		<>
			<path d="M9 18h6" />
			<path d="M10 21h4" />
			<path d="M12 3a6 6 0 0 0-3.3 11c.8.6 1.3 1.3 1.3 2.2V16h4v-.2c0-.9.5-1.6 1.3-2.2A6 6 0 0 0 12 3z" />
		</>
	),
	hourglass: (
		<>
			<path d="M6 3h12" />
			<path d="M6 21h12" />
			<path d="M7 3c0 4 3.4 5.4 5 6-1.6.6-5 2-5 6" />
			<path d="M17 3c0 4-3.4 5.4-5 6 1.6.6 5 2 5 6" />
		</>
	),
	question: (
		<>
			<circle cx="12" cy="12" r="8.5" />
			<path d="M9.2 9a2.8 2.8 0 0 1 5.4 1c0 1.6-2.4 2-2.4 3.2" />
			<circle cx="12" cy="16.8" r="0.7" {...F} />
		</>
	),
	dot: <circle cx="12" cy="12" r="5.5" {...F} />,
	circle: <circle cx="12" cy="12" r="7" />,
	// ── 勾选/表单 ──
	check: <path d="M4 12.5l5 5L20 6.5" />,
	x: (
		<>
			<path d="M5 5l14 14" />
			<path d="M19 5L5 19" />
		</>
	),
	"checkbox-checked": (
		<>
			<rect x="4" y="4" width="16" height="16" rx="2.5" />
			<path d="M8 12.5l2.8 2.8L16.5 9" />
		</>
	),
	checkbox: <rect x="4" y="4" width="16" height="16" rx="2.5" />,
	"radio-checked": (
		<>
			<circle cx="12" cy="12" r="7" />
			<circle cx="12" cy="12" r="3" {...F} />
		</>
	),
	radio: <circle cx="12" cy="12" r="7" />,
	// ── 箭头/折叠 ──
	"chevron-down": <path d="M6 9.5l6 6 6-6" />,
	"chevron-right": <path d="M9.5 6l6 6-6 6" />,
	"arrow-up": (
		<>
			<path d="M12 19V5" />
			<path d="M5.5 11.5L12 5l6.5 6.5" />
		</>
	),
	"arrow-down": (
		<>
			<path d="M12 5v14" />
			<path d="M5.5 12.5L12 19l6.5-6.5" />
		</>
	),
	"upload-arrow": (
		<>
			<path d="M12 16V4" />
			<path d="M6 9.5L12 4l6 5.5" />
			<path d="M4 20h16" />
		</>
	),
	// ── 操作 ──
	refresh: (
		<>
			<path d="M20 11.5A8 8 0 1 0 18.4 16" />
			<path d="M20 5v6.5h-6.5" />
		</>
	),
	reply: (
		<>
			<path d="M9 14l-5-5 5-5" />
			<path d="M4 9h9a7 7 0 0 1 7 7v3" />
		</>
	),
	share: (
		<>
			<path d="M12 15V3" />
			<path d="M6.5 7.5L12 2l5.5 5.5" />
			<path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
		</>
	),
	edit: (
		<>
			<path d="M14.5 5.5l4 4L8 20H4v-4L14.5 5.5z" />
			<path d="M12.5 7.5l4 4" />
		</>
	),
	trash: (
		<>
			<path d="M4 7h16" />
			<path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
			<path d="M6 7l1 13a1 1 0 0 0 1 .9h8a1 1 0 0 0 1-.9L18 7" />
			<path d="M10 11v6M14 11v6" />
		</>
	),
	eye: (
		<>
			<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
			<circle cx="12" cy="12" r="3" />
		</>
	),
	search: (
		<>
			<circle cx="11" cy="11" r="6.5" />
			<path d="M16 16l4.5 4.5" />
		</>
	),
	settings: (
		<>
			<circle cx="12" cy="12" r="3" />
			<path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7" />
		</>
	),
	plus: (
		<>
			<path d="M12 5v14" />
			<path d="M5 12h14" />
		</>
	),
	minus: <path d="M5 12h14" />,
	// ── 业务对象 ──
	rocket: (
		<>
			<path
				d="M12 15c-1.5-1.5-2-4-1-7 1.2-3.4 4-5.5 8-6-.5 4-2.6 6.8-6 8-3 1-5.5.5-7-1l6 6z"
				transform="rotate(45 12 12)"
			/>
			<path d="M9 15c-2 .5-3.5 2-4 5 3-.5 4.5-2 5-4" />
		</>
	),
	bolt: <path d="M13 2L4.5 13.5H11l-1 8.5L18.5 10.5H12l1-8.5z" />,
	// ── 人/群 ──
	user: (
		<>
			<circle cx="12" cy="8" r="4" />
			<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
		</>
	),
	users: (
		<>
			<circle cx="9" cy="7" r="4" />
			<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
			<path d="M22 21v-2a4 4 0 0 0-3-3.87" />
			<path d="M16 3.13a4 4 0 0 1 0 7.75" />
		</>
	),
	robot: (
		<>
			<rect x="5" y="9" width="14" height="10" rx="2.5" />
			<path d="M12 9V5.5" />
			<circle cx="12" cy="4" r="1.2" />
			<circle cx="9.5" cy="13.5" r="0.7" {...F} />
			<circle cx="14.5" cy="13.5" r="0.7" {...F} />
			<path d="M9.5 16.5h5" />
			<path d="M5 12H3v4h2M19 12h2v4h-2" />
		</>
	),
	wrench: (
		<path d="M14.5 6.5a4.2 4.2 0 0 0-5.6 5.6L4 17l3 3 4.9-4.9a4.2 4.2 0 0 0 5.6-5.6l-2.8 2.8-2.2-.7-.7-2.2 2.7-2.9z" />
	),
	image: (
		<>
			<rect x="3.5" y="5" width="17" height="14" rx="2" />
			<circle cx="9" cy="10" r="1.6" />
			<path d="M4.5 17.5l4.5-4.5 3 3 3.5-3.5 4 4" />
		</>
	),
	paperclip: (
		<path d="M18 11.5l-7.3 7.3a4.24 4.24 0 0 1-6-6l8-8a2.83 2.83 0 0 1 4 4l-7.3 7.3a1.41 1.41 0 0 1-2-2L14 8.5" />
	),
	mic: (
		<>
			<rect x="9" y="5" width="6" height="7" rx="3" />
			<path d="M18 9v2a6 6 0 0 1-12 0v-2" />
			<path d="M12 17V19" />
		</>
	),
	"mic-solid": (
		<>
			<rect x="9" y="5" width="6" height="7" rx="3" {...F} />
			<path d="M18 9v2a6 6 0 0 1-12 0v-2" />
			<path d="M12 17V19" />
		</>
	),
	monitor: (
		<>
			<rect x="3" y="4.5" width="18" height="12.5" rx="2" />
			<path d="M9 21h6M12 17v4" />
		</>
	),
	inbox: (
		<>
			<path d="M5.5 5.2L2.5 12v6a2 2 0 0 0 2 2h15a2 2 0 0 0 2-2v-6l-3-6.8a2 2 0 0 0-1.8-1.2H7.3a2 2 0 0 0-1.8 1.2z" />
			<path d="M2.5 12h5.5l2 3h4l2-3h5.5" />
		</>
	),
	smartphone: (
		<>
			<rect x="7" y="2.5" width="10" height="19" rx="2.5" />
			<path d="M10.5 18.5h3" />
		</>
	),
	pause: (
		<>
			<rect x="7" y="5" width="3.2" height="14" rx="1" {...F} />
			<rect x="13.8" y="5" width="3.2" height="14" rx="1" {...F} />
		</>
	),
	play: <path d="M8 5.5v13l10.5-6.5L8 5.5z" {...F} />,
	stop: <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" {...F} />,
	camera: (
		<>
			<path d="M4 8h3.2l1.8-2.5h6L16.8 8H20a1.5 1.5 0 0 1 1.5 1.5V18a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 18V9.5A1.5 1.5 0 0 1 4 8z" />
			<circle cx="12" cy="13.5" r="3.2" />
		</>
	),
	note: (
		<>
			<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z" />
			<path d="M14 3v5h5" />
			<path d="M9 12.5h6M9 16h6" />
		</>
	),
	book: (
		<>
			<path d="M2.5 4h5.5a4 4 0 0 1 4 4v12.5a3 3 0 0 0-3-3H2.5z" />
			<path d="M21.5 4H16a4 4 0 0 0-4 4v12.5a3 3 0 0 1 3-3h6.5z" />
		</>
	),
	pin: (
		<>
			<path d="M12 21s-6.5-5.2-6.5-10.5a6.5 6.5 0 0 1 13 0C18.5 15.8 12 21 12 21z" />
			<circle cx="12" cy="10.5" r="2.2" />
		</>
	),
	brain: (
		<>
			<path d="M9.5 4.5A2.8 2.8 0 0 0 5 7a3 3 0 0 0-1.5 5.4A3 3 0 0 0 5 18a2.8 2.8 0 0 0 4.5 1.5c.5.4 1.5.5 2.5.5V6c-1 0-2-.5-2.5-1.5z" />
			<path d="M14.5 4.5A2.8 2.8 0 0 1 19 7a3 3 0 0 1 1.5 5.4A3 3 0 0 1 19 18a2.8 2.8 0 0 1-4.5 1.5c-.5.4-1.5.5-2.5.5" />
		</>
	),
	globe: (
		<>
			<circle cx="12" cy="12" r="8.5" />
			<path d="M3.5 12h17" />
			<path d="M12 3.5c2.3 2.3 3.5 5.2 3.5 8.5s-1.2 6.2-3.5 8.5c-2.3-2.3-3.5-5.2-3.5-8.5s1.2-6.2 3.5-8.5z" />
		</>
	),
	plug: (
		<>
			<path d="M9 3v5M15 3v5" />
			<path d="M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0V8z" />
			<path d="M12 17v4" />
		</>
	),
	clipboard: (
		<>
			<rect x="5.5" y="4.5" width="13" height="16" rx="2" />
			<path d="M9 4.5V3.8A1.8 1.8 0 0 1 10.8 2h2.4A1.8 1.8 0 0 1 15 3.8v.7" />
			<path d="M9 11h6M9 15h4" />
		</>
	),
	thought: (
		<>
			<path d="M4 9a4.5 4.5 0 0 1 8.7-1.5A5 5 0 0 1 20 10a3.5 3.5 0 0 1-2 6.7V17a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-.3A4.5 4.5 0 0 1 4 9z" />
			<circle cx="9" cy="12.5" r="0.6" {...F} />
			<circle cx="12.5" cy="12.5" r="0.6" {...F} />
			<circle cx="16" cy="12.5" r="0.6" {...F} />
		</>
	),
	command: (
		<path d="M9 9h6v6H9zM9 9H7.5A2.5 2.5 0 1 1 10 6.5V9zM15 9V6.5A2.5 2.5 0 1 1 16.5 9H15zM9 15H7.5A2.5 2.5 0 1 0 10 17.5V15zM15 15v2.5a2.5 2.5 0 1 0 2.5-2.5H15z" />
	),
} as const satisfies Record<string, ReactNode>;

export type IconName = keyof typeof ICONS;

interface IconProps {
	name: IconName;
	/** 边长（px），默认 14；布局缩放场景可传 "1em" */
	size?: number | string;
	strokeWidth?: number;
	className?: string;
	style?: React.CSSProperties;
	testId?: string;
}

/** 全局统一 SVG 图标：颜色继承 currentColor，尺寸默认 14px */
export function Icon({
	name,
	size = 14,
	strokeWidth = 1.6,
	className,
	style,
	testId,
}: IconProps) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={strokeWidth}
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
			style={style}
			data-testid={testId}
			aria-hidden="true"
		>
			{ICONS[name]}
		</svg>
	);
}

/** 内联 SVG 字符串（contenteditable chip 等 innerHTML 场景），与 Icon 同一套图形 */
export function iconSvg(name: IconName, size = 12, strokeWidth = 1.8): string {
	const node = ICONS[name] as any;
	const render = (n: any): string => {
		if (n == null || typeof n === "boolean") return "";
		if (Array.isArray(n)) return n.map(render).join("");
		if (n.type === Symbol.for("react.fragment")) return render(n.props.children);
		const p = n.props ?? {};
		const attrs = Object.entries(p)
			.filter(([k]) => k !== "children")
			.map(([k, v]) => {
				const attr = k === "strokeWidth" ? "stroke-width" : k;
				return `${attr}="${v}"`;
			})
			.join(" ");
		const inner = render(p.children);
		return inner
			? `<${n.type} ${attrs}>${inner}</${n.type}>`
			: `<${n.type} ${attrs}/>`;
	};
	return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-0.125em" aria-hidden="true">${render(node)}</svg>`;
}
