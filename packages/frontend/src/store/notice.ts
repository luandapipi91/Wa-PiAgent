// 系统通知请求侧：组装 i18n 文案后经 window.waPiNotice 桥交主进程发送。
// 前台窗口拦截判断在主进程，渲染端不做前台判断。
import i18n from "../i18n";
import { useBrowserStore } from "./browser";
import { useProjectsStore } from "./projects";
import { useSettingsStore } from "./settings";
import { useUiPrefsStore, type ThemeMode } from "./ui-prefs";
import { useUpdaterStore } from "./updater";

// 通知点击动作：session=跳转会话；update=查看更新内容（消费在后续任务）
export type NoticeAction =
	| { type: "session"; sessionId: string }
	| { type: "update" };

interface WaPiNoticeApi {
	send(payload: {
		title: string;
		body: string;
		action: NoticeAction;
		backgroundOnly?: boolean;
		theme: "light" | "dark";
	}): Promise<{ sent: boolean; reason?: string }>;
	onAction(cb: (action: NoticeAction) => void): () => void;
}

/**
 * themeMode → 通知卡片主题："dark" → 深色；"light"/"system" → 浅色
 * （跟随系统时读不到系统明暗值，用 light 兜底）。两处通知 payload 组装共用。
 */
export function noticeTheme(mode: ThemeMode): "light" | "dark" {
	return mode === "dark" ? "dark" : "light";
}

declare global {
	interface Window {
		waPiNotice?: WaPiNoticeApi;
	}
}

/**
 * 请求主进程发「任务完成」系统通知：文案按当前应用语言在渲染端组装。
 * 会话名取不到或为空串时用「未命名会话」兜底；浏览器版（无 window.waPiNotice）静默 no-op。
 */
export function requestTaskDoneNotice(sessionId: string): void {
	const api = window.waPiNotice;
	if (!api) return;
	const sessionTitle =
		useProjectsStore.getState().sessions.find((x) => x.id === sessionId)
			?.title ?? "";
	const body = sessionTitle
		? i18n.t("notice.taskDoneBody", { title: sessionTitle })
		: i18n.t("notice.untitledSession");
	// send 为 IPC invoke，失败时静默降级，避免 unhandled rejection 报错刷屏
	void api
		.send({
			title: i18n.t("notice.taskDoneTitle"),
			body,
			action: { type: "session", sessionId },
			backgroundOnly: true,
			theme: noticeTheme(useUiPrefsStore.getState().themeMode),
		})
		.catch(() => {});
}

/** 本地时区 YYYY-MM-DD。手工拼年月日补零；禁用 toISOString()（UTC 偏移会错日）。 */
export function localDateString(d: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 更新通知自然日去重：lastDate 不等于 today（含从未发过）→ 应发。 */
export function shouldSendUpdateNotice(
	today: string,
	lastDate?: string,
): boolean {
	return lastDate !== today;
}

/**
 * 场景②「新版本」系统通知：启动时自动检测更新，status 变为 available 时发通知；
 * 每自然日至多一条（lastUpdateNoticeDate 记录在 ui-prefs 持久化）。
 * 仅 status===available 且 latestVersion 非空时发；dev 未打包主进程返回 reason:"dev"，
 * 不会出现 available，自然不触发。浏览器版（无 window.waPiNotice）连检测也不启动，
 * 返回 no-op 清理函数（桌面专属功能）。
 */
export function initUpdateNotice(): () => void {
	const api = window.waPiNotice;
	if (!api) return () => {};
	void useUpdaterStore.getState().checkForUpdates(); // 启动自动检测，不 await 阻塞挂载
	return useUpdaterStore.subscribe((s) => {
		if (s.status !== "available" || !s.latestVersion) return;
		const today = localDateString(new Date());
		if (
			!shouldSendUpdateNotice(
				today,
				useUiPrefsStore.getState().lastUpdateNoticeDate,
			)
		)
			return;
		// send 为 IPC invoke，失败时静默降级；无论成败都记日，保证每自然日至多一条
		void api
			.send({
				title: i18n.t("notice.updateTitle", { version: s.latestVersion }),
				body: i18n.t("notice.updateBody"),
				action: { type: "update" },
				theme: noticeTheme(useUiPrefsStore.getState().themeMode),
			})
			.catch(() => {});
		useUiPrefsStore.getState().setLastUpdateNoticeDate(today);
	});
}

/**
 * 通知点击下行分发：按 action.type 唤起对应界面。
 * session：照 Sidebar onSelectSession 模板——activateSession 切浏览器预览；会话在列表
 *   直接选中，不在列表（如 kernel 侧建的 IM 接入会话尚未同步）先重拉再选中。
 * update：打开设置并定位「关于」页（查看新版本内容）。
 * 返回跳转目标供 UI 层补充视图切换（"session" → setView("session")，setView 是 App
 * 内部 state 不能在这里调）；未知 type 返回 null 且三个 store 均不变。
 */
export function handleNoticeAction(
	action: NoticeAction,
): "session" | "settings" | null {
	if (action.type === "session") {
		useBrowserStore.getState().activateSession(action.sessionId);
		const st = useProjectsStore.getState();
		if (st.sessions.some((x) => x.id === action.sessionId)) {
			st.selectSession(action.sessionId);
		} else {
			// 兜底：会话不在本地列表时先重拉再选中，否则 SessionView 找不到 session 渲染空白
			void st
				.load()
				.then(() =>
					useProjectsStore.getState().selectSession(action.sessionId),
				);
		}
		return "session";
	}
	if (action.type === "update") {
		useSettingsStore.getState().open();
		useSettingsStore.getState().setSection("about");
		return "settings";
	}
	return null;
}
