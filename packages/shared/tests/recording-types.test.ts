import { test, expect } from "bun:test";
import type {
  AttachmentRef, AttachmentDraft,
  WSClientEvent, WSServerEvent,
  FSRecordingAppendRequest, FSRecordingFinalizeRequest, FSRecordingDiscardRequest,
  FSRecordingAppendResult, FSRecordingFinalizeResult, FSRecordingDiscardResult,
} from "../src/types";

test("AttachmentRef 接受 audio kind（含 durationMs）", () => {
  const a: AttachmentRef = { kind: "audio", name: "r.webm", path: "/p/r.webm", size: 10, durationMs: 1500 };
  expect(a.kind).toBe("audio");
});

test("AttachmentDraft 接受 audio kind", () => {
  const d: AttachmentDraft = { kind: "audio", name: "r.webm", path: "/p/r.webm", size: 10 };
  expect(d.kind).toBe("audio");
});

test("录音 WS 请求类型可构造且 type 正确", () => {
  const append: FSRecordingAppendRequest = { type: "fs:recording:append", id: "i1", projectId: "p1", recId: "r1", chunk: "QUJD" };
  const fin: FSRecordingFinalizeRequest = { type: "fs:recording:finalize", id: "i2", projectId: "p1", recId: "r1", finalName: "rec.webm" };
  const disc: FSRecordingDiscardRequest = { type: "fs:recording:discard", id: "i3", projectId: "p1", recId: "r1" };
  expect(append.type).toBe("fs:recording:append");
  expect(fin.type).toBe("fs:recording:finalize");
  expect(disc.type).toBe("fs:recording:discard");
});

test("录音 WS 结果类型可构造", () => {
  const ra: FSRecordingAppendResult = { type: "fs:recording:append", id: "i1" };
  const rf: FSRecordingFinalizeResult = { type: "fs:recording:finalize", id: "i2", path: "/p/uploads/rec.webm" };
  const rd: FSRecordingDiscardResult = { type: "fs:recording:discard", id: "i3" };
  expect(ra.id).toBe("i1");
  expect(rf.path).toContain("rec.webm");
  expect(rd.id).toBe("i3");
});

test("录音事件归入 WS 联合类型", () => {
  const c: WSClientEvent = { type: "fs:recording:append", id: "i1", projectId: "p1", recId: "r1", chunk: "" };
  const s: WSServerEvent = { type: "fs:recording:finalize", id: "i2", path: "/x" };
  expect(c.type).toBe("fs:recording:append");
  expect(s.type).toBe("fs:recording:finalize");
});
