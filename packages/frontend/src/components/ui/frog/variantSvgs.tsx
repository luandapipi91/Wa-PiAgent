// 任务完成青蛙：19 个动画变体的 SVG 结构库。
// 约定：全部 viewBox="0 0 120 120"（组件统一 96px 显示），舞台级道具靠 svg overflow: visible 画出；
// 每个变体根节点带 waf-root + waf-root-{id} 双类（waf-root 供 onAnimationEnd 过滤冒泡，
// waf-root-{id} 供 CSS 作用域）；动画一律由 frog.css 的 keyframes 驱动，本文件不写内联动画。
import type { ReactNode } from "react";
import type { FrogVariant } from "../../../util/frog";

const GREEN = "#7ccb5e";
const ARM = "#63b04a";
const LEG = "#4d9440";
const BELLY = "#dcf5c8";
const LINE = "#2e4d26";
const EYE_RING = "#3f6d33";
const BLUSH = "#f4a8b0";

interface BodyProps {
	eyes?: "open" | "shut";
	mouth?: "smile" | "o";
	bodyFill?: string;
	/** 追加在身体最上层（道具/替代手臂等）。 */
	extra?: ReactNode;
	/** 覆盖默认双臂（如敬礼手、张臂冲浪）。 */
	arms?: ReactNode;
}

/** 基础蛙（正面坐姿，120 坐标系，脚底 y≈112）。 */
function FrogBody({
	eyes = "open",
	mouth = "smile",
	bodyFill = GREEN,
	extra,
	arms,
}: BodyProps) {
	return (
		<g>
			<ellipse cx="37" cy="105" rx="15" ry="7.5" fill={LEG} />
			<ellipse cx="83" cy="105" rx="15" ry="7.5" fill={LEG} />
			<path
				d="M60 33 C90 33 100 57 98 76 C96 98 80 108 60 108 C40 108 24 98 22 76 C20 57 30 33 60 33 Z"
				fill={bodyFill}
			/>
			<ellipse cx="60" cy="86" rx="21" ry="16" fill={BELLY} />
			<path
				d="M36 46 C42 39 52 36 59 35"
				stroke="#a9e286"
				strokeWidth="5"
				fill="none"
				strokeLinecap="round"
				opacity=".65"
			/>
			{eyes === "open" ? (
				<>
					<g>
						<circle
							cx="40"
							cy="33"
							r="14"
							fill="#fff"
							stroke={EYE_RING}
							strokeWidth="2.5"
						/>
						<circle cx="42" cy="35" r="6" fill="#2b2b23" />
						<circle cx="44.5" cy="32" r="2.2" fill="#fff" />
					</g>
					<g>
						<circle
							cx="80"
							cy="33"
							r="14"
							fill="#fff"
							stroke={EYE_RING}
							strokeWidth="2.5"
						/>
						<circle cx="82" cy="35" r="6" fill="#2b2b23" />
						<circle cx="84.5" cy="32" r="2.2" fill="#fff" />
					</g>
				</>
			) : (
				<>
					<path
						d="M30 34 Q40 42 50 34"
						stroke={LINE}
						strokeWidth="3"
						fill="none"
						strokeLinecap="round"
					/>
					<path
						d="M70 34 Q80 42 90 34"
						stroke={LINE}
						strokeWidth="3"
						fill="none"
						strokeLinecap="round"
					/>
				</>
			)}
			<ellipse cx="33" cy="57" rx="6.5" ry="4" fill={BLUSH} opacity=".55" />
			<ellipse cx="87" cy="57" rx="6.5" ry="4" fill={BLUSH} opacity=".55" />
			{mouth === "o" ? (
				<ellipse cx="60" cy="63" rx="7.5" ry="9.5" fill={LINE} opacity=".9" />
			) : (
				<path
					d="M47 60 Q60 71 73 60"
					stroke={LINE}
					strokeWidth="3.5"
					fill="none"
					strokeLinecap="round"
				/>
			)}
			{arms ?? (
				<>
					<ellipse cx="28" cy="82" rx="8.5" ry="6" fill={ARM} />
					<ellipse cx="92" cy="82" rx="8.5" ry="6" fill={ARM} />
				</>
			)}
			{extra}
		</g>
	);
}

/** 「呱!」气泡（白底绿描边，尾巴指向下方蛙嘴方向）。 */
function CroakBubble({ x, y }: { x: number; y: number }) {
	return (
		<g className="waf-bubble">
			<rect
				x={x}
				y={y}
				rx="13"
				width="62"
				height="36"
				fill="#fff"
				stroke={EYE_RING}
				strokeWidth="2.5"
			/>
			<path
				d={`M ${x + 14} ${y + 34} l -7 13 l 17 -11 z`}
				fill="#fff"
				stroke={EYE_RING}
				strokeWidth="2.5"
				strokeLinejoin="round"
			/>
			<text
				x={x + 31}
				y={y + 25}
				textAnchor="middle"
				fontSize="19"
				fontWeight="700"
				fill="#3f8e4f"
			>
				呱!
			</text>
		</g>
	);
}

/* ---------- 像素蛙（10×8 格，格 9px） ---------- */
const PIX = [
	"..GG..GG..",
	".GWWGGWWG.",
	".GWBGGnWG.",
	".GGGGGGGG.",
	"GGGPPPPGGG",
	".GGGGGGGG.",
	".G.GGGG.G.",
	"..LL..LL..",
];
const PIX_COLOR: Record<string, string> = {
	G: "#6fbf4f",
	W: "#ffffff",
	B: "#22261e",
	n: "#22261e",
	P: "#e2707a",
	L: "#4d9440",
};

function PixelFrogBody() {
	const rects: ReactNode[] = [];
	PIX.forEach((row, y) => {
		for (let x = 0; x < row.length; x++) {
			const ch = row[x];
			if (ch === ".") continue;
			rects.push(
				<rect
					key={`${x}-${y}`}
					x={x * 9}
					y={y * 9}
					width={9.4}
					height={9.4}
					fill={PIX_COLOR[ch]}
				/>,
			);
		}
	});
	return <g>{rects}</g>;
}

/** 手绘描边蛙的轮廓线组（与 FrogBody 轮廓一致，无填充）。 */
function SketchLines() {
	return (
		<g
			className="waf-sketch-line"
			fill="none"
			stroke="#5a8a4a"
			strokeWidth="3"
			strokeLinecap="round"
		>
			<path d="M60 33 C90 33 100 57 98 76 C96 98 80 108 60 108 C40 108 24 98 22 76 C20 57 30 33 60 33 Z" />
			<ellipse cx="60" cy="86" rx="21" ry="16" />
			<circle cx="40" cy="33" r="14" />
			<circle cx="80" cy="33" r="14" />
			<path d="M47 60 Q60 71 73 60" />
		</g>
	);
}

/* ============ 19 个变体 ============ */

/** 01 Q弹蹦跳：通用跳入 → 落地涟漪+尘土 → 呱气泡 → 跳出。 */
export function BounceSvg() {
	return (
		<g className="waf-root waf-root-bounce">
			<ellipse
				className="waf-bounce-ripple"
				cx="60"
				cy="114"
				rx="34"
				ry="10"
				fill="none"
				stroke="#8fd470"
				strokeWidth="3"
			/>
			<ellipse
				className="waf-bounce-ripple2"
				cx="60"
				cy="114"
				rx="34"
				ry="10"
				fill="none"
				stroke="#8fd470"
				strokeWidth="3"
			/>
			<circle className="waf-bounce-dust" cx="25" cy="108" r="4" fill="#5a6472" />
			<circle
				className="waf-bounce-dust d2"
				cx="35"
				cy="112"
				r="3"
				fill="#5a6472"
			/>
			<circle
				className="waf-bounce-dust d3"
				cx="15"
				cy="112"
				r="3"
				fill="#5a6472"
			/>
			<g className="waf-bounce-frog">
				<FrogBody />
			</g>
			<g className="waf-bounce-bubble">
				<CroakBubble x={-48} y={-74} />
			</g>
		</g>
	);
}

/** 02 后空翻✓：入场后空翻一周 → 落定 → 头顶✓弹出 → 跳出。 */
export function BackflipSvg() {
	return (
		<g className="waf-root waf-root-backflip">
			<g className="waf-backflip-frog">
				<FrogBody />
			</g>
			<g className="waf-backflip-check">
				<circle cx="58" cy="-58" r="20" fill="#3f9e57" />
				<path
					d="M49 -58 l7 8 l13 -15"
					stroke="#fff"
					strokeWidth="5"
					fill="none"
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
			</g>
		</g>
	);
}

/** 03 打滚进场：团球滚入 → 展开 → 拍灰 → 跳出。 */
export function RollSvg() {
	return (
		<g className="waf-root waf-root-roll">
			<circle className="waf-roll-ash" cx="47" cy="-30" r="3.5" fill="#8a919e" />
			<circle className="waf-roll-ash b" cx="60" cy="-22" r="3" fill="#8a919e" />
			<g className="waf-roll-frog">
				<FrogBody />
			</g>
		</g>
	);
}

/** 04 荷叶漂流：坐荷叶水平滑入 → 荷叶轻晃 → 挺胸呱冒音符 → 滑出。 */
export function LilySvg() {
	return (
		<g className="waf-root waf-root-lily">
			<g className="waf-lily-boat">
				<g className="waf-lily-frog">
					<FrogBody />
				</g>
				<ellipse cx="60" cy="116" rx="66" ry="16" fill={LEG} />
				<path d="M60 116 L60 102" stroke="#3a7a30" strokeWidth="3" />
				<path
					d="M60 116 L42 106 M60 116 L78 106"
					stroke="#3a7a30"
					strokeWidth="2.5"
				/>
			</g>
			<text className="waf-lily-note" x={-10} y={-32} fontSize="20" fill="#9fe07a">
				♪
			</text>
			<text
				className="waf-lily-note n2"
				x={14}
				y={-42}
				fontSize="15"
				fill="#9fe07a"
			>
				♫
			</text>
		</g>
	);
}

/** 05 伞降蛙：抱荷叶伞从正上方摇摆飘落 → 伞弹飞 → 眨眼跳出。 */
export function ParachuteSvg() {
	return (
		<g className="waf-root waf-root-parachute">
			<g className="waf-para-all">
				<g className="waf-para-frog">
					<FrogBody />
				</g>
				<g className="waf-para-umb">
					<path d="M8 22 Q60 -34 112 22 Q60 4 8 22 Z" fill={LEG} />
					<line x1="60" y1="12" x2="60" y2="-14" stroke="#3a7a30" strokeWidth="3" />
					<circle cx="60" cy="-16" r="4" fill="#3a7a30" />
				</g>
			</g>
		</g>
	);
}

/** 06 井底之蛙：井口现 → 掀盖探头张望 → 蹦出坐井沿呱一声 → 跳走井沉。 */
export function WellSvg() {
	return (
		<g className="waf-root waf-root-well">
			<g className="waf-well-back">
				<rect x="20" y="105" width="90" height="70" fill="#14171d" />
				<ellipse cx="60" cy="105" rx="60" ry="22" fill="#3d465a" />
				<ellipse cx="60" cy="105" rx="42" ry="14" fill="#14171d" />
			</g>
			<g className="waf-well-frog">
				<FrogBody />
			</g>
			<g className="waf-well-front">
				{/* 井筒暗部：盖住蛙探头阶段的下半身，避免“悬空在井前”穿帮 */}
				<rect x="0" y="105" width="120" height="70" fill="#14171d" />
				<path
					d="M0 105 A60 22 0 0 0 120 105 L120 113 A60 22 0 0 1 0 113 Z"
					fill="#2c3340"
				/>
			</g>
			<g className="waf-well-lid">
				<ellipse cx="-14" cy="96" rx="30" ry="11" fill="#525c74" />
			</g>
			<g className="waf-well-bubble">
				<CroakBubble x={-40} y={-88} />
			</g>
		</g>
	);
}

/** 07 冲浪蛙：荷叶板带浪花从底部冲上 → 板上浮动平衡 → 滑出。 */
export function SurfSvg() {
	return (
		<g className="waf-root waf-root-surf">
			<g className="waf-surf-board">
				<g className="waf-surf-frog">
					<FrogBody
						arms={
							<>
								<ellipse
									cx="28"
									cy="66"
									rx="8.5"
									ry="6"
									fill={ARM}
									transform="rotate(-50 28 66)"
								/>
								<ellipse
									cx="92"
									cy="66"
									rx="8.5"
									ry="6"
									fill={ARM}
									transform="rotate(50 92 66)"
								/>
							</>
						}
					/>
				</g>
				<path d="M-14 112 Q60 128 134 108 Q70 118 -14 112 Z" fill={LEG} />
			</g>
			<circle className="waf-surf-splash" cx="65" cy="96" r="6" fill="#bfe3ff" />
			<circle
				className="waf-surf-splash s2"
				cx="73"
				cy="104"
				r="4.5"
				fill="#bfe3ff"
			/>
			<circle
				className="waf-surf-splash s3"
				cx="57"
				cy="102"
				r="5"
				fill="#bfe3ff"
			/>
		</g>
	);
}

/** 08 温泉蛙：木盆载蛙水平漂入 → 热气袅袅惬意眨眼 → 漂出。 */
export function SpaSvg() {
	return (
		<g className="waf-root waf-root-spa">
			<g className="waf-spa-tub">
				<g transform="translate(-18,-20)">
					<rect
						className="waf-spa-towel"
						x="45"
						y="-30"
						width="34"
						height="13"
						rx="4"
						fill={BLUSH}
						transform="rotate(-8 62 -24)"
					/>
					<g transform="translate(28,-8) scale(0.62)">
						<FrogBody eyes="shut" />
					</g>
					<path d="M6 44 L14 88 L106 88 L114 44 Z" fill="#8a5a34" />
					<path d="M6 44 L14 88 L22 88 L15 44 Z" fill="#a06c40" />
					<ellipse cx="60" cy="44" rx="54" ry="12" fill="#5aa7c7" />
					<ellipse cx="60" cy="43" rx="44" ry="8" fill="#7fc3de" />
					<path
						className="waf-spa-steam"
						d="M42 -20 q6 -8 0 -16 M60 -22 q6 -8 0 -16"
						stroke="#cfe6f2"
						strokeWidth="3"
						fill="none"
						strokeLinecap="round"
					/>
					<path
						className="waf-spa-steam s2"
						d="M78 -18 q6 -8 0 -16"
						stroke="#cfe6f2"
						strokeWidth="3"
						fill="none"
						strokeLinecap="round"
					/>
				</g>
			</g>
		</g>
	);
}

/** 09 弹弓入场：皮筋拉满弹射进来（带残影）→ 撞位反弹晕眼 → 恢复跳出。 */
export function SlingshotSvg() {
	return (
		<g className="waf-root waf-root-slingshot">
			<g className="waf-sling-band">
				<path d="M-40 90 L118 62" stroke="#7a5a3a" strokeWidth="4" />
				<path d="M-40 110 L118 82" stroke="#7a5a3a" strokeWidth="4" />
			</g>
			<g className="waf-sling-ghost g2">
				<FrogBody />
			</g>
			<g className="waf-sling-ghost g3">
				<FrogBody />
			</g>
			<g className="waf-sling-frog">
				<FrogBody
					extra={
						<g className="waf-sling-dizzy">
							<circle
								cx="40"
								cy="33"
								r="8"
								fill="none"
								stroke="#2b2b23"
								strokeWidth="3"
							/>
							<circle
								cx="80"
								cy="33"
								r="8"
								fill="none"
								stroke="#2b2b23"
								strokeWidth="3"
							/>
						</g>
					}
				/>
			</g>
		</g>
	);
}

/** 10 撒花蛙：跳入 → 掏花瓣上抛（6 瓣散落）→ 开心小跳 → 跳出。 */
export function FlowersSvg() {
	const petals: Array<{ cls: string; dx: string; fill: string }> = [
		{ cls: "", dx: "-50px", fill: BLUSH },
		{ cls: "p2", dx: "-88px", fill: "#ffd97a" },
		{ cls: "p3", dx: "25px", fill: "#9fd4ff" },
		{ cls: "p4", dx: "55px", fill: BLUSH },
		{ cls: "p5", dx: "-12px", fill: "#c6f09a" },
		{ cls: "p6", dx: "-68px", fill: "#ffd97a" },
	];
	return (
		<g className="waf-root waf-root-flowers">
			<g className="waf-flowers-frog">
				<FrogBody
					extra={
						<ellipse
							cx="96"
							cy="70"
							rx="9"
							ry="6"
							fill={ARM}
							transform="rotate(-40 96 70)"
						/>
					}
				/>
			</g>
			{petals.map((p) => (
				<ellipse
					key={p.cls || "p1"}
					className={`waf-flowers-petal ${p.cls}`.trim()}
					style={{ "--fx-pdx": p.dx } as React.CSSProperties}
					cx="52"
					cy="-45"
					rx="8"
					ry="5"
					fill={p.fill}
				/>
			))}
		</g>
	);
}

/** 11 举牌蛙：跳入 → 身后唰地举起「搞定!」牌晃两下 → 举着退出。 */
export function SignSvg() {
	return (
		<g className="waf-root waf-root-sign">
			<g className="waf-sign-frog">
				<FrogBody />
			</g>
			<g className="waf-sign-board" data-testid="frog-sign-board">
				<rect
					x="-62"
					y="-88"
					width="104"
					height="54"
					rx="10"
					fill="#fff"
					stroke={EYE_RING}
					strokeWidth="3"
				/>
				<text
					x="-10"
					y="-52"
					textAnchor="middle"
					fontSize="27"
					fontWeight="800"
					fill="#3f8e4f"
				>
					搞定!
				</text>
				<line
					x1="-40"
					y1="-34"
					x2="-32"
					y2="10"
					stroke="#7a5a3a"
					strokeWidth="6"
					strokeLinecap="round"
				/>
			</g>
		</g>
	);
}

/** 12 敬礼蛙：水平滑入 → 立正敬礼点头 → 转身滑出。 */
export function SaluteSvg() {
	return (
		<g className="waf-root waf-root-salute">
			<g className="waf-salute-frog">
				<FrogBody
					arms={
						<>
							<ellipse cx="28" cy="82" rx="8.5" ry="6" fill={ARM} />
							<g className="waf-salute-arm">
								<ellipse cx="92" cy="82" rx="8.5" ry="6" fill={ARM} />
							</g>
						</>
					}
				/>
			</g>
		</g>
	);
}

/** 13 舌头盖✓章：趴在锚点 → 弹舌把✓章「啪」在内侧 → 收舌得意 → 跳走。 */
export function TongueSvg() {
	return (
		<g className="waf-root waf-root-tongue">
			<g className="waf-tongue-stamp" data-testid="frog-stamp">
				<circle cx="0" cy="0" r="32" fill="#e2707a" />
				<circle
					cx="0"
					cy="0"
					r="25"
					fill="none"
					stroke="#fff"
					strokeWidth="3"
					strokeDasharray="6 5"
				/>
				<path
					d="M-14 0 l10 11 l19 -21"
					stroke="#fff"
					strokeWidth="6"
					fill="none"
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
			</g>
			<g className="waf-tongue-frog">
				<FrogBody
					mouth="o"
					extra={
						<path
							className="waf-tongue-strip"
							d="M88 74 L-97 28"
							stroke="#e2707a"
							strokeWidth="13"
							fill="none"
							strokeLinecap="round"
						/>
					}
				/>
			</g>
		</g>
	);
}

/** 14 手绘描边：轮廓线自己画出 → 上色 → 蹦一下 → 手写✓。 */
export function SketchSvg() {
	return (
		<g className="waf-root waf-root-sketch">
			<g className="waf-sketch-hop">
				<g className="waf-sketch-fill">
					<FrogBody />
				</g>
				<SketchLines />
			</g>
			<path
				className="waf-sketch-check"
				d="M118 12 l11 12 l21 -25"
				fill="none"
				stroke="#5a8a4a"
				strokeWidth="7"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</g>
	);
}

/** 15 像素蛙：8-bit 逐帧蹦入（steps 硬切）→ 像素星闪烁 → 逐帧跳出。 */
export function PixelSvg() {
	return (
		<g className="waf-root waf-root-pixel">
			<g transform="translate(15,22)">
				<g className="waf-pixel-frog">
					<PixelFrogBody />
					<g className="waf-pixel-eye-shut">
						<rect x="18" y="18" width="18" height="9" fill="#6fbf4f" />
						<rect x="54" y="18" width="18" height="9" fill="#6fbf4f" />
						<rect x="20" y="21" width="14" height="3" fill="#22261e" />
						<rect x="56" y="21" width="14" height="3" fill="#22261e" />
					</g>
				</g>
			</g>
			<path
				className="waf-pixel-star"
				d="M70 -52 l4 9 9 4 -9 4 -4 9 -4 -9 -9 -4 9 -4 z"
				fill="#ffd97a"
			/>
			<path
				className="waf-pixel-star s2"
				d="M95 -30 l3 7 7 3 -7 3 -3 7 -3 -7 -7 -3 7 -3 z"
				fill="#ffd97a"
			/>
		</g>
	);
}

/** 17 魔法蛙：跳入 → 挥棒划弧 → 星星飞出汇成金✓徽章 → 开心跳。 */
export function MagicSvg() {
	const stars: Array<{
		cls: string;
		dx: string;
		dy: string;
		r: number;
		fill: string;
	}> = [
		{ cls: "", dx: "-25px", dy: "-38px", r: 5, fill: "#ffe08a" },
		{ cls: "s2", dx: "-60px", dy: "-18px", r: 4, fill: "#fff2c8" },
		{ cls: "s3", dx: "10px", dy: "-48px", r: 4.5, fill: "#ffe08a" },
		{ cls: "s4", dx: "-42px", dy: "-42px", r: 3, fill: "#fff2c8" },
		{ cls: "s5", dx: "32px", dy: "-26px", r: 4, fill: "#ffe08a" },
	];
	return (
		<g className="waf-root waf-root-magic">
			<g className="waf-magic-frog">
				<FrogBody
					extra={
						<g className="waf-magic-wand">
							<line
								x1="98"
								y1="76"
								x2="122"
								y2="46"
								stroke="#c9a55a"
								strokeWidth="5"
								strokeLinecap="round"
							/>
							<path d="M126 34 l4 9 9 4 -9 4 -4 9 -4 -9 -9 -4 9 -4 z" fill="#ffe08a" />
						</g>
					}
				/>
			</g>
			{stars.map((s) => (
				<circle
					key={s.cls || "st1"}
					className={`waf-magic-star ${s.cls}`.trim()}
					style={{ "--fx-sdx": s.dx, "--fx-sdy": s.dy } as React.CSSProperties}
					cx="70"
					cy="-20"
					r={s.r}
					fill={s.fill}
				/>
			))}
			<g className="waf-magic-badge" data-testid="frog-magic-badge">
				<circle cx="55" cy="-58" r="24" fill="#e8b84a" />
				<circle
					cx="55"
					cy="-58"
					r="17"
					fill="none"
					stroke="#fff8e0"
					strokeWidth="2.5"
				/>
				<path
					d="M45 -58 l7 9 l14 -16"
					stroke="#fff8e0"
					strokeWidth="5"
					fill="none"
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
			</g>
		</g>
	);
}

/** 18 蝌蚪变身：蝌蚪游入 → 打转白雾一闪变蛙 → 抖水呱一声 → 跳出。 */
export function TadpoleSvg() {
	return (
		<g className="waf-root waf-root-tadpole">
			<g className="waf-tad-tad" fill="#3f8e5f">
				<ellipse cx="0" cy="0" rx="14" ry="10" />
				<path d="M-12 0 Q-26 -9 -36 0 Q-26 9 -12 0" />
			</g>
			<circle className="waf-tad-flash" cx="24" cy="56" r="32" fill="#eef7ff" />
			<g className="waf-tad-frog">
				<FrogBody />
			</g>
			<g className="waf-tad-bubble">
				<CroakBubble x={-40} y={-88} />
			</g>
		</g>
	);
}

/** 19 合唱谢幕：大中小三蛙依次跳入排排坐 → 轮流呱冒音符 → 齐鞠躬四散。 */
export function ChorusSvg() {
	return (
		<g className="waf-root waf-root-chorus">
			<g transform="translate(-13,51) scale(0.62)">
				<g className="waf-chorus-a">
					<FrogBody />
				</g>
			</g>
			<g transform="translate(29,64) scale(0.52)">
				<g className="waf-chorus-b">
					<FrogBody />
				</g>
			</g>
			<g transform="translate(71,77) scale(0.42)">
				<g className="waf-chorus-c">
					<FrogBody />
				</g>
			</g>
			<text
				className="waf-chorus-note"
				x={-10}
				y={-70}
				fontSize="20"
				fill="#9fe07a"
			>
				♪
			</text>
			<text
				className="waf-chorus-note n2"
				x={60}
				y={-82}
				fontSize="16"
				fill="#9fe07a"
			>
				♫
			</text>
			<text
				className="waf-chorus-note n3"
				x={28}
				y={-76}
				fontSize="18"
				fill="#9fe07a"
			>
				♪
			</text>
			<text
				className="waf-chorus-note n4"
				x={95}
				y={-64}
				fontSize="15"
				fill="#9fe07a"
			>
				♫
			</text>
		</g>
	);
}

/** 20 敲锣蛙：跳入 → 锣锤哐哐两下（声波+锣震）→ 得意点头 → 跳出。 */
export function GongSvg() {
	return (
		<g className="waf-root waf-root-gong">
			<circle
				className="waf-gong-wave"
				cx="112"
				cy="86"
				r="32"
				fill="none"
				stroke="#e8b84a"
				strokeWidth="3"
			/>
			<circle
				className="waf-gong-wave w2"
				cx="112"
				cy="86"
				r="32"
				fill="none"
				stroke="#e8b84a"
				strokeWidth="2"
			/>
			<g className="waf-gong-frog">
				<FrogBody
					extra={
						<>
							<g className="waf-gong-disk">
								<circle cx="112" cy="86" r="20" fill="#e8b84a" />
								<circle cx="112" cy="86" r="12" fill="#d4a03a" />
								<circle cx="112" cy="86" r="5" fill="#b8862e" />
							</g>
							<g className="waf-gong-hammer">
								<line
									x1="118"
									y1="58"
									x2="134"
									y2="74"
									stroke="#7a5a3a"
									strokeWidth="5"
									strokeLinecap="round"
								/>
								<circle cx="135" cy="75" r="6" fill="#5a4630" />
							</g>
						</>
					}
				/>
			</g>
		</g>
	);
}

/** 变体 → SVG 组件映射。 */
export const VARIANT_SVGS: Record<FrogVariant, () => ReactNode> = {
	bounce: BounceSvg,
	backflip: BackflipSvg,
	roll: RollSvg,
	lily: LilySvg,
	parachute: ParachuteSvg,
	well: WellSvg,
	surf: SurfSvg,
	spa: SpaSvg,
	slingshot: SlingshotSvg,
	flowers: FlowersSvg,
	sign: SignSvg,
	salute: SaluteSvg,
	tongue: TongueSvg,
	sketch: SketchSvg,
	pixel: PixelSvg,
	magic: MagicSvg,
	tadpole: TadpoleSvg,
	chorus: ChorusSvg,
	gong: GongSvg,
};

/** 各变体动画总时长（ms），与 frog.css 的 keyframes 节奏一致。 */
export const VARIANT_MS: Record<FrogVariant, number> = {
	bounce: 2800,
	backflip: 3400,
	roll: 3400,
	lily: 4000,
	parachute: 4000,
	well: 4200,
	surf: 4000,
	spa: 4000,
	slingshot: 3600,
	flowers: 3600,
	sign: 3600,
	salute: 3000,
	tongue: 3600,
	sketch: 3600,
	pixel: 3200,
	magic: 3800,
	tadpole: 3800,
	chorus: 4200,
	gong: 3600,
};
