import { test, expect, beforeEach } from "bun:test";
import { useSessionStore } from "../src/store/session";
import type { MediaItem } from "../src/components/blocks/media-utils";

const ITEMS: MediaItem[] = [
	{ src: "/x/a.png", kind: "image", name: "a.png" },
	{ src: "/x/b.mp4", kind: "video", name: "b.mp4" },
	{ src: "/x/c.png", kind: "image", name: "c.png" },
];

beforeEach(() => {
	useSessionStore.setState({ mediaPreview: null });
});

test("openMediaPreview：写入 items/index/sessionId", () => {
	useSessionStore.getState().openMediaPreview(ITEMS, 1, "s1");
	expect(useSessionStore.getState().mediaPreview).toEqual({
		items: ITEMS,
		index: 1,
		sessionId: "s1",
	});
});

test("openMediaPreview：空 items 不打开", () => {
	useSessionStore.getState().openMediaPreview([], 0, "s1");
	expect(useSessionStore.getState().mediaPreview).toBeNull();
});

test("closeMediaPreview：清空；重复关闭幂等（无状态变更）", () => {
	useSessionStore.getState().openMediaPreview(ITEMS, 0, "s1");
	useSessionStore.getState().closeMediaPreview();
	expect(useSessionStore.getState().mediaPreview).toBeNull();
	// 已为 null 时 close 不应产生新状态（沿用 closeFilePreview 幂等模式）
	useSessionStore.getState().closeMediaPreview();
	expect(useSessionStore.getState().mediaPreview).toBeNull();
});

test("setMediaPreviewIndex：合法范围内切换", () => {
	useSessionStore.getState().openMediaPreview(ITEMS, 0, "s1");
	useSessionStore.getState().setMediaPreviewIndex(2);
	expect(useSessionStore.getState().mediaPreview?.index).toBe(2);
});

test("setMediaPreviewIndex：越界/相同值不产生状态变更", () => {
	useSessionStore.getState().openMediaPreview(ITEMS, 0, "s1");
	const before = useSessionStore.getState().mediaPreview;
	useSessionStore.getState().setMediaPreviewIndex(3);
	useSessionStore.getState().setMediaPreviewIndex(-1);
	useSessionStore.getState().setMediaPreviewIndex(0);
	expect(useSessionStore.getState().mediaPreview).toBe(before);
});

test("setMediaPreviewIndex：弹窗未打开时为空操作", () => {
	useSessionStore.getState().setMediaPreviewIndex(1);
	expect(useSessionStore.getState().mediaPreview).toBeNull();
});
