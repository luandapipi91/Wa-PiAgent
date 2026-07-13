import { test, expect, beforeEach } from "bun:test";
import {
  appendRecording, finalizeRecording, discardRecording, pathToUploadUrl, _setFsTransport,
} from "../src/fs-client";
import type { FsTransport } from "../src/fs-client";

function makeFakeTransport() {
  const sent: any[] = [];
  let responder: ((e: any) => any) | null = null;
  const transport: FsTransport = {
    send: (e) => sent.push(e),
    onMessage: (h) => { responder = h; return () => { responder = null; }; },
  };
  return { transport, sent, emit: (e: any) => responder?.(e) };
}

beforeEach(() => { /* 每个测试自建 transport */ });

test("appendRecording 发 fs:recording:append 并按 id 匹配响应", async () => {
  const fake = makeFakeTransport();
  _setFsTransport(fake.transport);
  const p = appendRecording("p1", "r1", "QUJD");
  expect(fake.sent[0].type).toBe("fs:recording:append");
  const id = fake.sent[0].id;
  fake.emit({ type: "fs:recording:append", id });
  await expect(p).resolves.toBeUndefined();
});

test("finalizeRecording 返回最终 path", async () => {
  const fake = makeFakeTransport();
  _setFsTransport(fake.transport);
  const p = finalizeRecording("p1", "r1", "rec.webm");
  const id = fake.sent[0].id;
  fake.emit({ type: "fs:recording:finalize", id, path: "/uploads/rec.webm" });
  await expect(p).resolves.toEqual({ path: "/uploads/rec.webm" });
});

test("finalizeRecording 收 error 时 reject", async () => {
  const fake = makeFakeTransport();
  _setFsTransport(fake.transport);
  const p = finalizeRecording("p1", "r1", "rec.webm");
  fake.emit({ type: "fs:recording:finalize", id: fake.sent[0].id, path: "", error: "boom" });
  await expect(p).rejects.toThrow("boom");
});

test("discardRecording 正常 resolve", async () => {
  const fake = makeFakeTransport();
  _setFsTransport(fake.transport);
  const p = discardRecording("p1", "r1");
  fake.emit({ type: "fs:recording:discard", id: fake.sent[0].id });
  await expect(p).resolves.toBeUndefined();
});

test("pathToUploadUrl 对绝对路径做 encode", () => {
  _setFsTransport(null);  // 不依赖 transport
  const u = pathToUploadUrl("/home/me/p/.hiagent/uploads/r.webm");
  expect(u).toBe("/file?path=" + encodeURIComponent("/home/me/p/.hiagent/uploads/r.webm"));
});
