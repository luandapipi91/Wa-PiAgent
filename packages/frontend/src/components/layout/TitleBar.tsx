// 自绘标题栏：仅桌面版（Electron）渲染，Web 模式不生成任何元素。
//
// 两个平台的「隐藏原生标题栏」方式不同，但目标一致——让窗口顶部跟随应用主题：
//   macOS  ：标题栏用 titleBarStyle:"hiddenInset"，红绿灯（左侧）由系统绘制；
//   Windows：标题栏用 titleBarStyle:"hidden" + titleBarOverlay，最小化/最大化/关闭
//            由系统画在右侧，配色通过 IPC 同步（Electron 只接受 #RRGGBB）。
// 因此组件本身只负责「底色 + 居中标题」；窗口按钮和红绿灯都不在这里画。
// Linux 保留原生窗口框，不渲染。
import { useEffect } from "react";
import { useProjectsStore } from "../../store/projects";
import { useUiPrefsStore } from "../../store/ui-prefs";

type DesktopBridge = {
	platform?: string;
	setTitleBarOverlay?: (opts: {
		color: string;
		symbolColor: string;
		height: number;
	}) => Promise<boolean>;
};

function bridge(): DesktopBridge | undefined {
	return (window as unknown as { waPiApp?: DesktopBridge }).waPiApp;
}

/** 当前平台是否走自绘标题栏（只有打包后的桌面版才有 waPiApp） */
export function shouldRenderTitleBar(): boolean {
	const platform = bridge()?.platform;
	return platform === "darwin" || platform === "win32";
}

/** 标题栏高度：macOS 红绿灯 y=14、Windows overlay height 都与 40px 对齐 */
export const TITLEBAR_HEIGHT = 40;

/** 没有选中项目时的副标文案（不再是主题名——用户要的是「我在哪」而不是「什么主题」） */
const NO_PROJECT_LABEL = "你的小助手";

/** Electron 的 overlay 只认 #RRGGBB：把主题变量里的 hex/rgb(a) 统一成 hex。
 *  取不到（变量缺失、颜色函数等）就回退到给定默认值。 */
export function toHex(color: string, fallback: string): string {
	const value = color.trim();
	if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase();
	const hex3 = value.match(/^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/);
	if (hex3) {
		return `#${hex3[1]}${hex3[1]}${hex3[2]}${hex3[2]}${hex3[3]}${hex3[3]}`.toLowerCase();
	}
	const rgb = value.match(
		/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i,
	);
	if (rgb) {
		return `#${[rgb[1], rgb[2], rgb[3]]
			.map((n) => Number(n).toString(16).padStart(2, "0"))
			.join("")}`;
	}
	return fallback;
}

/** 读 html 上解析后的主题变量实际值（system 模式已由 useIsDarkMode 落成 light/dark） */
function readTitlebarColors(): { color: string; symbolColor: string } {
	const cs = getComputedStyle(document.documentElement);
	return {
		color: toHex(cs.getPropertyValue("--titlebar-bg"), "#1a1a1e"),
		symbolColor: toHex(cs.getPropertyValue("--titlebar-text"), "#f5f5f7"),
	};
}

export function TitleBar() {
	const themeMode = useUiPrefsStore((s) => s.themeMode);
	// 副标只显示「当前项目名」：项目由选中会话或新会话页下拉决定，两者都落到
	// currentProjectId，所以这里读它一处即可；没有项目时显示固定文案。
	const projectName = useProjectsStore((s) => {
		if (!s.currentProjectId) return "";
		return s.projects.find((p) => p.id === s.currentProjectId)?.name?.trim() ?? "";
	});
	const platform = bridge()?.platform;
	const isWindows = platform === "win32";

	// Windows：主题变化后把标题栏底色/符号色推给系统绘制的窗口按钮区。
	// 依赖 themeMode 而不是变量值——切主题时 CSS 变量会在同一帧更新，
	// 这里等一帧再读，避免读到旧值。Web 模式与 macOS 下此调用不存在，自然跳过。
	useEffect(() => {
		if (!isWindows) return;
		const push = () => {
			const { color, symbolColor } = readTitlebarColors();
			void bridge()?.setTitleBarOverlay?.({ color, symbolColor, height: TITLEBAR_HEIGHT });
		};
		const raf = requestAnimationFrame(push);
		return () => cancelAnimationFrame(raf);
	}, [isWindows, themeMode]);

	if (!shouldRenderTitleBar()) return null;

	return (
		<header
			className="titlebar"
			data-testid="titlebar"
			style={{ height: TITLEBAR_HEIGHT }}
		>
			<div className="titlebar-masthead">
				<span className="titlebar-wordmark">WA PI AGENT</span>
				<span className="titlebar-dateline" data-testid="titlebar-theme">
					<i className="titlebar-bar" aria-hidden="true" />
					{projectName || NO_PROJECT_LABEL}
				</span>
			</div>
		</header>
	);
}
