import { afterEach, beforeEach, expect, test } from "bun:test";
import { detectInitialLanguage } from "../src/i18n/detect";

/**
 * detectInitialLanguage 决定首次启动语言，是纯函数 + 浏览器环境读取，
 * 三条分支：localStorage 已存值 > navigator.language > 回退 zh。
 * 注意：测试在 happydom-setup 注册的全局环境里跑，localStorage / navigator 可用。
 */
const UI_PREFS_KEY = "wa-pi-ui-prefs";

/** 暂存原始 navigator.language，便于在每个用例里临时改写后恢复。 */
let originalLanguage: string;
/** ES 版 Object.getOwnPropertyDescriptor 可读 navigator.language 的描述符。 */
let originalDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
	localStorage.clear();
	// 清除 happydom-setup 设置的 WA_PI_LANG，让本测试覆盖到真实 detect 分支
	delete process.env.WA_PI_LANG;
	// 记录 happy-dom 注册的 navigator.language 当前值与描述符
	originalLanguage = navigator.language;
	originalDescriptor = Object.getOwnPropertyDescriptor(navigator, "language");
});

afterEach(() => {
	// 恢复 WA_PI_LANG 为 zh，避免影响后续依赖默认中文的测试
	process.env.WA_PI_LANG = "zh";
	// 恢复 navigator.language
	Object.defineProperty(navigator, "language", {
		...(originalDescriptor ?? {
			configurable: true,
			writable: true,
			enumerable: true,
		}),
		value: originalLanguage,
	});
});

test("分支 1：localStorage 已持久化 zh → 返回 zh", () => {
	localStorage.setItem(
		UI_PREFS_KEY,
		JSON.stringify({ state: { language: "zh", fontSize: 16, exportTurns: 1 }, version: 0 }),
	);
	expect(detectInitialLanguage()).toBe("zh");
});

test("分支 1：localStorage 已持久化 en → 返回 en（尊重用户显式选择）", () => {
	localStorage.setItem(
		UI_PREFS_KEY,
		JSON.stringify({ state: { language: "en", fontSize: 16, exportTurns: 1 }, version: 0 }),
	);
	expect(detectInitialLanguage()).toBe("en");
});

test("分支 1：localStorage 有 key 但 language 字段非法 → 回退到环境检测", () => {
	localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ state: { fontSize: 16 } }));
	Object.defineProperty(navigator, "language", { configurable: true, value: "en-US" });
	expect(detectInitialLanguage()).toBe("en");
});

test("分支 1：localStorage 内容损坏（非 JSON）→ 静默回退环境检测", () => {
	localStorage.setItem(UI_PREFS_KEY, "{not json");
	Object.defineProperty(navigator, "language", { configurable: true, value: "zh-CN" });
	expect(detectInitialLanguage()).toBe("zh");
});

test("分支 2：无持久化值，navigator.language 为 zh-CN → 中文", () => {
	Object.defineProperty(navigator, "language", { configurable: true, value: "zh-CN" });
	expect(detectInitialLanguage()).toBe("zh");
});

test("分支 2：navigator.language 为 zh-TW → 中文", () => {
	Object.defineProperty(navigator, "language", { configurable: true, value: "zh-TW" });
	expect(detectInitialLanguage()).toBe("zh");
});

test("分支 2：navigator.language 为 en-US → 英文", () => {
	Object.defineProperty(navigator, "language", { configurable: true, value: "en-US" });
	expect(detectInitialLanguage()).toBe("en");
});

test("分支 2：navigator.language 为 fr-FR（非中非英）→ 英文（非中文一律英文）", () => {
	Object.defineProperty(navigator, "language", { configurable: true, value: "fr-FR" });
	expect(detectInitialLanguage()).toBe("en");
});

test("分支 3：navigator.language 为空字符串 → 回退中文", () => {
	Object.defineProperty(navigator, "language", { configurable: true, value: "" });
	expect(detectInitialLanguage()).toBe("zh");
});
