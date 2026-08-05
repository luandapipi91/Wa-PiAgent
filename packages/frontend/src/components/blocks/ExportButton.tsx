// ExportButton — AI 回复旁的「导出为图片」按钮（CopyButton 同排左侧）。
// 点击弹小菜单：下载 PNG（a[download]）/ 复制图片（copyImageToClipboard 双端）。
// 菜单用 createPortal 提到 body 下（fixed z-50），逃逸 MessageList 滚动容器的
// overflow 裁剪；空间不足时自动向上翻转。导出轮数取自 useUiPrefsStore（1-5，默认 1）。
// 图标一律手绘内联 SVG（项目约定：不引图标库）。
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSessionStore } from "../../store/session";
import { useToastStore } from "../../store/toast";
import { useUiPrefsStore } from "../../store/ui-prefs";
import { copyImageToClipboard } from "../../util/clipboard";
import {
	collectTurns,
	downloadBlob,
	renderTurnsToPngBlob,
} from "../../util/export-chat-image";

/** 菜单宽度（w-32 = 128px）；与下方坐标计算保持一致。 */
const MENU_WIDTH = 128;
/** 菜单高度估算（两项 + py-1 padding），用于判断是否翻转。 */
const MENU_HEIGHT = 76;

interface Props {
	sessionId: string;
	uptoTimestamp: number; // 当条 AI 回复时间戳（导出范围右端点）
}

function DownloadIcon() {
	return (
		<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
			<polyline points="7 10 12 15 17 10" />
			<line x1="12" y1="15" x2="12" y2="3" />
		</svg>
	);
}

function ImageIcon() {
	return (
		<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
			<circle cx="8.5" cy="8.5" r="1.5" />
			<polyline points="21 15 16 10 5 21" />
		</svg>
	);
}

/** 导出文件名时间戳：wa-pi-chat-YYYYMMDD-HHmm.png */
function exportFilename(ts: number): string {
	const d = new Date(ts);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `wa-pi-chat-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.png`;
}

export function ExportButton({ sessionId, uptoTimestamp }: Props) {
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const addToast = useToastStore((s) => s.add);
	const exportTurns = useUiPrefsStore((s) => s.exportTurns);
	const wrapRef = useRef<HTMLDivElement>(null);
	const btnRef = useRef<HTMLButtonElement>(null);

	// 点外部关闭菜单（菜单 portal 到 body，但其内部 mousedown stopPropagation，
	// 不会冒泡到 document；这里只接收菜单/按钮之外的点击）
	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [open]);

	const hasTurns = () => {
		const msgs = useSessionStore.getState().messagesBySession[sessionId] ?? [];
		return collectTurns(msgs, uptoTimestamp, exportTurns).length > 0;
	};

	const run = async (mode: "download" | "copy") => {
		setOpen(false);
		if (busy) return;
		setBusy(true);
		try {
			const msgs = useSessionStore.getState().messagesBySession[sessionId] ?? [];
			const turns = collectTurns(msgs, uptoTimestamp, exportTurns);
			if (turns.length === 0) {
				addToast("无可导出的文本对话", "error");
				return;
			}
			const blob = await renderTurnsToPngBlob(turns);
			if (mode === "download") {
				downloadBlob(blob, exportFilename(uptoTimestamp));
				addToast("图片已下载", "success");
			} else {
				await copyImageToClipboard(blob);
				addToast("图片已复制", "success");
			}
		} catch {
			// spec §7：复制失败与生成失败文案区分（剪贴板权限拒绝走「复制失败」）
			addToast(mode === "copy" ? "复制失败" : "导出失败，请重试", "error");
		} finally {
			setBusy(false);
		}
	};

	const disabled = !hasTurns();
	const itemCls = (off: boolean) =>
		`flex items-center gap-1.5 px-3 py-1.5 text-xs w-full text-left border-0 ${off ? "text-tertiary cursor-not-allowed" : "text-primary hover:bg-surface-elevated cursor-pointer"}`;

	// 菜单坐标：相对按钮定位，下方空间不足时向上翻转，左缘不越出视口
	const btnRect = btnRef.current?.getBoundingClientRect();
	const menuStyle: React.CSSProperties = (() => {
		if (!btnRect) return { display: "none" };
		const flipUp = btnRect.bottom + MENU_HEIGHT > window.innerHeight;
		const top = flipUp ? Math.max(4, btnRect.top - MENU_HEIGHT - 4) : btnRect.bottom + 4;
		const left = Math.max(4, btnRect.right - MENU_WIDTH);
		return { left, top };
	})();

	return (
		<div ref={wrapRef} className="relative">
			<button
				ref={btnRef}
				type="button"
				data-testid={`export-${sessionId}-${uptoTimestamp}`}
				onClick={() => setOpen((v) => !v)}
				disabled={busy}
				className="p-1 rounded-md text-tertiary opacity-60 hover:opacity-100 hover:text-primary hover:bg-surface-elevated transition-colors"
				title="导出为图片"
				aria-label="导出为图片"
			>
				<DownloadIcon />
			</button>
			{open && createPortal(
				<div
					className="fixed z-50 bg-surface border border-hairline rounded-md shadow-lg py-1"
					style={{ ...menuStyle, width: MENU_WIDTH }}
					onMouseDown={(e) => e.stopPropagation()}
				>
					<button
						type="button"
						data-testid="export-download"
						disabled={disabled}
						onClick={() => void run("download")}
						className={itemCls(disabled)}
					>
						<DownloadIcon /> 下载 PNG
					</button>
					<button
						type="button"
						data-testid="export-copy"
						disabled={disabled}
						onClick={() => void run("copy")}
						className={itemCls(disabled)}
					>
						<ImageIcon /> 复制图片
					</button>
				</div>,
				document.body,
			)}
		</div>
	);
}
