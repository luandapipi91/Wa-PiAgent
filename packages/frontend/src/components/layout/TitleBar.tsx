// 自绘标题栏：仅 macOS 桌面版渲染。
// 主进程在 macOS 下用了 titleBarStyle:"hiddenInset"（系统标题栏隐藏、只留红绿灯），
// 因为原生标题栏颜色由系统外观决定、不会跟应用主题。自绘这一条后，
// 背景/文字/描边都走 --titlebar-* 变量，8 套主题各自有配色。
//
// 布局照设计稿：标题居中（不是左对齐），红绿灯留在左侧由系统绘制。
// 战术终端是多一行的「报头」形态（wordmark + 青绿短条 + 等宽副标），
// 由 styles.css 里该主题的作用域规则变形，组件本身只输出统一结构。
import { useUiPrefsStore } from "../../store/ui-prefs";

/** 桌面版 macOS 且主进程已隐藏原生标题栏时才渲染 */
export function shouldRenderTitleBar(): boolean {
	const waPiApp = (window as unknown as { waPiApp?: { platform?: string } })
		.waPiApp;
	return Boolean(waPiApp) && waPiApp?.platform === "darwin";
}

/** 标题栏高度：主进程 trafficLightPosition.y=14 与该高度下红绿灯居中对应 */
export const TITLEBAR_HEIGHT = 40;

/** 副标是装饰性的主题身份标记（设计稿里就是英文大写），不随界面语言变化，
 *  所以不进 i18n——避免为装饰文本维护两份 locale。 */
const THEME_MARK: Record<string, string> = {
	system: "SYSTEM",
	light: "LIGHT",
	dark: "DARK",
	newspaper: "NEWSPAPER",
	pixel: "PIXEL",
	cyber: "CYBER",
	gilded: "GILDED",
	tactical: "战术终端 / TACTICAL",
};

export function TitleBar() {
	const themeMode = useUiPrefsStore((s) => s.themeMode);

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
					{THEME_MARK[themeMode] ?? ""}
				</span>
			</div>
		</header>
	);
}
