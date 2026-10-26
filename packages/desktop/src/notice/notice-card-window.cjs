// 通知卡片窗口（通知系统 v2 发送层的窗口部分）：建窗/复用/销毁重建、主屏右下角定位、
// 队列载荷下行（notice-card:update）与卡片事件上行（notice-card:event → onAction 回调）。
// 画面本体是同目录 notice-card.html（单文件零依赖，内联 CSS/JS，不进 React dist）。
// 依赖全部经参数注入（BrowserWindow/ipcMain/log/...），便于单测——风格同 pet-window.cjs。
// 窗口参数照 pet-window 先例：无边框/透明/置顶/跳过任务栏/macOS panel。
// 队列与倒计时不在本模块：队列纯逻辑见 notice-queue.cjs，接线见调用方。
const path = require("node:path");

/** 卡片基准尺寸（标题 + 正文 + 条数指示 + 左右箭头，以内容适配为准） */
const NOTICE_CARD_W = 320;
const NOTICE_CARD_H = 96;
/** 距主屏 workArea 右/下边缘的边距 */
const NOTICE_CARD_MARGIN = 16;
/** 拿不到显示器时的兜底工作区（照 pet-window defaultBounds 的兜底思路） */
const FALLBACK_WORK_AREA = { x: 0, y: 0, width: 1920, height: 1080 };

/**
 * 装配通知卡片窗口控制器。
 * @param {object} deps
 * @param {typeof import("electron").BrowserWindow} deps.BrowserWindow
 * @param {import("electron").IpcMain} deps.ipcMain
 * @param {() => { workArea: {x:number,y:number,width:number,height:number} }} deps.getPrimaryDisplay 主屏（多屏时卡片锚定主屏）
 * @param {() => void} [deps.activateApp] 点击卡片主体后激活应用（规格：点击卡片后激活主窗口）
 * @param {(evt: object) => void} [deps.onAction] 卡片上行事件回调（card:click / card:hover / card:switch，载荷透传）
 */
function createNoticeCardController(deps = {}) {
	// 解构放函数体内而不是参数表：同 pet-window.cjs——参数表里带默认值会让 tsc 推断出
	// 参数对象类型，测试里传 mock 依赖会被多余属性检查拦下。
	const { getPrimaryDisplay, activateApp, onAction } = deps;
	const BrowserWindow = deps.BrowserWindow;
	const ipcMain = deps.ipcMain;
	const log = deps.log;

	let win = null;
	/** did-finish-load 是否已触发：决定 showCard 直接下行还是缓存到页面就绪后补发 */
	let pageReady = false;
	/** 最近一次 showCard 载荷；页面就绪晚于显示请求时补发用，hide 时清空 */
	let lastPayload = null;

	const cardHtml = path.join(__dirname, "notice-card.html");
	// 加载共享 preload（同主窗口/link-window 复用模式）：桥是 preload.cjs 的 waPiNoticeCard 段
	const cardPreload = path.join(__dirname, "..", "preload.cjs");

	const isCardSender = (event) =>
		Boolean(win) && !win.isDestroyed() && event.sender === win.webContents;

	/** 主屏 workArea；拿不到时回落兜底矩形，页面照常工作 */
	const primaryWorkArea = () => {
		try {
			const area = getPrimaryDisplay().workArea;
			if (
				area &&
				Number.isFinite(area.x) &&
				Number.isFinite(area.y) &&
				area.width > 0 &&
				area.height > 0
			) {
				return area;
			}
		} catch {
			/* 拿不到就用兜底矩形 */
		}
		return FALLBACK_WORK_AREA;
	};

	const create = () => {
		win = new BrowserWindow({
			width: NOTICE_CARD_W,
			height: NOTICE_CARD_H,
			transparent: true, // 圆角卡片（页面 body 透明）
			frame: false, // 无边框
			resizable: false,
			// macOS NSPanel：不参与普通窗口枚举、不进 Cmd+Tab，顺带不抢焦点（照 pet-window）
			type: "panel",
			skipTaskbar: true, // 不占任务栏（Windows / Linux）
			hasShadow: false, // 透明窗口必须去掉窗口投影
			useContentSize: true,
			show: false, // 等页面加载完再 showInactive，避免空白帧
			alwaysOnTop: true, // 置顶：通知不能被应用窗口盖住
			webPreferences: {
				nodeIntegration: false,
				contextIsolation: true,
				sandbox: false, // preload 需要 require('electron')
				preload: cardPreload,
			},
		});
		const w = win;
		pageReady = false;
		w.webContents.once("did-finish-load", () => {
			pageReady = true;
			if (w !== win || w.isDestroyed()) return;
			if (!lastPayload) return;
			// 显示请求先于页面就绪：补发最新载荷后显示（重复 update 对页面幂等）
			try {
				w.webContents.send("notice-card:update", lastPayload);
				w.showInactive();
			} catch (e) {
				log?.error?.("[notice-card] 页面就绪补发失败", e);
			}
		});
		// 窗口被外部关闭（系统等）：置空引用，下次 showCard 走重建
		w.on("closed", () => {
			if (win === w) win = null;
		});
		w.loadFile(cardHtml);
		return win;
	};

	/** 按需创建 / 复用存活窗口；已销毁则重建。 */
	const ensureWindow = () => {
		if (win && !win.isDestroyed()) return win;
		return create();
	};

	/**
	 * 显示卡片：定位主屏 workArea 右下角（边距 16px）→ 下行队列载荷 → showInactive（不抢焦点）。
	 * @param {Array<{title:string, body:string, action?:object, sessionId?:string}>} items 队列条目
	 * @param {number} index 当前条目索引
	 * @param {string} [theme] "light" | "dark"（缺省时页面按浅色渲染）
	 */
	const showCard = (items, index, theme) => {
		const w = ensureWindow();
		if (!w) return;
		const list = Array.isArray(items) ? items : [];
		const payload = { items: list, index, theme, count: list.length };
		lastPayload = payload;
		// 每次显示都重新定位：主屏 / 分辨率可能已变化，卡片始终锚定当前主屏右下角
		const area = primaryWorkArea();
		try {
			w.setBounds({
				x: Math.round(area.x + area.width - NOTICE_CARD_W - NOTICE_CARD_MARGIN),
				y: Math.round(area.y + area.height - NOTICE_CARD_H - NOTICE_CARD_MARGIN),
				width: NOTICE_CARD_W,
				height: NOTICE_CARD_H,
			});
		} catch (e) {
			log?.error?.("[notice-card] 定位失败", e);
		}
		if (!pageReady) return; // 页面就绪后由 did-finish-load 补发并显示
		try {
			w.webContents.send("notice-card:update", payload);
			w.showInactive(); // 显示但不抢焦点（通知不打断当前输入）
		} catch (e) {
			log?.error?.("[notice-card] 显示/下行失败", e);
		}
	};

	/** 隐藏卡片（窗口保留复用）；清空待显载荷，页面就绪回调不得再把它弹出来。 */
	const hide = () => {
		lastPayload = null;
		if (!win || win.isDestroyed()) return;
		try {
			win.hide();
		} catch (e) {
			log?.error?.("[notice-card] 隐藏失败", e);
		}
	};

	// 上行：卡片 → 主进程（点击 / 悬停暂停恢复 / 左右切换）。只认卡片窗口 sender，
	// 载荷透传给调用方回调；点击主体先激活应用（规格：点击卡片后激活主窗口），
	// 跳转指令仍由调用方处理——controller 不做倒计时与队列操作。
	if (ipcMain && typeof ipcMain.on === "function") {
		ipcMain.on("notice-card:event", (event, evt) => {
			if (!isCardSender(event)) return;
			if (!evt || typeof evt !== "object") return;
			if (evt.type === "card:click" && typeof activateApp === "function") {
				try {
					activateApp();
				} catch (e) {
					log?.error?.("[notice-card] 激活应用失败", e);
				}
			}
			if (typeof onAction === "function") onAction(evt);
		});
	}

	return { ensureWindow, showCard, hide };
}

module.exports = {
	createNoticeCardController,
	NOTICE_CARD_W,
	NOTICE_CARD_H,
	NOTICE_CARD_MARGIN,
};
