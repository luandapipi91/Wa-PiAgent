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

import { readFile } from "../src/fs-client";

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
