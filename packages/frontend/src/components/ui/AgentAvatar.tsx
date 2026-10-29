/**
 * 智能体头像渲染：统一 avatar 字段解析与展示（卡通彩色图标版）。
 *
 * avatar 字段是自由字符串（历史遗留）：
 * - "icon:名称" → avatar-icons.ts 卡通彩色图标（Fluent Emoji Flat，MIT；不跟随 currentColor）
 * - 命中 OLD_EMOJI_TO_ICON 映射的旧 emoji → 升级为彩色图标（老数据免迁移直接变新美术）
 * - 其余值（emoji 文本）→ 走旧路径原样渲染（旧会话/旧数据兼容），保留传入渐变底
 * - 空/未知 → robot 彩色兜底
 * 彩色图标自带配色：icon 类型一律用中性浅底承载（渐变底会与图标配色打架）。
 */
import {
	AVATAR_ICONS,
	isAvatarIconName,
	type AvatarIconName,
} from "./avatar-icons";

/** 旧内置角色 emoji → 卡通彩色图标（仅显示层映射，不改存储） */
export const OLD_EMOJI_TO_ICON: Record<string, AvatarIconName> = {
	"🖥️": "desktop-computer",
	"🏗️": "hammer-and-wrench",
	"🧭": "compass",
	"🔬": "microscope",
	"📈": "chart-increasing",
	"🧐": "magnifying-glass-tilted-left",
	"🎨": "artist-palette",
	"📋": "clipboard",
	"📝": "memo",
	"🤖": "robot",
	"🔍": "telescope",
	"📐": "straight-ruler",
	"✨": "sparkles",
	"⚙️": "gear",
};

/** emoji 归一化：去变体选择符（VS16），避免 ⚙ 与 ⚙️ 形态差异漏映射 */
const normalizeEmoji = (s: string) => s.replaceAll("\uFE0F", "").toLowerCase();
const OLD_EMOJI_LOOKUP = new Map(
	Object.entries(OLD_EMOJI_TO_ICON).map(([k, v]) => [normalizeEmoji(k), v] as const),
);

export type ResolvedAvatar =
	| { type: "icon"; icon: AvatarIconName }
	| { type: "emoji"; emoji: string }
	| { type: "none" };

export function resolveAgentAvatar(avatar?: string | null): ResolvedAvatar {
	const v = avatar?.trim();
	if (!v) return { type: "none" };
	if (v.startsWith("icon:")) {
		const name = v.slice(5);
		// 未知图标名按 none 处理（调用方兜底），避免渲染空白
		return isAvatarIconName(name) ? { type: "icon", icon: name } : { type: "none" };
	}
	const mapped = OLD_EMOJI_LOOKUP.get(normalizeEmoji(v));
	if (mapped) return { type: "icon", icon: mapped };
	return { type: "emoji", emoji: v };
}

interface ContentProps {
	avatar?: string | null;
	/** none 时的兜底展示（emoji 文本），默认 robot 图标 */
	fallback?: string;
	iconSize?: number;
	/** emoji 文本的字号类（透传自 AgentAvatar） */
	textClassName?: string;
}

/** 纯内容（无背景盒）：icon → 彩色 <svg>，emoji → 文本，none → 兜底（fallback 也走映射，无则 robot） */
export function AgentAvatarContent({
	avatar,
	fallback = "🤖",
	iconSize = 12,
	textClassName,
}: ContentProps) {
	const emojiText = (e: string) =>
		textClassName ? <span className={textClassName}>{e}</span> : <>{e}</>;
	const colored = (name: AvatarIconName) => (
		<span
			className="inline-block leading-none [&>svg]:w-full [&>svg]:h-full"
			style={{ width: iconSize, height: iconSize }}
			dangerouslySetInnerHTML={{ __html: AVATAR_ICONS[name] }}
		/>
	);
	const r = resolveAgentAvatar(avatar);
	if (r.type === "icon") return colored(r.icon);
	if (r.type === "emoji") return emojiText(r.emoji);
	const f = resolveAgentAvatar(fallback);
	if (f.type === "icon") return colored(f.icon);
	if (f.type === "emoji") return emojiText(f.emoji);
	return colored("robot");
}

interface AgentAvatarProps extends ContentProps {
	/** CSS background（渐变或单色）；icon 类型忽略此项改用中性底 */
	background?: string;
	/** 盒子尺寸类（tailwind），如 "w-[22px] h-[22px]" */
	className?: string;
	/** emoji 文本的字号类 */
	textClassName?: string;
	testId?: string;
}

/**
 * 智能体头像块：背景 + 内容（彩色图标/emoji），各渲染位点共用的视觉契约。
 * 彩色图标 → 中性浅底（var(--surface)）；emoji → 沿用调用方传入的渐变底。
 */
export function AgentAvatar({
	avatar,
	fallback,
	iconSize = 12,
	background,
	className = "",
	textClassName,
	testId,
}: AgentAvatarProps) {
	const main = resolveAgentAvatar(avatar);
	const colorful =
		main.type === "icon" ||
		(main.type === "none" && resolveAgentAvatar(fallback).type !== "emoji");
	return (
		<span
			data-testid={testId}
			className={`flex items-center justify-center flex-none rounded-sm ${className}`}
			style={{ background: colorful ? "var(--surface)" : background }}
		>
			<AgentAvatarContent
				avatar={avatar}
				fallback={fallback}
				iconSize={iconSize}
				textClassName={textClassName}
			/>
		</span>
	);
}
