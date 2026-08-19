// share-client 测试：transport 注入模式（照 fs-client）。
// shareUpload / shareSettings / saveShareSettings 均通过 _setShareTransport 注入伪传输，
// 避免 bun mock.module 跨文件缓存污染。
import { test, expect, beforeEach, mock } from "bun:test";
import {
	_setShareTransport,
	shareUpload,
	shareSettings,
	saveShareSettings,
	shareList,
	shareDelete,
	shareClear,
	shareDeploy,
	shareRefreshLink,
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
	// 第三参为长超时（上传含 COS 传输 + 部署轮询，默认 30s 不够）
	expect(postMock).toHaveBeenCalledWith(
		"/api/share/upload",
		{
			paths: ["/proj/a.txt", "/proj/b.txt"],
			sessionId: "sess-1",
		},
		600_000,
	);
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
	await saveShareSettings({
		token: "t",
		channel: "edgeone",
		accountId: "",
		customDomain: "",
	});
	expect(putMock).toHaveBeenCalledWith("/api/settings/share", {
		share: { token: "t", channel: "edgeone", accountId: "", customDomain: "" },
	});
});

test("shareList：GET /api/share/list 返回 items/pending/totalSize/totalLimit", async () => {
	getMock.mockResolvedValue({
		items: [
			{
				id: "s1",
				name: "proj-a",
				files: ["index.html"],
				size: 2048,
				createdAt: 1780000000000,
			},
		],
		pending: 2,
		totalSize: 2048,
		totalLimit: 104857600,
	});
	const r = await shareList();
	expect(getMock).toHaveBeenCalledWith("/api/share/list");
	expect(r.items).toHaveLength(1);
	expect(r.items[0].id).toBe("s1");
	expect(r.items[0].name).toBe("proj-a");
	expect(r.items[0].files).toEqual(["index.html"]);
	expect(r.items[0].size).toBe(2048);
	expect(r.items[0].createdAt).toBe(1780000000000);
	expect(r.pending).toBe(2);
	expect(r.totalSize).toBe(2048);
	expect(r.totalLimit).toBe(104857600);
});

test("shareDelete：POST /api/share/delete 带 { id }", async () => {
	postMock.mockResolvedValue({ ok: true });
	await shareDelete("s1");
	expect(postMock).toHaveBeenCalledWith("/api/share/delete", { id: "s1" });
});

test("shareClear：POST /api/share/clear", async () => {
	postMock.mockResolvedValue({ ok: true });
	await shareClear();
	expect(postMock).toHaveBeenCalledWith("/api/share/clear");
});

test("shareDeploy：POST /api/share/deploy（长超时）", async () => {
	postMock.mockResolvedValue({ ok: true, expiresAt: 1780000000000 });
	await shareDeploy();
	expect(postMock).toHaveBeenCalledWith(
		"/api/share/deploy",
		undefined,
		600_000,
	);
});

test("shareRefreshLink：POST /api/share/refresh-link 返回 { url, expiresAt }", async () => {
	postMock.mockResolvedValue({
		url: "https://share.edgeone.app/s/xyz789",
		expiresAt: 1780010800000,
	});
	const r = await shareRefreshLink("s1");
	expect(postMock).toHaveBeenCalledWith("/api/share/refresh-link", { id: "s1" });
	expect(r.url).toBe("https://share.edgeone.app/s/xyz789");
	expect(r.expiresAt).toBe(1780010800000);
});

test("shareSettings：解析 customDomain（缺省为空串）", async () => {
	getMock.mockResolvedValue({
		share: { hasToken: true, channel: "edgeone", customDomain: "share.example.com" },
	});
	const s1 = await shareSettings();
	expect(s1.customDomain).toBe("share.example.com");
	// 响应缺 customDomain 字段时回落 ""
	getMock.mockResolvedValue({
		share: { hasToken: true, channel: "edgeone" },
	});
	const s2 = await shareSettings();
	expect(s2.customDomain).toBe("");
});

test("shareOpenFolder：POST /api/share/open-folder", async () => {
	postMock.mockResolvedValue({ ok: true });
	const { shareOpenFolder } = await import("./share-client");
	await shareOpenFolder();
	expect(postMock).toHaveBeenCalledWith("/api/share/open-folder");
});
