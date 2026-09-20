// 弹窗位置工具单测：视口 clamp + localStorage 持久化（FilePreviewModal / MediaPreviewModal 共用）
import { test, expect, beforeEach } from "bun:test";
import {
	clampModalPos,
	readSavedPos,
	saveModalPos,
	MODAL_POS_KEYS,
} from "./modal-position";

beforeEach(() => {
	localStorage.clear();
	window.innerWidth = 1000;
	window.innerHeight = 800;
});

test("clampModalPos：视口范围内的位置原样返回", () => {
	expect(clampModalPos(100, 80, 400, 300)).toEqual({ left: 100, top: 80 });
});

test("clampModalPos：右下出界被夹回视口内（整体可见）", () => {
	// 视口 1000×800，卡片 400×300 → 左上角上限 600/500
	expect(clampModalPos(900, 700, 400, 300)).toEqual({ left: 600, top: 500 });
});

test("clampModalPos：负坐标被夹回 0", () => {
	expect(clampModalPos(-120, -50, 400, 300)).toEqual({ left: 0, top: 0 });
});

test("clampModalPos：卡片大于视口时贴左上角（不产生负上限）", () => {
	expect(clampModalPos(50, 50, 1200, 900)).toEqual({ left: 0, top: 0 });
});

test("clampModalPos：非有限数回退 0（坏数据不产生 NaN 定位）", () => {
	expect(clampModalPos(NaN, Infinity, 400, 300)).toEqual({ left: 0, top: 0 });
});

test("readSavedPos：无记录返回 null", () => {
	expect(readSavedPos(MODAL_POS_KEYS.filePreview)).toBeNull();
});

test("readSavedPos：坏 JSON / 形状非法返回 null", () => {
	localStorage.setItem(MODAL_POS_KEYS.filePreview, "{不是JSON");
	expect(readSavedPos(MODAL_POS_KEYS.filePreview)).toBeNull();
	localStorage.setItem(MODAL_POS_KEYS.filePreview, JSON.stringify({ left: "x" }));
	expect(readSavedPos(MODAL_POS_KEYS.filePreview)).toBeNull();
});

test("saveModalPos → readSavedPos 往返一致", () => {
	saveModalPos(MODAL_POS_KEYS.mediaPreview, { left: 12, top: 34 });
	expect(readSavedPos(MODAL_POS_KEYS.mediaPreview)).toEqual({
		left: 12,
		top: 34,
	});
});

test("两个窗的位置键互不覆盖", () => {
	saveModalPos(MODAL_POS_KEYS.filePreview, { left: 1, top: 2 });
	saveModalPos(MODAL_POS_KEYS.mediaPreview, { left: 3, top: 4 });
	expect(readSavedPos(MODAL_POS_KEYS.filePreview)).toEqual({ left: 1, top: 2 });
	expect(readSavedPos(MODAL_POS_KEYS.mediaPreview)).toEqual({ left: 3, top: 4 });
});
