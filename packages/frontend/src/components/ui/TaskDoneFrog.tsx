// 任务完成青蛙动画组件：订阅 frog store，屏幕底部角落跳入 → 停留 → 跳走。
// 外层动画走 styles.css 的 @keyframes（wa-frog-in-left/right）；内部叠加以下姿态动作：
//   wa-frog-breathe（呼吸）/ wa-frog-blink（眨眼）/ wa-frog-jump（蹲跳）/ wa-frog-wave（挥手）/ wa-frog-z（zzz 飘动）
// 整体动画结束触发 onAnimationEnd → clear。
import type { CSSProperties } from "react";
import type { FrogCorner, FrogPose } from "../../util/frog";
import { useFrogStore } from "../../store/frog";

const LINE = "#4a7a3a";
const GREEN = "#7ccb5e";
const GREEN2 = "#5aab41";
const BELLY = "#d8f3c1";

/** 单个姿势的 SVG 内部结构（viewBox 200×200）。wave 手臂、sleep 闭眼带 data-testid 供测试断言。 */
function FrogSvg({ pose }: { pose: FrogPose }) {
	switch (pose) {
		case "jump":
			return (
				<g className="wa-frog-jump">
					<ellipse cx="100" cy="120" rx="56" ry="58" fill={GREEN} />
					<ellipse cx="100" cy="140" rx="38" ry="34" fill={BELLY} />
					<OpenEye cx={64} cy={54} />
					<OpenEye cx={136} cy={54} />
					<path d="M82 108 Q100 126 118 108 Q100 96 82 108" fill="#e2707a" />
					<ellipse cx="52" cy="104" rx="11" ry="8" fill="#f4a8b0" opacity=".65" />
					<ellipse cx="148" cy="104" rx="11" ry="8" fill="#f4a8b0" opacity=".65" />
					<ellipse
						cx="44"
						cy="170"
						rx="22"
						ry="10"
						fill={GREEN2}
						transform="rotate(-42 44 170)"
					/>
					<ellipse
						cx="156"
						cy="170"
						rx="22"
						ry="10"
						fill={GREEN2}
						transform="rotate(42 156 170)"
					/>
					<ellipse
						cx="88"
						cy="176"
						rx="20"
						ry="11"
						fill={GREEN2}
						transform="rotate(-24 88 176)"
					/>
					<ellipse
						cx="112"
						cy="176"
						rx="20"
						ry="11"
						fill={GREEN2}
						transform="rotate(24 112 176)"
					/>
				</g>
			);
		case "wave":
			return (
				<g>
					<ellipse
						className="wa-frog-breathe"
						cx="100"
						cy="126"
						rx="60"
						ry="56"
						fill={GREEN}
					/>
					<ellipse cx="100" cy="146" rx="40" ry="32" fill={BELLY} />
					<WinkEye cx={70} cy={62} />
					<OpenEye cx={130} cy={62} />
					<path
						d="M80 116 Q100 132 120 116"
						stroke={LINE}
						strokeWidth="4"
						fill="none"
						strokeLinecap="round"
					/>
					<ellipse cx="56" cy="110" rx="11" ry="8" fill="#f4a8b0" opacity=".65" />
					<ellipse cx="144" cy="110" rx="11" ry="8" fill="#f4a8b0" opacity=".65" />
					<g className="wa-frog-wave-arm" data-testid="frog-wave-arm">
						<path
							d="M150 140 Q 174 112 178 78"
							stroke={GREEN2}
							strokeWidth="14"
							fill="none"
							strokeLinecap="round"
						/>
						<circle cx="178" cy="72" r="9" fill={GREEN2} />
					</g>
					<ellipse
						cx="62"
						cy="180"
						rx="20"
						ry="11"
						fill={GREEN2}
						transform="rotate(-18 62 180)"
					/>
					<ellipse
						cx="138"
						cy="184"
						rx="20"
						ry="11"
						fill={GREEN2}
						transform="rotate(16 138 184)"
					/>
				</g>
			);
		case "sleep":
			return (
				<g>
					<ellipse
						className="wa-frog-breathe"
						cx="100"
						cy="132"
						rx="66"
						ry="46"
						fill={GREEN}
					/>
					<ellipse cx="100" cy="146" rx="46" ry="28" fill={BELLY} />
					<ClosedEye cx={60} cy={88} dataTestId="frog-sleep-eyes" />
					<ClosedEye cx={140} cy={88} />
					<path
						d="M84 132 Q100 142 116 132"
						stroke={LINE}
						strokeWidth="4"
						fill="none"
						strokeLinecap="round"
					/>
					<ellipse cx="76" cy="176" rx="20" ry="10" fill={GREEN2} />
					<ellipse cx="124" cy="176" rx="20" ry="10" fill={GREEN2} />
					<text className="wa-frog-z wa-frog-z1" x="150" y="84" fontSize="26">
						z
					</text>
					<text className="wa-frog-z wa-frog-z2" x="166" y="66" fontSize="20">
						z
					</text>
					<text className="wa-frog-z wa-frog-z3" x="178" y="50" fontSize="15">
						z
					</text>
				</g>
			);
		case "sit":
		default:
			return (
				<g>
					<ellipse
						className="wa-frog-breathe"
						cx="100"
						cy="130"
						rx="62"
						ry="55"
						fill={GREEN}
					/>
					<ellipse cx="100" cy="150" rx="42" ry="32" fill={BELLY} />
					<OpenEye cx={70} cy={64} blink />
					<OpenEye cx={130} cy={64} blink />
					<path
						d="M82 116 Q100 132 118 116"
						stroke={LINE}
						strokeWidth="4"
						fill="none"
						strokeLinecap="round"
					/>
					<ellipse cx="56" cy="110" rx="11" ry="8" fill="#f4a8b0" opacity=".65" />
					<ellipse cx="144" cy="110" rx="11" ry="8" fill="#f4a8b0" opacity=".65" />
					<ellipse
						cx="62"
						cy="180"
						rx="20"
						ry="12"
						fill={GREEN2}
						transform="rotate(-20 62 180)"
					/>
					<ellipse
						cx="138"
						cy="180"
						rx="20"
						ry="12"
						fill={GREEN2}
						transform="rotate(20 138 180)"
					/>
					<ellipse cx="72" cy="192" rx="24" ry="9" fill={GREEN2} />
					<ellipse cx="128" cy="192" rx="24" ry="9" fill={GREEN2} />
				</g>
			);
	}
}

function OpenEye({
	cx,
	cy,
	blink,
}: {
	cx: number;
	cy: number;
	blink?: boolean;
}) {
	return (
		<g>
			<circle
				className={blink ? "wa-frog-blink" : undefined}
				cx={cx}
				cy={cy}
				r="22"
				fill="#fff"
				stroke={LINE}
				strokeWidth="3"
			/>
			<circle cx={cx + 2} cy={cy + 2} r="9" fill="#333" />
			<circle cx={cx + 3} cy={cy - 2} r="3" fill="#fff" />
		</g>
	);
}

function WinkEye({ cx, cy }: { cx: number; cy: number }) {
	return (
		<g>
			<path
				d={`M ${cx - 20} ${cy} Q ${cx} ${cy - 10} ${cx + 20} ${cy}`}
				stroke={LINE}
				strokeWidth="4"
				fill="none"
				strokeLinecap="round"
			/>
			<circle cx={cx} cy={cy} r="20" fill="#fff" stroke={LINE} strokeWidth="3" />
			<circle cx={cx + 2} cy={cy + 2} r="8" fill="#333" />
			<circle cx={cx + 3} cy={cy - 2} r="3" fill="#fff" />
		</g>
	);
}

function ClosedEye({
	cx,
	cy,
	dataTestId,
}: {
	cx: number;
	cy: number;
	dataTestId?: string;
}) {
	return (
		<path
			data-testid={dataTestId}
			d={`M ${cx - 20} ${cy} Q ${cx} ${cy + 9} ${cx + 20} ${cy}`}
			stroke={LINE}
			strokeWidth="4"
			fill="none"
			strokeLinecap="round"
		/>
	);
}

/** 动画总时长（ms），与 styles.css 的 @keyframes 一致；结束后 clear。 */
const FROG_ANIM_MS = 2700;

/** 聊天区四角定位。 */
const CORNER_STYLE: Record<FrogCorner, CSSProperties> = {
	tl: { top: 16, left: 16 },
	tr: { top: 16, right: 16 },
	bl: { bottom: 16, left: 16 },
	br: { bottom: 16, right: 16 },
};

/** 四角对应的跳入/跳出走位动画。 */
const CORNER_ANIM: Record<FrogCorner, string> = {
	tl: "wa-frog-in-tl",
	tr: "wa-frog-in-tr",
	bl: "wa-frog-in-bl",
	br: "wa-frog-in-br",
};

/** 挂载在 MessageList 聊天区容器内的任务完成蛙：订阅 frog store，有 burst 时从聊天区四角随机蹦出。 */
export function TaskDoneFrog() {
	const current = useFrogStore((s) => s.current);
	const clear = useFrogStore((s) => s.clear);
	if (!current) return null;
	return (
		<div
			data-testid="task-done-frog"
			data-pose={current.pose}
			data-corner={current.corner}
			className="absolute z-10 pointer-events-none select-none"
			style={{
				...CORNER_STYLE[current.corner],
				animation: `${CORNER_ANIM[current.corner]} ${FROG_ANIM_MS}ms ease forwards`,
			}}
			onAnimationEnd={(e) => {
				if (e.target !== e.currentTarget) return;
				clear();
			}}
		>
			<svg width="120" height="120" viewBox="0 0 200 200" aria-hidden="true">
				<FrogSvg pose={current.pose} />
			</svg>
		</div>
	);
}
