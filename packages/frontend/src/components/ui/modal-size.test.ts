// 弹窗尺寸工具单测：视口 clamp + localStorage 持久化（FilePreviewModal / MediaPreviewModal 共用）
import { test, expect, beforeEach } from "bun:test";
import {
	clampModalSize,
	readSavedSize,
	saveModalSize,
	MODAL_SIZE_KEYS,
	MIN_MODAL_W,
	MIN_MODAL_H,
} from "./modal-size";

beforeEach(() => {
	localStorage.clear();
	window.innerWidth = 1000;
	window.innerHeight = 800;
});

test("clampModalSize：视口内的尺寸原样返回", () => {
	expect(clampModalSize(640, 480)).toEqual({ width: 640, height: 480 });
});

test("clampModalSize：超过视口被夹到视口（窗口变小后重开不溢出）", () => {
	expect(clampModalSize(2000, 1600)).toEqual({ width: 1000, height: 800 });
});

test("clampModalSize：小于最小值被夹到最小尺寸", () => {
	expect(clampModalSize(100, 50)).toEqual({
		width: MIN_MODAL_W,
		height: MIN_MODAL_H,
	});
});

test("clampModalSize：非有限数回退最小尺寸（坏数据不产生 NaN 尺寸）", () => {
	expect(clampModalSize(NaN, Infinity)).toEqual({
		width: MIN_MODAL_W,
		height: MIN_MODAL_H,
	});
});

test("readSavedSize：无记录返回 null（调用方回落到默认尺寸）", () => {
	expect(readSavedSize(MODAL_SIZE_KEYS.mediaPreview)).toBeNull();
});

test("readSavedSize：坏 JSON / 形状非法返回 null", () => {
	localStorage.setItem(MODAL_SIZE_KEYS.mediaPreview, "{不是JSON");
	expect(readSavedSize(MODAL_SIZE_KEYS.mediaPreview)).toBeNull();
	localStorage.setItem(
		MODAL_SIZE_KEYS.mediaPreview,
		JSON.stringify({ width: "x", height: 300 }),
	);
	expect(readSavedSize(MODAL_SIZE_KEYS.mediaPreview)).toBeNull();
});

test("saveModalSize → readSavedSize 往返一致（越界尺寸按视口夹过）", () => {
	saveModalSize(MODAL_SIZE_KEYS.mediaPreview, { width: 900, height: 9999 });
	expect(readSavedSize(MODAL_SIZE_KEYS.mediaPreview)).toEqual({
		width: 900,
		height: 800,
	});
});

test("文件预览窗沿用既有键名（兼容老记录），两窗尺寸键互不覆盖", () => {
	expect(MODAL_SIZE_KEYS.filePreview).toBe("hiagent.filePreview.size");
	saveModalSize(MODAL_SIZE_KEYS.filePreview, { width: 700, height: 500 });
	saveModalSize(MODAL_SIZE_KEYS.mediaPreview, { width: 800, height: 600 });
	expect(readSavedSize(MODAL_SIZE_KEYS.filePreview)).toEqual({
		width: 700,
		height: 500,
	});
	expect(readSavedSize(MODAL_SIZE_KEYS.mediaPreview)).toEqual({
		width: 800,
		height: 600,
	});
});
