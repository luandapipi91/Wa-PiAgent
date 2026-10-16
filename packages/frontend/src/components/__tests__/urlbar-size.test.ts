// URL 栏宽度计算纯函数单元测试：
// 默认宽度占工具栏一半（halfUrlBarW）；拖拽持久化值经 loadStoredUrlBarW 恢复，
// 无记录或非法时返回 null（由 CSS 50% 兜底）；上限扣除图标按钮区且不低于最小宽度。
import { test, expect } from "bun:test";
import {
	URLBAR_WIDTH_KEY,
	MIN_URLBAR_W,
	URLBAR_ICON_RESERVE_PX,
	urlBarMaxW,
	halfUrlBarW,
	loadStoredUrlBarW,
} from "../urlbar-size";

test("常规工具栏：上限 = 工具栏宽 − 按钮区预留", () => {
	expect(urlBarMaxW(1000)).toBe(1000 - URLBAR_ICON_RESERVE_PX);
});

test("极窄工具栏（扣除预留后不足）：不低于最小宽度，避免输入框消失", () => {
	expect(urlBarMaxW(200)).toBe(MIN_URLBAR_W);
	expect(urlBarMaxW(0)).toBe(MIN_URLBAR_W);
});

test("默认宽度 = 工具栏一半（像素取整）", () => {
	expect(halfUrlBarW(1000)).toBe(500);
	expect(halfUrlBarW(801)).toBe(401); // Math.round(400.5)
});

test("工具栏太窄时默认宽度退到最小值（不可为负/消失）", () => {
	expect(halfUrlBarW(200)).toBe(MIN_URLBAR_W);
	expect(halfUrlBarW(0)).toBe(MIN_URLBAR_W);
});

test("未存储过宽度 → null（交由 50% CSS 生效）；低于最小宽度的脏值也视为 null", () => {
	localStorage.removeItem(URLBAR_WIDTH_KEY);
	expect(loadStoredUrlBarW()).toBeNull();
	localStorage.setItem(URLBAR_WIDTH_KEY, "50");
	expect(loadStoredUrlBarW()).toBeNull();
});

test("已存储合法宽度（480）→ 原样恢复", () => {
	localStorage.setItem(URLBAR_WIDTH_KEY, "480");
	expect(loadStoredUrlBarW()).toBe(480);
});
