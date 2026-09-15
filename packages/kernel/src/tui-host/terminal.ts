import type { Terminal } from "@earendil-works/pi-tui";

export interface FakeTerminalOptions {
	/** 初始列数（字符格），默认 85 */
	cols?: number;
	/** 初始行数（字符格），默认 24 */
	rows?: number;
}

/** 尺寸下限：过小会让 pi-tui 的布局计算产出空帧 */
const MIN_COLS = 20;
const MIN_ROWS = 5;

/**
 * 假 Terminal：给 pi-tui 的 TUI 实例一个"终端"外观。
 *
 * 只有三个成员有真实语义：
 *  - start() 保存回调；onInput 是宿主注入按键的唯一入口，onResize 触发重排
 *  - columns/rows 反映面板当前字符尺寸（由前端上报）
 *  - write() 丢弃字节：真实渲染由 frame.ts 直接调 TUI.render(width) 取帧，
 *    不解析差分输出，因此这里不需要终端模拟器
 * 其余成员维持 no-op，保证 TUI 内部调用不会抛错。
 */
export class WaPiFakeTerminal implements Terminal {
	private onInputCb: ((data: string) => void) | null = null;
	private onResizeCb: (() => void) | null = null;
	private _cols: number;
	private _rows: number;
	/** 被丢弃的字节数，仅用于诊断 */
	bytesDiscarded = 0;

	constructor(opts: FakeTerminalOptions = {}) {
		this._cols = opts.cols ?? 85;
		this._rows = opts.rows ?? 24;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.onInputCb = onInput;
		this.onResizeCb = onResize;
	}

	stop(): void {
		this.onInputCb = null;
		this.onResizeCb = null;
	}

	async drainInput(): Promise<void> {
		/* 没有 stdin，无需排空 */
	}

	write(data: string): void {
		this.bytesDiscarded += data.length;
	}

	get columns(): number {
		return this._cols;
	}

	get rows(): number {
		return this._rows;
	}

	/** 不启用 kitty 键盘协议：前端按键编码因此只需覆盖传统序列 */
	get kittyProtocolActive(): boolean {
		return false;
	}

	/** 前端上报新尺寸；变化时触发一次重排 */
	resize(cols: number, rows: number): void {
		const nextCols = Math.max(MIN_COLS, Math.floor(cols));
		const nextRows = Math.max(MIN_ROWS, Math.floor(rows));
		if (nextCols === this._cols && nextRows === this._rows) return;
		this._cols = nextCols;
		this._rows = nextRows;
		this.onResizeCb?.();
	}

	/** 宿主注入按键（原始终端序列） */
	inject(data: string): void {
		this.onInputCb?.(data);
	}

	// —— Terminal 接口要求的 no-op 成员 ——
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
}
