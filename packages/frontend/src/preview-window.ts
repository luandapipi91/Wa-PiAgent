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

export interface PreviewWindowParams {
	/** 预览的本地 html 绝对路径；null = 无本地预览（空窗口或外部网址预览） */
	path: string | null;
	/** 外部网址；与 path 互斥（二选一，都为空 = 空窗口） */
	url: string | null;
	/** 预览归属会话 id（供代码预览 / 分享 / 元素 chip 使用） */
	sessionId: string | null;
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
	/** 独立窗口里换了预览文件：同步给主窗口（切回内嵌时恢复同一内容） */
	| { type: "path"; path: string | null }
	/** 独立窗口里换了外部网址：同步给主窗口（与 path 互斥，切回内嵌时恢复同一内容） */
	| { type: "url"; url: string | null }
	/** 窗口已关闭 */
	| { type: "closed" }
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
		rect?: { x: number; y: number; w: number; h: number } | null;
	}): Promise<{ ok: boolean; reason?: string }>;
	/** 主窗口：窗口指令（close=关闭并保持关闭；hide/restore=最小化与恢复） */
	cmd(payload: { type: "close" | "hide" | "restore" }): void;
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

/** 是否运行在独立预览窗口中（决定主入口渲染预览窗口根还是完整 App） */
export function isPreviewWindow(search: string): boolean {
	return new URLSearchParams(search).get(PREVIEW_WIN_PARAM) === "1";
}

/** 解析独立预览窗口的初始预览内容（与主进程 createPreviewWindow 拼的参数一一对应） */
export function parsePreviewWindowParams(search: string): PreviewWindowParams {
	const p = new URLSearchParams(search);
	return {
		path: p.get("path") || null,
		url: p.get("url") || null,
		sessionId: p.get("sid") || null,
	};
}
