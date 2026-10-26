// 通知发送层（v2 卡片）：渲染进程 notice:send → 通知队列 + 通知卡片窗口（5s 自动消失）。
// 组合关系：queue（纯逻辑，notice-queue.cjs）+ controller（窗口，notice-card-window.cjs）
// + 倒计时状态机（本模块）；Electron 组件由调用方注入（解耦 Electron，便于单测，
// 同 util/native-dialogs.cjs），timer 可注入（测试用 fake，默认 setTimeout/Date.now）。
const { createNoticeQueue } = require("./notice-queue.cjs");
const { createNoticeCardController } = require("./notice-card-window.cjs");

// 前台判定：最小化或未聚焦即视为后台。仅 backgroundOnly:true 的请求受此拦截，非 backgroundOnly 照发。
function isBackgrounded(win) {
	return win.isMinimized() || !win.isFocused();
}

/** 卡片自动消失倒计时时长（毫秒）：无交互（未悬停）5s 后隐藏并清空队列。 */
const CARD_AUTO_HIDE_MS = 5000;

/**
 * 从 action 提取稳定合并键（同键通知在队列里合并为一条）：
 * - 会话通知（action.type === "session"）按会话聚合：`session:<sessionId>`——同一会话多轮完成只留最新一条；
 * - 其余有 type 的（如 update）按类型聚合：`update:<type>`——同类通知只留最新一条；
 * - 拿不到稳定键（无 action / 无 type / type 非字符串）返回 undefined → 队列不合并、每次各自成条。
 * 键只用于合并判定；队列条目的 action 载荷原样透传，不受键影响。
 */
function mergeKeyOf(action) {
	if (!action || typeof action !== "object") return undefined;
	if (action.type === "session" && action.sessionId != null)
		return `session:${action.sessionId}`;
	if (typeof action.type === "string") return `update:${action.type}`;
	return undefined;
}

/**
 * @param {object} deps
 * @param {() => import("electron").BrowserWindow | null} deps.getMainWindow 主窗口（卡片点击 → notice:action 下行广播用）
 * @param {() => void} deps.activateApp 点卡片激活应用（透传给 controller，Dock/托盘点击同款逻辑）
 * @param {import("electron").IpcMain} deps.ipcMain
 * @param {typeof import("electron").BrowserWindow} deps.BrowserWindow（透传给 controller）
 * @param {() => import("electron").Display} deps.getPrimaryDisplay 主屏（透传给 controller，卡片锚定主屏）
 * @param {import("./util/log.cjs").Logger} [deps.log]
 * @param {{set:(fn:()=>void, ms:number)=>any, clear:(id:any)=>void, now:()=>number}} [deps.timer]
 *   可注入计时器（测试用 fake），默认 setTimeout/clearTimeout/Date.now
 */
function setupNotice({
	getMainWindow,
	activateApp,
	ipcMain,
	BrowserWindow,
	getPrimaryDisplay,
	log,
	timer,
}) {
	const queue = createNoticeQueue();
	const t = timer ?? {
		set: (fn, ms) => setTimeout(fn, ms),
		clear: (id) => clearTimeout(id),
		now: () => Date.now(),
	};

	// ---- 倒计时状态机：start（启动/重置）/ pause（记剩余）/ resume（续剩余）/ stop ----
	// 到期 → 隐藏卡片 + 清空队列。pause 记剩余毫秒，resume 从当前时刻续跑剩余时长。
	let timerId = null;
	let deadline = 0; // 到期的绝对时刻（t.now() 时基）
	let remainingMs = null; // 非 null 表示处于暂停态

	const stopCountdown = () => {
		if (timerId != null) {
			t.clear(timerId);
			timerId = null;
		}
		remainingMs = null;
	};
	const startCountdown = () => {
		stopCountdown();
		deadline = t.now() + CARD_AUTO_HIDE_MS;
		timerId = t.set(onExpire, CARD_AUTO_HIDE_MS);
	};
	const pauseCountdown = () => {
		if (timerId == null) return; // 未在计时（未启动/已暂停/已到期）：忽略
		t.clear(timerId);
		timerId = null;
		remainingMs = Math.max(0, deadline - t.now());
	};
	const resumeCountdown = () => {
		if (remainingMs == null || timerId != null) return; // 未暂停过：忽略
		deadline = t.now() + remainingMs;
		timerId = t.set(onExpire, remainingMs);
		remainingMs = null;
	};
	const onExpire = () => {
		timerId = null;
		remainingMs = null;
		controller.hide();
		queue.clear();
	};

	// 最近一次 showCard 的 theme：卡片事件刷新显示时沿用（notice:send 之外没有新的 theme 来源）
	let lastTheme;
	const refresh = () => controller.showCard(queue.items, queue.index, lastTheme);

	const controller = createNoticeCardController({
		BrowserWindow,
		ipcMain,
		getPrimaryDisplay,
		activateApp,
		log,
		// 卡片上行事件（notice-card:event，controller 已做 sender 校验并先调 activateApp）。
		// 上行协议见 notice-card.html 顶部注释：click 无载荷 / hover 用 action 字段 / switch 用 dir 字段。
		onAction: (evt) => {
			if (!evt || typeof evt !== "object") return;
			if (evt.type === "card:click") {
				// 点的是「当前条目」：卡片上行不带 action 载荷，从队列当前条原样取
				// （下行通道与 v1 系统通知一致，渲染侧 notice:action 监听不变）
				const current = queue.items[queue.index];
				if (current?.action != null) {
					const win = getMainWindow();
					if (win && !win.isDestroyed()) {
						win.webContents.send("notice:action", current.action);
					}
				}
				// 点击 = 已处理：移除当前条；队列空 → 停倒计时并关卡片；否则刷新显示下一条并重置倒计时
				// （规格「交互规格（批准稿）」：「否则显示下一条并重置倒计时」。尊重暂停态：
				// 悬停中 → 重置为满额暂停（remainingMs=满额、不设 timer，resume 从满额跑）；
				// 运行中 → 照常 startCountdown()。避免点击把用户注视中的卡片提前收走）
				if (queue.removeCurrent()) {
					stopCountdown();
					controller.hide();
					queue.clear();
				} else {
					refresh();
					if (remainingMs != null) remainingMs = CARD_AUTO_HIDE_MS;
					else startCountdown();
				}
			} else if (evt.type === "card:hover") {
				if (evt.action === "pause") pauseCountdown();
				else resumeCountdown();
			} else if (evt.type === "card:switch") {
				if (queue.count === 0) return; // 队列已空（卡片应已隐藏）：忽略残留事件
				if (evt.dir === "prev") queue.prev();
				else queue.next();
				refresh();
				startCountdown(); // 切换 = 用户仍在浏览：重置 5s
			}
		},
	});

	ipcMain.handle("notice:send", (_event, payload) => {
		// 防御：title 必须是字符串（渲染侧契约），异常载荷直接拒绝
		if (typeof payload?.title !== "string") {
			return { sent: false, reason: "invalid" };
		}
		// backgroundOnly:true 仅在窗口于后台（最小化/未聚焦）时显示
		if (payload.backgroundOnly && !isBackgrounded(getMainWindow())) {
			return { sent: false, reason: "foreground" };
		}
		queue.enqueue({
			title: payload.title,
			body: payload.body,
			action: payload.action,
			sessionId: mergeKeyOf(payload.action),
		});
		lastTheme = payload.theme;
		refresh();
		startCountdown(); // 新通知重新计 5s
		return { sent: true };
	});
}

module.exports = { isBackgrounded, setupNotice };
