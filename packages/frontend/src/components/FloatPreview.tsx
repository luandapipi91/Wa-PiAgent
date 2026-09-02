import { useEffect, useState } from "react";
import { FloatWindow } from "./FloatWindow";
import { FloatBubble } from "./FloatBubble";
import { BrowserPanel } from "./BrowserPanel";
import { defaultRect, useBrowserStore } from "../store/browser";

/** 最小化/恢复动画时长（与 CSS transition 一致） */
const ANIM_MS = 200;

type Phase = "open" | "hiding" | "hidden" | "opening";

/**
 * 浮动预览层：浮动窗 + 最小化气泡。
 * - 最小化：窗口带 transition 收缩飞向气泡位置（hiding），动画结束隐藏但保持挂载（hidden，预览状态不丢）
 * - 恢复：从气泡位置展开回窗口（opening → open）
 * - 气泡可拖动停放（持久化），点击恢复
 */
export function FloatPreview() {
	const storedRect = useBrowserStore((s) => s.floatRect);
	const setFloatRect = useBrowserStore((s) => s.setFloatRect);
	// 无历史记录时渲染期现算双向居中（此时视口已就绪），并固化供后续直接恢复
	const rect = storedRect ?? defaultRect();
	useEffect(() => {
		if (!storedRect) setFloatRect(rect);
		// eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在首次无记录时固化一次
	}, [storedRect]);
	const minimized = useBrowserStore((s) => s.minimized);
	const bubblePos = useBrowserStore((s) => s.bubblePos);
	const [phase, setPhase] = useState<Phase>(minimized ? "hidden" : "open");
	// opening 动画的展开帧：先以收缩态渲染一帧，再切展开态触发 transition
	const [opened, setOpened] = useState(!minimized);

	useEffect(() => {
		if (minimized && (phase === "open" || phase === "opening"))
			setPhase("hiding");
		if (!minimized && (phase === "hidden" || phase === "hiding")) {
			setPhase("opening");
			setOpened(false);
		}
	}, [minimized, phase]);

	// hiding 动画结束 → hidden（独立 effect：timer 不被相位切换 effect 的 cleanup 误清）
	useEffect(() => {
		if (phase !== "hiding") return;
		const t = setTimeout(() => setPhase("hidden"), ANIM_MS);
		return () => clearTimeout(t);
	}, [phase]);

	useEffect(() => {
		if (phase !== "opening" || opened) return;
		const raf = requestAnimationFrame(() => setOpened(true));
		return () => cancelAnimationFrame(raf);
	}, [phase, opened]);

	useEffect(() => {
		if (phase !== "opening" || !opened) return;
		const t = setTimeout(() => setPhase("open"), ANIM_MS);
		return () => clearTimeout(t);
	}, [phase, opened]);

	// 收缩目标：气泡中心点、尺寸归零、透明
	const collapsed: React.CSSProperties = {
		left: bubblePos.x + 22,
		top: bubblePos.y + 22,
		width: 0,
		height: 0,
		opacity: 0,
		overflow: "hidden",
		pointerEvents: "none",
		transition: `all ${ANIM_MS}ms ease-in`,
	};

	const animStyle =
		phase === "hiding"
			? collapsed
			: phase === "hidden"
				? { display: "none" as const }
				: phase === "opening"
					? opened
						? { transition: `all ${ANIM_MS}ms ease-out` }
						: { ...collapsed, transition: "none" }
					: undefined;

	return (
		<>
			<FloatWindow
				rect={rect}
				animStyle={animStyle}
				onRectChange={(r) => useBrowserStore.getState().setFloatRect(r)}
			>
				<BrowserPanel />
			</FloatWindow>
			{phase === "hidden" && (
				<FloatBubble
					pos={bubblePos}
					onPosChange={(p) => useBrowserStore.getState().setBubblePos(p)}
					onRestore={() => useBrowserStore.getState().setMinimized(false)}
				/>
			)}
		</>
	);
}
