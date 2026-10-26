// 系统通知请求侧：组装 i18n 文案后经 window.waPiNotice 桥交主进程发送。
// 前台窗口拦截判断在主进程，渲染端不做前台判断。
import i18n from "../i18n";
import { useProjectsStore } from "./projects";

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
	}): Promise<{ sent: boolean; reason?: string }>;
	onAction(cb: (action: NoticeAction) => void): () => void;
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
		})
		.catch(() => {});
}
