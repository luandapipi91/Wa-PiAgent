/**
 * 独立预览窗口（浮动模式的承载窗口）：
 * URL 标记 / 初始参数解析 / preload IPC 桥类型。
 *
 * 浮动预览不再是主窗口内的 DOM 浮层，而是真正的系统窗口——能移出主窗口、与之并行显示。
 * 窗口加载的是同一份前端（同端口同源），靠 URL 标记分流为「预览窗口模式」，
 * 预览内容仍是窗口内的同源 iframe，因此 inspect 的 postMessage 协议完全不变。
 */

/** URL 标记：主进程 createPreviewWindow 在 loadURL 上带此参数 */
export const PREVIEW_WIN_PARAM = "wa-preview-win";

/** 独立窗口形态：同一份 SPA 承载两种窗口——html 预览（缺省）与文件预览（kind=file） */
export type PreviewWindowKind = "html" | "file";

export interface PreviewWindowParams {
	/** 预览的本地文件绝对路径（html 窗口为页面入口；file 窗口为待预览文件）；null = 无本地内容 */
	path: string | null;
	/** 外部网址；与 path 互斥（二选一，都为空 = 空窗口）。仅 html 窗口使用 */
	url: string | null;
	/** 预览归属会话 id（供代码预览 / 分享 / 元素 chip 使用） */
	sessionId: string | null;
	/** 窗口形态（主进程 loadURL 拼的 kind 参数，缺省 html 向后兼容旧窗口） */
	kind: PreviewWindowKind;
}

/** 主窗口 ↔ 独立窗口之间的中转消息（全部经主进程转发，两个渲染进程不直连） */
export type PreviewWinEvent =
	/** 独立窗口已渲染首帧 → 主进程据此显示窗口（避免白屏） */
	| { type: "ready" }
	/** 独立窗口被最小化（收成主窗口里的气泡） */
	| { type: "minimized" }
	/** 关闭预览（清该会话的预览记忆） */
	| { type: "close" }
	/** 独立窗口内切回主窗口内嵌显示 */
	| { type: "mode"; mode: "split" | "full" }
	/** 选中元素 token 回传主窗口，插入聊天输入框 */
	| { type: "element"; token: string }
	/** 窗口位置尺寸变化（屏幕坐标，主窗口持久化） */
	| { type: "rect"; rect: { x: number; y: number; w: number; h: number } }
	/** 独立窗口请求打开设置：设置弹窗是主窗口的单例（模型/技能/插件等数据都在那边加载），
	 *  独立窗口只负责转发（典型来源：未配置分享 token 时分享弹窗自动跳「设置 → 分享」） */
	| { type: "open-settings"; section: string }
	/** 预览 iframe 被站点拒绝嵌入（X-Frame-Options / CSP frame-ancestors）：
	 *  主进程经 did-fail-load(-27) 捕获后转告，渲染层改用内置浏览器窗口打开 */
	| { type: "blocked"; url: string }
	/** 独立窗口里换了预览文件：同步给主窗口（切回内嵌时恢复同一内容） */
	| { type: "path"; path: string | null }
	/** 独立窗口里换了外部网址：同步给主窗口（与 path 互斥，切回内嵌时恢复同一内容） */
	| { type: "url"; url: string | null }
	/** 窗口已关闭 */
	| { type: "closed" }
	/** 主窗口 → 独立窗口：预览文件被改动（主窗口刷新令牌已递增），独立窗口应 bump 自己的
	 *  刷新令牌重挂 iframe。此前浮动模式下该信号无人转发，外部窗口永不自动刷新 */
	| { type: "refresh" }
	/** 主窗口 → 独立窗口：同步当前预览内容（切会话/切文件/切网址时）。
	 *  url 优先：url 非空即外部预览，否则用 path（本地）；两者都为空 = 空窗口 */
	| {
			type: "sync";
			path: string | null;
			url: string | null;
			sessionId: string | null;
		};

/** preload 暴露的 IPC 桥（desktop 下存在；浏览器 dev 下 undefined，调用处用可选链） */
interface WaPiPreviewWinApi {
	/** 主窗口：请求打开/聚焦独立预览窗口（幂等单例；已存在时同步最新内容） */
	open(payload: {
		path?: string | null;
		/** 外部网址预览（与 path 互斥） */
		url?: string | null;
		sessionId?: string | null;
		/** 以最小化态开窗（会话切回重建场景）：主进程首帧 ready 后保持隐藏，气泡可点恢复 */
		minimized?: boolean;
		rect?: { x: number; y: number; w: number; h: number } | null;
	}): Promise<{ ok: boolean; reason?: string }>;
	/** 主窗口：窗口指令（close=关闭并保持关闭；hide/restore=最小化与恢复；
	 *  refresh=预览文件已改动，通知独立窗口重挂 iframe） */
	cmd(payload: { type: "close" | "hide" | "restore" | "refresh" }): void;
	/** 独立窗口：上报动作（ready / minimize / close / mode / element） */
	act(payload: { type: string; [key: string]: unknown }): void;
	/** 独立窗口：右下角缩放手柄提交内容尺寸 */
	setSize(size: { w: number; h: number }): void;
	/** 接收主进程中转的事件；返回取消订阅函数 */
	onEvent(cb: (payload: PreviewWinEvent) => void): () => void;
}

declare global {
	interface Window {
		waPiPreviewWin?: WaPiPreviewWinApi;
	}
}

/** 文件预览独立窗口的事件集（filepreviewwin:event 通道，主进程中转；与 html 窗口的
 *  PreviewWinEvent 平行且更窄：无 minimize/mode/element/blocked/refresh/url，
 *  sync 只有 path——文件预览没有外部网址形态） */
export type FilePreviewWinEvent =
	/** 主窗口切了预览文件：窗口内换内容（单例复用路径，主进程在窗口已存在时下发） */
	| { type: "sync"; path: string | null; sessionId: string | null }
	/** 窗口位置尺寸变化（屏幕坐标，主窗口侧持久化，下次弹出回原位） */
	| { type: "rect"; rect: { x: number; y: number; w: number; h: number } }
	/** 窗口已关闭（主窗口侧收尾 filePreview 状态） */
	| { type: "closed" }
	/** 窗口内换了文件（md 相对链接跳转）：同步主窗口 store（openFilePreview 幂等，回环自然终止） */
	| { type: "path"; path: string; sessionId: string | null }
	/** 独立窗口请求打开设置：设置弹窗是主窗口的单例（典型来源：未配置分享 token 时分享弹窗自动跳「设置」） */
	| { type: "open-settings"; section: string };

/** preload 暴露的文件预览独立窗口 IPC 桥（desktop 下存在；浏览器 dev 下 undefined，调用处用可选链） */
interface WaPiFilePreviewWinApi {
	/** 主窗口：请求打开/聚焦文件预览独立窗口（幂等单例；已存在时 sync 换内容） */
	open(payload: {
		path: string;
		sessionId?: string | null;
		/** 上次持久化的窗口位置尺寸（屏幕坐标），无记录传 null 用默认摆放 */
		rect?: { x: number; y: number; w: number; h: number } | null;
	}): Promise<{ ok: boolean; reason?: string }>;
	/** 主窗口：窗口指令（本期仅 close） */
	cmd(payload: { type: "close" }): void;
	/** 独立窗口：上报动作（ready / close / path / open-settings） */
	act(payload: { type: string; [key: string]: unknown }): void;
	/** 独立窗口：右下角缩放手柄提交内容尺寸 */
	setSize(size: { w: number; h: number }): void;
	/** 接收主进程中转的事件；返回取消订阅函数 */
	onEvent(cb: (payload: FilePreviewWinEvent) => void): () => void;
}

declare global {
	interface Window {
		waPiFilePreviewWin?: WaPiFilePreviewWinApi;
	}
}

/** 是否运行在独立预览窗口中（决定主入口渲染预览窗口根还是完整 App） */
export function isPreviewWindow(search: string): boolean {
	return new URLSearchParams(search).get(PREVIEW_WIN_PARAM) === "1";
}

/** 解析独立预览窗口的初始内容（与主进程 createPreviewWindow 拼的参数一一对应） */
export function parsePreviewWindowParams(search: string): PreviewWindowParams {
	const p = new URLSearchParams(search);
	return {
		path: p.get("path") || null,
		url: p.get("url") || null,
		sessionId: p.get("sid") || null,
		kind: p.get("kind") === "file" ? "file" : "html",
	};
}
