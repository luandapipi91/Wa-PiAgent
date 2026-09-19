// 平台检测工具单测：断言三平台下「在文件管理器中打开」文案随平台变化。
// happy-dom 下 navigator.userAgent 为只读，用 Object.defineProperty 临时改写（与现有
// clipboard/CodeBlockCard 测试中 mock navigator 的写法一致）。
import { test, expect, afterEach } from "bun:test";
import { detectPlatform, openInFileManagerLabel } from "../src/util/platform";

const originalUA = navigator.userAgent;

afterEach(() => {
	// 还原默认 UA，避免污染其它用例
	Object.defineProperty(navigator, "userAgent", {
		value: originalUA,
		configurable: true,
	});
});

function setUA(ua: string): void {
	Object.defineProperty(navigator, "userAgent", {
		value: ua,
		configurable: true,
	});
}

test("Windows UA → 在资源管理器中打开", () => {
	setUA(
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0",
	);
	expect(detectPlatform()).toBe("windows");
	expect(openInFileManagerLabel()).toBe("在资源管理器中打开");
});

test("macOS UA → 在访达中打开", () => {
	setUA(
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0",
	);
	expect(detectPlatform()).toBe("mac");
	expect(openInFileManagerLabel()).toBe("在访达中打开");
});

test("Linux UA → 在文件管理器中打开", () => {
	setUA(
		"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0",
	);
	expect(detectPlatform()).toBe("linux");
	expect(openInFileManagerLabel()).toBe("在文件管理器中打开");
});
