import { test, expect } from "bun:test";
import { ElapsedTracker, formatDuration } from "../src/recording/recorder";

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
