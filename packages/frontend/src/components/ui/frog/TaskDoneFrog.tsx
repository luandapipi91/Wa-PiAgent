// 任务完成青蛙动画组件（重设计版）：订阅 frog store，19 个动画变体 × 8 个聊天区位置。
// 结构：外层 div 只做 spot 定位 + 哨兵动画（时长=变体总时长，结束时 onAnimationEnd → clear）；
// 内层 svg（overflow: visible）渲染变体 SVG，全部动作由 frog.css 的 keyframes 驱动，
// 入场/出场走位引用位置 class 注入的 --fx-* 变量，实现一套 keyframes 适配 8 个位置。
import type { CSSProperties } from "react";
import type { FrogSpot } from "../../../util/frog";
import { useFrogStore } from "../../../store/frog";
import { VARIANT_MS, VARIANT_SVGS } from "./variantSvgs";
import "./frog.css";

/** 聊天区 8 处定位（不用 transform，避免与动画冲突；居中位用 margin）。 */
const SPOT_STYLE: Record<FrogSpot, CSSProperties> = {
	ul: { top: 16, left: 16 },
	um: { top: 16, left: "50%", marginLeft: -48 },
	ur: { top: 16, right: 16 },
	ml: { top: "50%", marginTop: -48, left: 16 },
	mr: { top: "50%", marginTop: -48, right: 16 },
	dl: { bottom: 16, left: 16 },
	dm: { bottom: 16, left: "50%", marginLeft: -48 },
	dr: { bottom: 16, right: 16 },
};

/** 挂载在 MessageList 聊天区容器内的任务完成蛙：有 burst 时按变体在指定位置表演一次。 */
export function TaskDoneFrog() {
	const current = useFrogStore((s) => s.current);
	const clear = useFrogStore((s) => s.clear);
	if (!current) return null;
	const Svg = VARIANT_SVGS[current.variant];
	return (
		<div
			data-testid="task-done-frog"
			data-variant={current.variant}
			data-spot={current.spot}
			className={`waf-anchor waf-spot-${current.spot} absolute z-10 select-none`}
			style={{
				...SPOT_STYLE[current.spot],
				width: 96,
				height: 96,
				animation: `waf-sentinel ${VARIANT_MS[current.variant]}ms linear forwards`,
			}}
			onAnimationEnd={(e) => {
				// 只认哨兵动画自身的结束（SVG 内部动画结束会冒泡，target 不是 currentTarget）
				if (e.target !== e.currentTarget) return;
				clear();
			}}
		>
			<svg
				className="waf-stage"
				width="96"
				height="96"
				viewBox="0 0 120 120"
				aria-hidden="true"
			>
				<Svg />
			</svg>
		</div>
	);
}
