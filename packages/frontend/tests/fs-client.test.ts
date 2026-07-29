import { describe, test, expect, mock, beforeEach, afterAll, afterEach } from "bun:test";
import { listDir, readFile, uploadFile, _setFsTransport } from "../src/fs-client";
import { makeFakeFsTransport } from "./fs-transport";

const fake = makeFakeFsTransport();
_setFsTransport(fake.transport);
afterAll(() => _setFsTransport(null));

const originalFetch = globalThis.fetch;

describe("fs-client readFile", () => {
  beforeEach(() => {
    fake.calls.length = 0;
    fake.sent.length = 0;
    fake.responses.clear();
  });

  test("resolves with content on fs:readFile result", async () => {
    fake.setResponse("fs:readFile", { content: "abc", mimeType: "text/plain" });
    const result = await readFile("/tmp/a.txt");
    expect(fake.sent[0]).toEqual({ type: "fs:readFile", path: "/tmp/a.txt" });
    expect(result.content).toBe("abc");
    expect(result.mimeType).toBe("text/plain");
  });

  test("rejects on fs:readFile error", async () => {
    fake.setResponse("fs:readFile", { content: "", reason: "ENOENT" });
    await expect(readFile("/tmp/missing.txt")).rejects.toThrow("ENOENT");
  });
});

describe("fs-client listDir", () => {
  beforeEach(() => {
    fake.calls.length = 0;
    fake.sent.length = 0;
    fake.responses.clear();
  });

  test("发送 fs:listDir 请求并解析 entries", async () => {
    fake.setResponse("fs:listDir", { entries: [{ name: "a", isDir: true }] });
    const result = await listDir("/tmp");
    expect(fake.sent[0]).toEqual({ type: "fs:listDir", path: "/tmp", showHidden: undefined });
    expect(result).toEqual([{ name: "a", isDir: true }]);
  });

  test("showHidden 透传到请求", async () => {
    fake.setResponse("fs:listDir", { entries: [{ name: ".hidden", isDir: true }] });
    const result = await listDir("/tmp", true);
    expect(fake.sent[0]).toEqual({ type: "fs:listDir", path: "/tmp", showHidden: true });
    expect(result).toEqual([{ name: ".hidden", isDir: true }]);
  });

  test("错误时返回空数组", async () => {
    fake.setResponse("fs:listDir", {});
    const result = await listDir("/missing");
    expect(result).toEqual([]);
  });
});

describe("fs-client uploadFile", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(response: { ok: boolean; data?: unknown; status?: number }) {
    globalThis.fetch = mock((url: string, init: any) =>
      Promise.resolve({
        ok: response.ok,
        status: response.status ?? (response.ok ? 200 : 400),
        json: async () => response.data ?? {},
      }),
    ) as any;
  }

  test("resolves with path on multipart upload result", async () => {
    mockFetch({ ok: true, data: { path: "/project/p1/.wa-pi/uploads/img.png" } });
    const result = await uploadFile("p1", "img.png", new Blob(["base64data"]));
    expect(result.path).toBe("/project/p1/.wa-pi/uploads/img.png");
    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toContain("/api/files/upload?projectId=p1");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
  });

  test("rejects on upload error", async () => {
    mockFetch({ ok: false, status: 400, data: { error: "项目不存在" } });
    await expect(uploadFile("p1", "img.png", new Blob(["base64data"]))).rejects.toThrow("项目不存在");
  });

  test("sessionId 透传到 query", async () => {
    mockFetch({ ok: true, data: { path: "/p1/.wa-pi/uploads/img.png" } });
    await uploadFile("p1", "img.png", new Blob(["base64data"]), "sess-123");
    const [url] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toContain("projectId=p1");
    expect(url).toContain("sessionId=sess-123");
  });

  test("不传 sessionId 时 query 不含 sessionId", async () => {
    mockFetch({ ok: true, data: { path: "/p1/.wa-pi/uploads/img.png" } });
    await uploadFile("p1", "img.png", new Blob(["base64data"]));
    const [url] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toContain("projectId=p1");
    expect(url).not.toContain("sessionId");
  });
});
