// 回复显示模式偏好：默认精简输出（只显示最后一条），可选完整输出（合并成本轮一张卡片）。
// 断言重点：默认值、setter 生效、持久化到 wa-pi-ui-prefs。
import { beforeEach, expect, test } from "bun:test";
import {
	REPLY_DISPLAY_MODE_DEFAULT,
	useUiPrefsStore,
} from "../src/store/ui-prefs";

beforeEach(() => {
	localStorage.clear();
	useUiPrefsStore.setState({ replyDisplayMode: REPLY_DISPLAY_MODE_DEFAULT });
});

test("回复显示默认为精简输出", () => {
	expect(REPLY_DISPLAY_MODE_DEFAULT).toBe("concise");
	expect(useUiPrefsStore.getState().replyDisplayMode).toBe("concise");
});

test("setReplyDisplayMode 更新状态并持久化", () => {
	useUiPrefsStore.getState().setReplyDisplayMode("full");
	expect(useUiPrefsStore.getState().replyDisplayMode).toBe("full");
	const raw = localStorage.getItem("wa-pi-ui-prefs");
	expect(raw).toBeTruthy();
	expect(JSON.parse(raw!).state.replyDisplayMode).toBe("full");
});

test("setReplyDisplayMode 切回精简输出", () => {
	useUiPrefsStore.getState().setReplyDisplayMode("full");
	useUiPrefsStore.getState().setReplyDisplayMode("concise");
	expect(useUiPrefsStore.getState().replyDisplayMode).toBe("concise");
});
