import { useEffect, useMemo, type MouseEvent as ReactMouseEvent } from "react";
import { BrowserPanel } from "./BrowserPanel";
import { FilePreviewModal } from "./blocks/FilePreviewModal";
import { ToastContainer } from "./ui/Toast";
import { useBrowserStore } from "../store/browser";
import { useProjectsStore } from "../store/projects";
import { useSettingsStore } from "../store/settings";
import {
	parsePreviewWindowParams,
	type PreviewWinEvent,
} from "../preview-window";

/** 拖拽区样式（注入一次）：-webkit-app-region 是 Electron 扩展属性，用 data 属性集中声明 */
let dragStylesInjected = false;
function ensureDragStyles() {
	if (dragStylesInjected || typeof document === "undefined") return;
	dragStylesInjected = true;
	const style = document.createElement("style");
	// 工具栏空白区拖动窗口；内部交互元素必须显式 no-drag（drag 区会吞掉点击）
	style.textContent = `
		[data-preview-drag="1"] { -webkit-app-region: drag; }
		[data-preview-drag="1"] button,
		[data-preview-drag="1"] input,
		[data-preview-drag="1"] [data-no-drag] { -webkit-app-region: no-drag; }
	`;
	document.head.appendChild(style);
}

/**
 * 右下角缩放手柄：原生窗口的尺寸变化只能由主进程 setBounds 完成，
 * 因此拖动中不用 React 状态，直接按帧提交新尺寸。
 * 用屏幕坐标而非 clientX/Y：指针移出窗口时 clientX 被裁剪在视口内，会追不上鼠标。
 */
function ResizeHandle() {
	const onMouseDown = (e: ReactMouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		const onMove = (ev: MouseEvent) =>
			window.waPiPreviewWin?.setSize({
				w: ev.screenX - window.screenX,
				h: ev.screenY - window.screenY,
			});
		const onUp = () => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
			document.body.style.userSelect = "";
		};
		document.body.style.userSelect = "none";
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
	};
	return (
		<div
			data-testid="preview-window-resize"
			data-no-drag="1"
			onMouseDown={onMouseDown}
			style={{
				position: "fixed",
				right: 0,
				bottom: 0,
				width: 14,
				height: 14,
				cursor: "nwse-resize",
				background:
					"linear-gradient(135deg, transparent 50%, var(--hairline-strong, #666) 50%)",
			}}
		/>
	);
}

/**
 * 独立预览窗口根（浮动模式的承载窗口）。
 * 与主窗口是两个渲染进程，store 不共享：初始预览内容从 URL 参数自举，
 * 之后主窗口的变更经主进程 sync 消息同步过来。
 * 因为预览 iframe 与本组件同进程，inspect 的 postMessage 协议无需任何改动。
 */
export function PreviewWindowRoot() {
	const params = useMemo(
		() => parsePreviewWindowParams(window.location.search),
		[],
	);
	const showSettings = useSettingsStore((s) => s.showSettings);
	const settingsSection = useSettingsStore((s) => s.activeSection);

	useEffect(() => {
		ensureDragStyles();
		// 自举预览状态（独立窗口自己的 store 实例）
		useBrowserStore
			.getState()
			.openBrowser(params.path ?? undefined, params.sessionId ?? undefined);
		useBrowserStore.getState().setMode("float");
		// 地址栏的路径校验（项目 cwd）与分享的项目名推导都依赖项目/会话列表
		useProjectsStore.getState().load();
		// 首帧已渲染 → 请求主进程显示窗口（避免白屏闪现）
		window.waPiPreviewWin?.act({ type: "ready" });
	}, [params]);

	useEffect(() => {
		const api = window.waPiPreviewWin;
		if (!api) return;
		return api.onEvent((e: PreviewWinEvent) => {
			// 主窗口切会话/切文件：同步到本窗口的预览内容
			if (e.type === "sync") {
				useBrowserStore
					.getState()
					.openBrowser(e.path ?? undefined, e.sessionId ?? undefined);
			}
		});
	}, []);

	// 设置弹窗是主窗口的单例弹窗（模型/技能/插件等数据都只在主窗口加载）：本窗口不渲染设置，
	// 把「打开设置」转发给主窗口（主进程会顺便把主窗口带到前台），本地状态立即复位。
	// 典型来源：未配置分享 token 时分享弹窗自动关闭并跳「设置 → 分享」。
	useEffect(() => {
		if (!showSettings) return;
		window.waPiPreviewWin?.act({
			type: "open-settings",
			section: settingsSection,
		});
		useSettingsStore.getState().close();
	}, [showSettings, settingsSection]);

	// 无边框窗口没有标题栏，任务栏/窗口列表用的 document.title 取当前预览文件名
	useEffect(() => {
		const base = params.path
			? (params.path.split(/[\\/]/).pop() ?? params.path)
			: null;
		document.title = base ? `${base} · WA PI Agent` : "WA PI Agent";
	}, [params]);

	return (
		<div
			className="flex h-screen flex-col overflow-hidden bg-surface"
			data-testid="preview-window-root"
		>
			<BrowserPanel detached />
			<ResizeHandle />
			<FilePreviewModal />
			<ToastContainer />
		</div>
	);
}
