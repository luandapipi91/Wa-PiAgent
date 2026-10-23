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

test("openMediaPreview：写入 items/index/sessionId（并带本次打开序号 openId）", () => {
	useSessionStore.getState().openMediaPreview(ITEMS, 1, "s1");
	const st = useSessionStore.getState().mediaPreview!;
	expect(st).toMatchObject({ items: ITEMS, index: 1, sessionId: "s1" });
	expect(typeof st.openId).toBe("number");
});

test("openMediaPreview：每次打开 openId 递增（同目录画廊据此判断是否需重新加载）", () => {
	useSessionStore.getState().openMediaPreview(ITEMS, 0, "s1");
	const a = useSessionStore.getState().mediaPreview!.openId;
	useSessionStore.getState().openMediaPreview(ITEMS, 0, "s1");
	const b = useSessionStore.getState().mediaPreview!.openId;
	expect(b).toBeGreaterThan(a);
});

test("setMediaPreviewItems：替换 items 与 index，openId 不变（不触发重复加载）", () => {
	useSessionStore.getState().openMediaPreview(ITEMS, 0, "s1");
	const openId = useSessionStore.getState().mediaPreview!.openId;
	const next: MediaItem[] = [{ src: "/d/a.png", kind: "image", name: "a.png" }];
	useSessionStore.getState().setMediaPreviewItems(next, 0);
	const st = useSessionStore.getState().mediaPreview!;
	expect(st.items).toBe(next);
	expect(st.index).toBe(0);
	expect(st.openId).toBe(openId);
});

test("setMediaPreviewItems：弹窗未打开时空操作；index 越界回落到 0", () => {
	useSessionStore.getState().setMediaPreviewItems(ITEMS, 0);
	expect(useSessionStore.getState().mediaPreview).toBeNull();
	useSessionStore.getState().openMediaPreview(ITEMS, 2, "s1");
	useSessionStore.getState().setMediaPreviewItems([ITEMS[0]], 5);
	expect(useSessionStore.getState().mediaPreview!.index).toBe(0);
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
