import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { WSServerEvent } from "@hiagent/shared";

const handlers = new Set<(e: WSServerEvent) => void>();
const sendMock = mock();

mock.module("../src/ws-instance", () => ({
  send: sendMock,
  onMessage: (h: (e: WSServerEvent) => void) => {
    handlers.add(h);
    return () => handlers.delete(h);
  },
}));

import { listDir, readFile, uploadFile } from "../src/fs-client";

describe("fs-client readFile", () => {
  beforeEach(() => {
    handlers.clear();
    sendMock.mockClear();
  });

  test("resolves with content on fs:readFile result", async () => {
    const promise = readFile("/tmp/a.txt");
    expect(sendMock).toHaveBeenCalledWith({ type: "fs:readFile", path: "/tmp/a.txt" });
    handlers.forEach(h =>
      h({ type: "fs:readFile", path: "/tmp/a.txt", content: "abc", mimeType: "text/plain" } as any)
    );
    const result = await promise;
    expect(result.content).toBe("abc");
    expect(result.mimeType).toBe("text/plain");
  });

  test("rejects on fs:readFile error", async () => {
    const promise = readFile("/tmp/missing.txt");
    handlers.forEach(h =>
      h({ type: "fs:readFile", path: "/tmp/missing.txt", content: "", error: "ENOENT" } as any)
    );
    await expect(promise).rejects.toThrow("ENOENT");
  });
});

describe("fs-client listDir", () => {
  beforeEach(() => {
    handlers.clear();
    sendMock.mockClear();
  });

  test("发送 fs:listDir 请求并解析 entries", async () => {
    const promise = listDir("/tmp");
    expect(sendMock).toHaveBeenCalledWith({ type: "fs:listDir", path: "/tmp", showHidden: undefined });
    handlers.forEach(h =>
      h({ type: "fs:listDir", path: "/tmp", entries: [{ name: "a", isDir: true }] } as any)
    );
    const result = await promise;
    expect(result).toEqual([{ name: "a", isDir: true }]);
  });

  test("showHidden 透传到请求", async () => {
    const promise = listDir("/tmp", true);
    expect(sendMock).toHaveBeenCalledWith({ type: "fs:listDir", path: "/tmp", showHidden: true });
    handlers.forEach(h =>
      h({ type: "fs:listDir", path: "/tmp", entries: [{ name: ".hidden", isDir: true }] } as any)
    );
    const result = await promise;
    expect(result).toEqual([{ name: ".hidden", isDir: true }]);
  });

  test("错误时返回空数组", async () => {
    const promise = listDir("/missing");
    handlers.forEach(h =>
      h({ type: "fs:error", path: "/missing", reason: "ENOENT" } as any)
    );
    const result = await promise;
    expect(result).toEqual([]);
  });
});

describe("fs-client uploadFile", () => {
  beforeEach(() => {
    handlers.clear();
    sendMock.mockClear();
  });

  test("resolves with path on fs:upload result", async () => {
    const promise = uploadFile("p1", "img.png", "base64data");
    const sent = sendMock.mock.calls[0][0];
    expect(sent.type).toBe("fs:upload");
    expect(sent.projectId).toBe("p1");
    expect(sent.name).toBe("img.png");
    expect(sent.content).toBe("base64data");

    handlers.forEach(h => h({ type: "fs:upload", id: sent.id, path: "/project/p1/.hiagent/uploads/img.png" } as any));

    const result = await promise;
    expect(result.path).toBe("/project/p1/.hiagent/uploads/img.png");
  });

  test("rejects on fs:upload timeout", async () => {
    const promise = uploadFile("p1", "img.png", "base64data", 50);
    await expect(promise).rejects.toThrow("上传超时");
  });

  test("rejects on fs:upload error", async () => {
    const promise = uploadFile("p1", "img.png", "base64data");
    const sent = sendMock.mock.calls[0][0];
    handlers.forEach(h => h({ type: "fs:upload", id: sent.id, path: "", error: "项目不存在" } as any));
    await expect(promise).rejects.toThrow("项目不存在");
  });
});
