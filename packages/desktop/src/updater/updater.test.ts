import { test, expect, describe } from "bun:test";
import { translateUpdaterEvent, updaterPhases } from "./updater.cjs";

describe("translateUpdaterEvent", () => {
  test("checking-for-update → checking", () => {
    expect(translateUpdaterEvent({ type: "checking-for-update" })).toEqual({ phase: "checking" });
  });

  test("update-available → available（携带 version + releaseNotes）", () => {
    const out = translateUpdaterEvent({ type: "update-available", info: { version: "0.2.0", releaseNotes: "修复" } });
    expect(out).toEqual({ phase: "available", version: "0.2.0", releaseNotes: "修复" });
  });

  test("update-not-available → up-to-date", () => {
    expect(translateUpdaterEvent({ type: "update-not-available" })).toEqual({ phase: "up-to-date" });
  });

  test("download-progress → downloading（percent/transferred/total）", () => {
    const out = translateUpdaterEvent({
      type: "download-progress",
      progress: { percent: 45.6, transferred: 57671680, total: 134217728 },
    });
    expect(out).toEqual({ phase: "downloading", progress: 45.6, transferred: 57671680, total: 134217728 });
  });

  test("update-downloaded → downloaded", () => {
    // 不传 info 时 version 为 null；带 version 字段是为了让前端（任务 7）能消费版本号。
    expect(translateUpdaterEvent({ type: "update-downloaded" })).toEqual({ phase: "downloaded", version: null });
  });

  test("error → error（message 提取）", () => {
    const out = translateUpdaterEvent({ type: "error", error: new Error("网络失败") });
    expect(out.phase).toBe("error");
    expect(out.message).toBe("网络失败");
  });

  test("未知事件 → null（忽略）", () => {
    expect(translateUpdaterEvent({ type: "unknown-event" })).toBeNull();
  });
});

describe("updaterPhases", () => {
  test("包含全部阶段", () => {
    expect(updaterPhases).toEqual(["checking", "available", "up-to-date", "downloading", "downloaded", "error"]);
  });
});
