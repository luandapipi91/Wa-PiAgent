import { test, expect } from "bun:test";

const {
	isStreamingTextVisible,
	clearStreamingVisibleCache,
	getStreamingVisibleCacheSize,
} = await import("./streaming-visible-cache");

test("clearStreamingVisibleCache 清空流式可见性缓存", () => {
	// 填充缓存（有可见内容的 markdown 会写入缓存）
	isStreamingTextVisible("# 有可见内容的 markdown 标题");
	expect(getStreamingVisibleCacheSize()).toBeGreaterThan(0);

	// 清理
	clearStreamingVisibleCache();
	expect(getStreamingVisibleCacheSize()).toBe(0);
});
