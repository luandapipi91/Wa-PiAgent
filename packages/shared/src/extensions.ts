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
	error: string;
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
