// ExportButton — AI 回复旁的「导出为图片」按钮（CopyButton 同排左侧）。
// 点击弹小菜单：下载 PNG（a[download]）/ 复制图片（copyImageToClipboard 双端）。
// 菜单用 createPortal 提到 body 下（fixed z-50），逃逸 MessageList 滚动容器的
// overflow 裁剪；空间不足时自动向上翻转。
//
// 两种导出范围：
// - 短按「下载/复制」→ 用全局 exportTurns（设置项，1-5，默认 1）立即执行
// - 长按「下载/复制」→ 弹出轮数选择子面板（1-5），选中后仅本次用该轮数执行
//
// 图标一律手绘内联 SVG（项目约定：不引图标库）。
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSessionStore } from "../../store/session";
import { useToastStore } from "../../store/toast";
import { useUiPrefsStore } from "../../store/ui-prefs";
import { useTranslation } from "../../i18n/useTranslation";
import { copyImageToClipboard } from "../../util/clipboard";
import {
	collectTurns,
	downloadBlob,
	renderTurnsToPngBlob,
} from "../../util/export-chat-image";

/** 菜单宽度（w-32 = 128px）；与下方坐标计算保持一致。 */
const MENU_WIDTH = 128;
/** 主菜单高度估算（两项 + py-1 padding），用于判断是否翻转。 */
const MENU_HEIGHT = 76;
/** 轮数子面板高度估算（标题 + 5 项 + padding），用于判断是否翻转。 */
const PANEL_HEIGHT = 168;
/** 触发长按的阈值（ms）：超过即弹轮数子面板。 */
const LONG_PRESS_MS = 450;

/** 导出文件名时间戳：wa-pi-chat-YYYYMMDD-HHmm.png */
function exportFilename(ts: number): string {
	const d = new Date(ts);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `wa-pi-chat-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.png`;
}

function DownloadIcon() {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
			<polyline points="7 10 12 15 17 10" />
			<line x1="12" y1="15" x2="12" y2="3" />
		</svg>
	);
}

function ImageIcon() {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="12"
			height="12"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
			<circle cx="8.5" cy="8.5" r="1.5" />
			<polyline points="21 15 16 10 5 21" />
		</svg>
	);
}

interface Props {
	sessionId: string;
	uptoTimestamp: number; // 当条 AI 回复时间戳（导出范围右端点）
}

export function ExportButton({ sessionId, uptoTimestamp }: Props) {
	const [open, setOpen] = useState(false);
	// 子面板：长按某项后进入选轮数；null=主菜单，"download"|"copy"=为该操作选轮数
	const [turnPicker, setTurnPicker] = useState<"download" | "copy" | null>(
		null,
	);
	const [busy, setBusy] = useState(false);
	const addToast = useToastStore((s) => s.add);
	const exportTurns = useUiPrefsStore((s) => s.exportTurns);
	const { t } = useTranslation();
	const wrapRef = useRef<HTMLDivElement>(null);
	const btnRef = useRef<HTMLButtonElement>(null);
	// 长按计时器：pointer down 启动，up/leave 取消；触发则进入轮数子面板
	const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const longPressed = useRef(false);

	// 点外部关闭菜单（菜单 portal 到 body，但其内部 mousedown stopPropagation，
	// 不会冒泡到 document；这里只接收菜单/按钮之外的点击）
	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			if (wrapRef.current && !wrapRef.current.contains(e.target as Node))
				setOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [open]);

	// 卸载时清理长按计时器
	useEffect(
		() => () => {
			if (pressTimer.current) clearTimeout(pressTimer.current);
		},
		[],
	);

	const hasTurns = (turns = exportTurns) => {
		const msgs = useSessionStore.getState().messagesBySession[sessionId] ?? [];
		return collectTurns(msgs, uptoTimestamp, turns).length > 0;
	};

	const run = async (mode: "download" | "copy", turns: number) => {
		setOpen(false);
		setTurnPicker(null);
		if (busy) return;
		setBusy(true);
		try {
			const msgs =
				useSessionStore.getState().messagesBySession[sessionId] ?? [];
			const collected = collectTurns(msgs, uptoTimestamp, turns);
			if (collected.length === 0) {
				addToast(t("blocks.exportBtn.toastNoContent"), "error");
				return;
			}
			const blob = await renderTurnsToPngBlob(collected);
			if (mode === "download") {
				downloadBlob(blob, exportFilename(uptoTimestamp));
				addToast(t("blocks.exportBtn.toastDownloaded"), "success");
			} else {
				await copyImageToClipboard(blob);
				addToast(t("blocks.exportBtn.toastCopied"), "success");
			}
		} catch {
			// spec §7：复制失败与生成失败文案区分（剪贴板权限拒绝走「复制失败」）
			addToast(mode === "copy" ? t("common.copyFailed") : t("blocks.exportBtn.toastExportFailed"), "error");
		} finally {
			setBusy(false);
		}
	};

	// 长按：pointer down 启动计时器，到时标记长按并弹轮数子面板；up/leave 提前则取消。
	// 短按执行走 onClick（与既有测试 fireEvent.click 兼容；真实浏览器里 pointerup 后
	// 浏览器会补发 click，长按触发后 longPressed 标记会阻止 click 重复执行）。
	const startPress = (mode: "download" | "copy") => {
		longPressed.current = false;
		if (pressTimer.current) clearTimeout(pressTimer.current);
		pressTimer.current = setTimeout(() => {
			longPressed.current = true;
			setTurnPicker(mode);
		}, LONG_PRESS_MS);
	};
	const cancelPress = () => {
		if (pressTimer.current) {
			clearTimeout(pressTimer.current);
			pressTimer.current = null;
		}
	};
	// pointerup 提前结束只取消计时器；执行交给随后到达的 click
	const endPress = () => cancelPress();
	// click：长按已弹子面板则不重复执行；否则用全局轮数立即执行
	const tap = (mode: "download" | "copy") => {
		if (longPressed.current) {
			longPressed.current = false;
			return;
		}
		void run(mode, exportTurns);
	};

	const disabled = !hasTurns();
	const itemCls = (off: boolean) =>
		`flex items-center gap-1.5 px-3 py-1.5 text-xs w-full text-left border-0 select-none ${off ? "text-tertiary cursor-not-allowed" : "text-primary hover:bg-surface-elevated cursor-pointer"}`;

	// 菜单坐标：相对按钮定位，下方空间不足时向上翻转，左缘不越出视口
	const btnRect = btnRef.current?.getBoundingClientRect();
	const panelH = turnPicker ? PANEL_HEIGHT : MENU_HEIGHT;
	const menuStyle: React.CSSProperties = (() => {
		if (!btnRect) return { display: "none" };
		const flipUp = btnRect.bottom + panelH > window.innerHeight;
		const top = flipUp
			? Math.max(4, btnRect.top - panelH - 4)
			: btnRect.bottom + 4;
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
				title={t("blocks.exportBtn.triggerLabel")}
				aria-label={t("blocks.exportBtn.triggerLabel")}
			>
				<DownloadIcon />
			</button>
			{open &&
				createPortal(
					<div
						className="fixed z-50 bg-surface border border-hairline rounded-md shadow-lg py-1"
						style={{ ...menuStyle, width: MENU_WIDTH }}
						onMouseDown={(e) => e.stopPropagation()}
					>
						{turnPicker ? (
							// 轮数子面板：长按触发，仅本次用所选轮数执行（不改全局设置）
							<div data-testid={`export-turn-picker-${turnPicker}`}>
								<div className="px-3 pt-0.5 pb-1 text-[10px] text-tertiary">
									{t("blocks.exportBtn.turnPickerTitle")}
								</div>
								{[1, 2, 3, 4, 5].map((n) => (
									<button
										key={n}
										type="button"
										data-testid={`export-turn-${n}`}
										onClick={() => void run(turnPicker, n)}
										className={itemCls(false)}
									>
										{t("blocks.exportBtn.turnItem", { n })}{n === exportTurns ? t("blocks.exportBtn.turnDefaultSuffix") : ""}
									</button>
								))}
							</div>
						) : (
							// 主菜单：短按立即执行（全局轮数）；长按弹轮数子面板
							<>
								<button
									type="button"
									data-testid="export-download"
									disabled={disabled}
									onPointerDown={() => !disabled && startPress("download")}
									onPointerUp={() => !disabled && endPress()}
									onPointerLeave={cancelPress}
									onClick={() => !disabled && tap("download")}
									className={itemCls(disabled)}
								>
									<DownloadIcon /> {t("blocks.exportBtn.downloadPng")}
								</button>
								<button
									type="button"
									data-testid="export-copy"
									disabled={disabled}
									onPointerDown={() => !disabled && startPress("copy")}
									onPointerUp={() => !disabled && endPress()}
									onPointerLeave={cancelPress}
									onClick={() => !disabled && tap("copy")}
									className={itemCls(disabled)}
								>
									<ImageIcon /> {t("blocks.exportBtn.copyImage")}
								</button>
								<div className="px-3 pt-1 text-[10px] text-tertiary border-t border-hairline mt-0.5">
									{t("blocks.exportBtn.hintLongPress")}
								</div>
							</>
						)}
					</div>,
					document.body,
				)}
		</div>
	);
}
