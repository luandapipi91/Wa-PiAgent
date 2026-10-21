import { test, expect, beforeEach, afterAll } from "bun:test";
import {
  appendRecording, finalizeRecording, discardRecording, pathToUploadUrl, _setFsTransport,
} from "../src/fs-client";
import { makeFakeFsTransport } from "./fs-transport";

const fake = makeFakeFsTransport();

beforeEach(() => {
  fake.calls.length = 0;
  fake.sent.length = 0;
  fake.responses.clear();
});

afterAll(() => _setFsTransport(null));

test("appendRecording 发 fs:recording:append 并 resolve", async () => {
  _setFsTransport(fake.transport);
  await expect(appendRecording("p1", "r1", "QUJD")).resolves.toBeUndefined();
  expect(fake.sent[0]).toMatchObject({ type: "fs:recording:append", projectId: "p1", recId: "r1", chunk: "QUJD" });
});

test("finalizeRecording 返回最终 path", async () => {
  _setFsTransport(fake.transport);
  fake.setResponse("fs:recording:finalize", { path: "/uploads/rec.webm" });
  await expect(finalizeRecording("p1", "r1", "rec.webm")).resolves.toEqual({ path: "/uploads/rec.webm" });
});

test("finalizeRecording 收 error 时 reject", async () => {
  _setFsTransport(fake.transport);
  fake.setResponse("fs:recording:finalize", { path: "", error: "boom" });
  await expect(finalizeRecording("p1", "r1", "rec.webm")).rejects.toThrow("boom");
});

test("discardRecording 正常 resolve", async () => {
  _setFsTransport(fake.transport);
  await expect(discardRecording("p1", "r1")).resolves.toBeUndefined();
});

test("pathToUploadUrl 对绝对路径做 encode", () => {
  _setFsTransport(null);
  const u = pathToUploadUrl("/home/me/p/.wa-pi/uploads/r.webm");
  expect(u).toBe("/file?path=" + encodeURIComponent("/home/me/p/.wa-pi/uploads/r.webm"));
});

test("appendRecording/finalizeRecording/discardRecording 透传 sessionId", async () => {
  _setFsTransport(fake.transport);
  fake.setResponse("fs:recording:finalize", { path: "/uploads/rec.webm" });

  await appendRecording("p1", "r1", "QUJD", "sess-abc");
  expect(fake.sent[0]).toMatchObject({ type: "fs:recording:append", sessionId: "sess-abc" });

  await finalizeRecording("p1", "r1", "rec.webm", "sess-abc");
  expect(fake.sent[1]).toMatchObject({ type: "fs:recording:finalize", sessionId: "sess-abc" });

  await discardRecording("p1", "r1", "sess-abc");
  expect(fake.sent[2]).toMatchObject({ type: "fs:recording:discard", sessionId: "sess-abc" });
});

test("appendRecording 不传 sessionId 时请求 sessionId 为 undefined", async () => {
  _setFsTransport(fake.transport);
  await appendRecording("p1", "r1", "QUJD");
  expect(fake.sent[0].sessionId).toBeUndefined();
});
