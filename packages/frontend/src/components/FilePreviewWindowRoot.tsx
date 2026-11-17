import { useEffect, useRef, useState } from "react";
import { FileViewer } from "./blocks/FileViewer";
import { ensureDragStyles, ResizeHandle } from "./PreviewWindowRoot";
import { ToastContainer } from "./ui/Toast";
import { useSessionStore } from "../store/session";
import { useSettingsStore } from "../store/settings";
import type { FilePreviewWinEvent } from "../preview-window";

/**
 * 文件预览独立窗口根（?wa-preview-win=1&kind=file）。
 *
 * 与 PreviewWindowRoot（html 预览）平行的第二种窗口形态：无边框窗口 = 顶部拖动
 * 标题栏（文件名 + 关闭）+ FileViewer + 右下角缩放手柄。与主窗口是两个渲染进程，
 * store 不共享：初始内容从 URL 参数自举，之后主窗口的变更经主进程 sync 消息同步；
 * 窗口内点 md 相对链接写的是本窗口自己的 sessionStore，由本组件消费（换内容 +
 * act path 回传主窗口，openFilePreview 幂等保证回环自然终止）。
 * 内容数据由 FileViewer 走同源 REST 自取，主进程只传参数不传内容。
 */
export function FilePreviewWindowRoot(props: {
	initialPath: string | null;
	initialSessionId: string | null;
}) {
	const [current, setCurrent] = useState({
		path: props.initialPath ?? "",
		sessionId: props.initialSessionId ?? "",
	});
	// 供订阅回调读取最新值（避免陈旧闭包）：链接跳转守卫「path 未变不动作」
	const currentRef = useRef(current);
	currentRef.current = current;
	const showSettings = useSettingsStore((s) => s.showSettings);
	const settingsSection = useSettingsStore((s) => s.activeSection);

	useEffect(() => {
		ensureDragStyles();
		// 首帧渲染完成 → 请求主进程显示窗口（避免白屏闪现）
		window.waPiFilePreviewWin?.act({ type: "ready" });
	}, []);

	// 无边框窗口没有标题栏：任务栏/窗口列表用的 document.title 跟随当前文件名
	useEffect(() => {
		const base = current.path ? (current.path.split(/[\\/]/).pop() ?? current.path) : null;
		document.title = base ? `${base} · WA PI Agent` : "WA PI Agent";
	}, [current.path]);

	useEffect(() => {
		const api = window.waPiFilePreviewWin;
		if (!api) return;
		return api.onEvent((e: FilePreviewWinEvent) => {
			if (e.type === "sync") {
				// 主窗口切了预览文件：换内容（同值守卫：避免重复触发 FileViewer 重读文件）
				setCurrent((c) =>
					c.path === (e.path ?? "") && c.sessionId === (e.sessionId ?? "")
						? c
						: { path: e.path ?? "", sessionId: e.sessionId ?? "" },
				);
			}
			// closed 由主窗口侧收尾（本窗口即将销毁），无需处理
		});
	}, []);

	// 窗口内 md 相对链接跳转：FileViewer 写的是本窗口的 sessionStore（openFilePreview），
	// 这里消费——本地换内容 + act path 回传主窗口（主窗口 driver 同步 store，
	// 同值幂等不会再触发 open/sync，回环自然终止）。首次自举不触发。
	useEffect(() => {
		let prev = useSessionStore.getState().filePreview;
		return useSessionStore.subscribe((s) => {
			const fp = s.filePreview;
			if (fp === prev) return;
			prev = fp;
			if (!fp || fp.path === currentRef.current.path) return;
			setCurrent({ path: fp.path, sessionId: fp.sessionId });
			window.waPiFilePreviewWin?.act({
				type: "path",
				path: fp.path,
				sessionId: fp.sessionId,
			});
		});
	}, []);

	// 设置弹窗是主窗口的单例弹窗：本窗口不渲染设置，把「打开设置」转发给主窗口
	// （主进程会顺便把主窗口带到前台），本地状态立即复位。典型来源：未配置分享
	// token 时分享弹窗自动跳「设置 → 分享」。
	useEffect(() => {
		if (!showSettings) return;
		window.waPiFilePreviewWin?.act({
			type: "open-settings",
			section: settingsSection,
		});
		useSettingsStore.getState().close();
	}, [showSettings, settingsSection]);

	const fileName = current.path ? (current.path.split(/[\\/]/).pop() ?? current.path) : "";
	return (
		<div
			className="flex h-screen flex-col overflow-hidden bg-surface"
			data-testid="file-preview-window-root"
		>
			{/* 顶部单行工具栏：文件名（拖动区）+ 分享/复制（FileViewer portal 进槽位，同一条线）+ 关闭 */}
			<div
				className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--hairline, #ddd)] pl-3 pr-1.5"
				data-preview-drag="1"
			>
				<span
					className="flex-1 truncate text-xs opacity-70"
					data-testid="file-preview-titlebar-name"
					title={current.path}
				>
					{fileName}
				</span>
				<div
					id="fv-toolbar-slot"
					className="flex items-center gap-2"
					data-testid="fv-toolbar-slot"
				/>
				<button
					type="button"
					className="cursor-pointer rounded px-2 py-0.5 text-sm opacity-70 hover:opacity-100"
					data-no-drag="1"
					data-testid="file-preview-titlebar-close"
					onClick={() => window.waPiFilePreviewWin?.act({ type: "close" })}
				>
					✕
				</button>
			</div>
			<div className="min-h-0 flex-1 overflow-hidden">
				<FileViewer
					path={current.path}
					sessionId={current.sessionId}
					onClose={() => window.waPiFilePreviewWin?.act({ type: "close" })}
					/* 分享/复制 portal 进标题栏槽位（与文件名同一行）；关闭由标题栏 ✕ 独家承担 */
					toolbarPortalId="fv-toolbar-slot"
				/>
			</div>
			<ResizeHandle setSize={(size) => window.waPiFilePreviewWin?.setSize(size)} />
			<ToastContainer />
		</div>
	);
}
