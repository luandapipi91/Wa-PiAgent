import { test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  recordingTempPath, appendChunk, finalizeRecording, discardRecording, cleanupRecordingTemp,
} from "../src/recording-store";

const tmp = join(import.meta.dir, ".tmp-recording");
const uploads = join(tmp, "uploads");

beforeEach(() => { rmSync(tmp, { recursive: true, force: true }); mkdirSync(uploads, { recursive: true }); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

test("appendChunk 追加 base64 解码后的字节到临时文件", async () => {
  await appendChunk(uploads, "rec1", "QUJD");   // "ABC"
  await appendChunk(uploads, "rec1", "RA==");   // "D"
  const buf = readFileSync(recordingTempPath(uploads, "rec1"));
  expect(buf.length).toBe(4);
  expect(buf.toString()).toBe("ABCD");
});

test("appendChunk 多次落盘，内存不留历史（验证文件持续增长）", async () => {
  for (let i = 0; i < 5; i++) await appendChunk(uploads, "rec2", "QUJD");
  expect(readFileSync(recordingTempPath(uploads, "rec2")).length).toBe(15);
});

test("finalizeRecording 原子 move 到 uploads 并返回最终 path", async () => {
  await appendChunk(uploads, "rec3", "QUJD");
  const finalPath = await finalizeRecording(uploads, "rec3", "my-rec.webm");
  expect(finalPath).toBe(join(uploads, "my-rec.webm"));
  expect(existsSync(finalPath)).toBe(true);
  expect(existsSync(recordingTempPath(uploads, "rec3"))).toBe(false);  // 临时文件已移走
  expect(readFileSync(finalPath).toString()).toBe("ABC");
});

test("finalizeRecording 处理同名冲突（追加序号）", async () => {
  await appendChunk(uploads, "rec4a", "QQ==");
  await appendChunk(uploads, "rec4b", "Qg==");
  const p1 = await finalizeRecording(uploads, "rec4a", "dup.webm");
  const p2 = await finalizeRecording(uploads, "rec4b", "dup.webm");
  expect(p1).toBe(join(uploads, "dup.webm"));
  expect(p2).toBe(join(uploads, "dup (1).webm"));
});

test("discardRecording 删除临时文件（不存在时 no-op）", async () => {
  await appendChunk(uploads, "rec5", "QUJD");
  await discardRecording(uploads, "rec5");
  expect(existsSync(recordingTempPath(uploads, "rec5"))).toBe(false);
  await discardRecording(uploads, "rec5");  // 不抛
  expect(true).toBe(true);
});

test("cleanupRecordingTemp 清空临时目录残留", async () => {
  await appendChunk(uploads, "r-old1", "QUJD");
  await appendChunk(uploads, "r-old2", "QUJD");
  await cleanupRecordingTemp(uploads);
  expect(readdirSync(join(uploads, ".recording-tmp")).length).toBe(0);
});

test("recId 路径穿越防护：只保留 basename", () => {
  const p = recordingTempPath(uploads, "../../etc/passwd");
  expect(p).toBe(join(uploads, ".recording-tmp", "passwd.webm"));
  expect(p).not.toContain("..");
});
