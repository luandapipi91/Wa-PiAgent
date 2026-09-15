/**
 * 浏览器键盘 / 鼠标 / 粘贴事件 → 终端按键序列的纯函数。
 *
 * 面板里的假终端只负责把序列写进 kernel，因此这里必须与真实终端约定一致。
 */
export interface KeyLike {
	key: string;
	ctrlKey: boolean;
	altKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
}

const NAMED: Record<string, string> = {
	ArrowUp: "\u001b[A",
	ArrowDown: "\u001b[B",
	ArrowRight: "\u001b[C",
	ArrowLeft: "\u001b[D",
	Home: "\u001b[H",
	End: "\u001b[F",
	PageUp: "\u001b[5~",
	PageDown: "\u001b[6~",
	Delete: "\u001b[3~",
	Enter: "\r",
	Escape: "\u001b",
	Backspace: "\u007f",
	Tab: "\t",
};

/** 修饰键本身不发序列 */
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Dead"]);

/**
 * 浏览器键盘事件 → 终端按键序列；无法映射时返回 null（调用方忽略该按键）。
 *
 * 三条原则：
 * 1. meta（Cmd）组合一律放行给浏览器，否则面板里无法复制/粘贴；
 * 2. kitty 键盘协议未启用（假终端恒报 false），只需传统序列；
 * 3. 不认识的功能键返回 null，不猜。
 */
export function encodeKey(e: KeyLike): string | null {
	if (e.metaKey) return null;
	if (MODIFIER_KEYS.has(e.key)) return null;

	const named = NAMED[e.key];
	if (named !== undefined) {
		const seq = e.key === "Tab" && e.shiftKey ? "\u001b[Z" : named;
		return e.altKey ? `\u001b${seq}` : seq;
	}

	if (e.key.length === 1) {
		if (e.ctrlKey) {
			const code = e.key.toLowerCase().charCodeAt(0);
			return code >= 97 && code <= 122 ? String.fromCharCode(code - 96) : null;
		}
		return e.altKey ? `\u001b${e.key}` : e.key;
	}

	return null;
}

/** 鼠标按键 → SGR 鼠标序列（左 0 / 中 1 / 右 2；坐标 1-based） */
export function encodeMouse(
	phase: "down" | "up" | "drag",
	button: number,
	col: number,
	row: number,
): string {
	const base = phase === "drag" ? button + 32 : button;
	const final = phase === "up" ? "m" : "M";
	return `\u001b[<${base};${Math.max(1, col)};${Math.max(1, row)}${final}`;
}

/** 滚轮 → SGR 鼠标序列（上 64 / 下 65；坐标 1-based，由调用方换算成终端列行） */
export function encodeWheel(direction: "up" | "down", col: number, row: number): string {
	const code = direction === "up" ? 64 : 65;
	return `\u001b[<${code};${Math.max(1, col)};${Math.max(1, row)}M`;
}

/** 粘贴 → bracketed paste，防止多行内容被 TUI 当成逐个回车 */
export function encodePaste(text: string): string {
	return `\u001b[200~${text}\u001b[201~`;
}
