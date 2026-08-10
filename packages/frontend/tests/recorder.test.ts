import { test, expect } from "bun:test";
import {
	ElapsedTracker,
	formatDuration,
	toRecordingErrorMessage,
} from "../src/recording/recorder";

test("formatDuration：< 1h 用 m:ss", () => {
  expect(formatDuration(0)).toBe("0:00");
  expect(formatDuration(65_000)).toBe("1:05");
  expect(formatDuration(599_999)).toBe("9:59");
});

test("formatDuration：≥ 1h 用 h:mm:ss", () => {
  expect(formatDuration(3_600_000)).toBe("1:00:00");
  expect(formatDuration(3_661_000)).toBe("1:01:01");
});

test("ElapsedTracker：start→elapsed 随时间增长；pause 冻结；resume 继续", () => {
  const t = new ElapsedTracker();
  t.start(1000);
  expect(t.elapsed(1000)).toBe(0);
  expect(t.elapsed(1500)).toBe(500);
  t.pause(2000);                  // 累积 1000ms
  expect(t.elapsed(3000)).toBe(1000);   // 暂停后不增长
  t.resume(4000);
  expect(t.elapsed(4000)).toBe(1000);
  expect(t.elapsed(4500)).toBe(1500);   // resume 后继续增长
});

test("ElapsedTracker：pause 幂等；resume 幂等", () => {
  const t = new ElapsedTracker();
  t.start(0);
  t.pause(100);                   // 累积 100
  t.pause(200);                   // 再次 pause：不重复累积
  expect(t.elapsed(300)).toBe(100);
  t.resume(400);
  t.resume(500);                  // 再次 resume：不重置基准
  expect(t.elapsed(600)).toBe(300);
});

test("toRecordingErrorMessage：NotAllowedError → 权限业务文案（非原始英文报错）", () => {
  const err = new DOMException("Permission denied", "NotAllowedError");
  const msg = toRecordingErrorMessage(err);
  // 不应是浏览器原始英文，而是可理解的中文业务文案
  expect(msg).toContain("权限");
  expect(msg).not.toContain("Permission denied");
});

test("toRecordingErrorMessage：NotFoundError → 无设备业务文案", () => {
  const err = new DOMException("Requested device not found", "NotFoundError");
  const msg = toRecordingErrorMessage(err);
  expect(msg).toContain("设备");
  expect(msg).not.toContain("Requested device not found");
});

test("toRecordingErrorMessage：NotReadableError → 设备占用业务文案", () => {
  const err = new DOMException("Device in use", "NotReadableError");
  const msg = toRecordingErrorMessage(err);
  expect(msg).toContain("占用");
  expect(msg).not.toContain("Device in use");
});

test("toRecordingErrorMessage：未知错误 → 兜底文案保留详情", () => {
  const msg = toRecordingErrorMessage(new Error("something weird"));
  expect(msg).toContain("something weird");
});

test("toRecordingErrorMessage：非 Error 值（undefined）→ 兜底不抛错", () => {
  const msg = toRecordingErrorMessage(undefined);
  expect(msg).toBeTruthy();
});
