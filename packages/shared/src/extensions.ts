import type { CommandInfo } from "./commands";

// ===== 动态插件管理类型定义 =====

/** 已安装插件信息 */
export interface PackageInfo {
	name: string; // npm 包名 / git repo / 本地路径
	source: "npm" | "git" | "local"; // 来源类型
	version?: string; // 已安装版本（npm）
	latestVersion?: string; // npm registry 最新版本
	description?: string; // 从 package.json 读取
	enabled: boolean; // 是否在 packages 数组中
}

// ===== WS 协议事件 =====

// 前端 → kernel
export interface ExtensionListEvent {
	type: "extension:list";
}
export interface ExtensionInstallEvent {
	type: "extension:install";
	name: string;
}
export interface ExtensionUninstallEvent {
	type: "extension:uninstall";
	name: string;
}
export interface ExtensionUpgradeEvent {
	type: "extension:upgrade";
	name: string;
}
/** 全量重建扩展依赖目录（删 node_modules+bun.lock 后重装） */
export interface ExtensionRepairEvent {
	type: "extension:repair";
}
export interface ExtensionToggleEvent {
	type: "extension:toggle";
	name: string;
	enabled: boolean;
}

// kernel → 前端
export interface ExtensionListResult {
	type: "extension:list";
	packages: PackageInfo[];
}
export interface ExtensionChangedEvent {
	type: "extension:changed";
	packages: PackageInfo[];
}
export interface ExtensionErrorEvent {
	type: "extension:error";
	name: string;
	/** 错误信息（KernelError 时为 code，老渲染兑底用） */
	error: string;
	/** 结构化错误：code 由前端字典渲染；detail 为技术细节 */
	code?: string;
	params?: Record<string, string | number>;
	detail?: string;
}
/** 安装/升级期间流式推送的包管理器日志行；name 为用户原始输入 */
export interface ExtensionProgressEvent {
	type: "extension:progress";
	name: string;
	message: string;
}
/** 安装成功终态信号；前端据此清除占位卡（真实卡片由 extension:changed 提供）；name 为用户原始输入 */
export interface ExtensionInstallDoneEvent {
	type: "extension:install:done";
	name: string;
}
/** 修复期间流式推送的包管理器日志行（与 extension:progress 同广播机制） */
export interface ExtensionRepairProgressEvent {
	type: "extension:repair:progress";
	message: string;
}
/** 修复成功终态信号 */
export interface ExtensionRepairDoneEvent {
	type: "extension:repair:done";
}
/** pi 扩展 ctx.ui.notify 反馈（如 /lens-toggle 的执行结果）：kernel 转发为事件，前端 toast 展示 */
export interface ExtensionNotifyEvent {
	type: "extension_notify";
	message: string;
	notifyType?: string;
}

// 前端 → kernel：插件命令页（无 session 上下文）
export interface ExtensionCommandsListEvent {
	type: "extension:commands:list";
}
export interface ExtensionCommandToggleEvent {
	type: "extension:commands:toggle";
	packageName: string; // 裸包名（waPiCommandToggles key）
	command: string;
	enabled: boolean;
}

// kernel → 前端
export interface ExtensionCommandsListResult {
	type: "extension:commands:list";
	commands: CommandInfo[];
}
export interface ExtensionCommandToggleResult {
	type: "extension:commands:toggle";
	ok: true;
}

/** kernel → 前端：命令开关切换成功后广播，前端据此刷新 / 菜单命令列表 */
export interface ExtensionCommandsChangedEvent {
	type: "extension:commands:changed";
}

// 前端 → kernel：pi 扩展 dialog（select/confirm/input/editor）应答
export interface ExtensionDialogRespondEvent {
	type: "extension:dialog:respond";
	requestId: string;
	sessionId?: string;
	value?: unknown;
	confirmed?: boolean;
	cancelled?: boolean;
}

// kernel → 前端
export interface ExtensionDialogRespondResult {
	type: "extension:dialog:respond";
	ok: true;
}

// 前端 → kernel：扩展 TUI 面板（ctx.ui.custom / widget 组件兼容）的输入事件，
// kernel 入队后由扩展的输入订阅流取走（规格 §5.3）。
// 注：REST 体里输入类型字段名是 `type`（规格 §5.3 的线上协议，与事件判别字段同名），
// routes/extensions.ts 把它映射到这里的 inputType，避免与判别字段撞名。
export interface ExtensionTuiInputEvent {
	type: "extension:tui:input";
	sessionId: string;
	/** custom 面板为 `p<n>`，widget 面板为 `w:<key>` */
	panelId: string;
	/** 输入类型：按键/粘贴/鼠标序列/尺寸/取消面板 */
	inputType: "key" | "paste" | "mouse" | "resize" | "cancel";
	/** key/paste/mouse 的终端序列或文本 */
	data?: string;
	/** resize 的目标列数/行数 */
	cols?: number;
	rows?: number;
}

// kernel → 前端
export interface ExtensionTuiInputResult {
	type: "extension:tui:input";
	ok: true;
}

// 前端 → kernel：拉取会话的面板快照（补发路由，规格 §5.4；何时调用由前端的会话切换/重连逻辑决定）
export interface ExtensionTuiSnapshotEvent {
	type: "extension:tui:snapshot";
	sessionId: string;
}

// kernel → 前端：面板快照端点（GET /api/extensions/tui-snapshot）的响应，
// 即规格 §5.4「先 extension_tui_open，再最后缓存的一帧」所需的数据源。
export interface ExtensionTuiSnapshotResult {
	type: "extension:tui:snapshot";
	/** registry 里该会话的全部面板（含 kind=widget，前端 store 只消费 custom，见规格 §6.4） */
	panels: ExtensionTuiSnapshotPanel[];
}

/** 快照里的单个面板：registry 的 TuiPanelMeta + 最新缓存帧 */
export interface ExtensionTuiSnapshotPanel {
	panelId: string;
	kind: "custom" | "widget";
	title: string;
	cols: number;
	rows: number;
	/** 同会话排队中的面板数（含当前） */
	pending: number;
	/** kind=widget 时的 widget key（前端 widget dock 的键） */
	widgetKey?: string;
	placement?: "aboveEditor" | "belowEditor";
	/** 最后一帧（行内可含 ANSI）；面板尚未渲染过帧时为 null */
	lastFrame: { lines: string[]; cursor: { row: number; col: number } | null } | null;
}
