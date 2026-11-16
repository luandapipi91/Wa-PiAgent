import { test, expect } from "bun:test";
import { shouldShowThemeIntro } from "../src/util/theme-intro";

test("新装用户（无 provider、无记录）→ 不弹升级引导（走新手引导）", () => {
	const input = {
		appVersion: "0.10.5",
		seenVersion: undefined,
		hasProvider: false,
	};
	expect(shouldShowThemeIntro(input)).toBe(false);
});

test("老用户升级（有 provider、无记录）→ 弹一次", () => {
	const input = {
		appVersion: "0.10.5",
		seenVersion: undefined,
		hasProvider: true,
	};
	expect(shouldShowThemeIntro(input)).toBe(true);
});

test("已记录当前版本 → 不再弹", () => {
	const input = {
		appVersion: "0.10.5",
		seenVersion: "0.10.5",
		hasProvider: true,
	};
	expect(shouldShowThemeIntro(input)).toBe(false);
});

test("再次升级到新版本 → 不再重复弹主题引导（只针对本次主题改版）", () => {
	const input = {
		appVersion: "0.11.0",
		seenVersion: "0.10.5",
		hasProvider: true,
	};
	expect(shouldShowThemeIntro(input)).toBe(false);
});

test("浏览器 dev 版本号兜底 '—' 时不弹", () => {
	const input = {
		appVersion: "—",
		seenVersion: undefined,
		hasProvider: true,
	};
	expect(shouldShowThemeIntro(input)).toBe(false);
});

test("新手引导正开着时不弹升级引导（新用户在向导第 1 步已选过主题）", () => {
	const input = {
		appVersion: "0.10.5",
		seenVersion: undefined,
		hasProvider: true,
		onboardingOpen: true,
	};
	expect(shouldShowThemeIntro(input)).toBe(false);
});
