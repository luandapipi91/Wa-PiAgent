// share-client 测试：transport 注入模式（照 fs-client）。
// shareUpload / shareSettings / saveShareSettings 均通过 _setShareTransport 注入伪传输，
// 避免 bun mock.module 跨文件缓存污染。
import { test, expect, beforeEach, mock } from "bun:test";
import {
	_setShareTransport,
	shareUpload,
	shareSettings,
	saveShareSettings,
} from "./share-client";
import { ApiError } from "./api-client";

const postMock = mock(async () => ({}));
const putMock = mock(async () => ({}));
const getMock = mock(async () => ({}));

beforeEach(() => {
	postMock.mockReset();
	putMock.mockReset();
	getMock.mockReset();
	_setShareTransport({ post: postMock, put: putMock, get: getMock });
});

test("shareUpload 成功：POST /api/share/upload 返回 { url, expiresAt, projectName, channel }", async () => {
	postMock.mockResolvedValue({
		url: "https://share.edgeone.app/s/abc123",
		expiresAt: 1780000000000,
		projectName: "my-project",
		channel: "edgeone",
	});
	const res = await shareUpload(["/proj/a.txt", "/proj/b.txt"], "sess-1");
	expect(postMock).toHaveBeenCalledWith("/api/share/upload", {
		paths: ["/proj/a.txt", "/proj/b.txt"],
		sessionId: "sess-1",
	});
	expect(res.url).toBe("https://share.edgeone.app/s/abc123");
	expect(res.expiresAt).toBe(1780000000000);
	expect(res.projectName).toBe("my-project");
	expect(res.channel).toBe("edgeone");
});

test("shareUpload 未配置 token：400 抛错", async () => {
	postMock.mockRejectedValue(
		new ApiError("未配置分享 Token（设置 → 分享）", 400),
	);
	await expect(shareUpload(["/proj/a.txt"])).rejects.toThrow("未配置分享 Token");
});

test("shareSettings：GET /api/settings/share 返回脱敏结构 { hasToken, channel }，不下发 token 明文", async () => {
	getMock.mockResolvedValue({
		share: { hasToken: true, channel: "edgeone" },
	});
	const s = await shareSettings();
	expect(getMock).toHaveBeenCalledWith("/api/settings/share");
	expect(s.hasToken).toBe(true);
	expect(s.channel).toBe("edgeone");
	expect("token" in (s as object)).toBe(false);
});

test("shareSettings：未配置时 hasToken 为 false（响应缺省字段也按未配置处理）", async () => {
	getMock.mockResolvedValue({ share: {} });
	const s = await shareSettings();
	expect(s.hasToken).toBe(false);
	expect(s.channel).toBe("");
});

test("saveShareSettings：PUT /api/settings/share（body.share 仍为明文 token，仅上行）", async () => {
	putMock.mockResolvedValue({ share: { hasToken: true, channel: "edgeone" } });
	await saveShareSettings({ token: "t", channel: "edgeone" });
	expect(putMock).toHaveBeenCalledWith("/api/settings/share", {
		share: { token: "t", channel: "edgeone" },
	});
});
