import { describe, expect, test } from "bun:test";
import {
  recordBefore,
  recordAfter,
  applySizeLimit,
  serializeSnapshots,
  SNAPSHOT_SIZE_LIMIT,
  type FileSnapshotRecord,
  type SnapshotReadResult,
} from "../src/file-snapshot";

const read = (map: Record<string, string | { code: string }>): ((p: string) => SnapshotReadResult) => {
  return (p) => {
    const v = map[p];
    if (v === undefined) return { kind: "error" };
    if (typeof v === "object") return v.code === "ENOENT" ? { kind: "missing" } : { kind: "error" };
    return { kind: "content", content: v };
  };
};

describe("文件快照采集", () => {
  test("edit：记录首次 before 与末次 after（同一文件多次编辑只留首 before / 末 after）", () => {
    const snap = new Map<string, FileSnapshotRecord>();
    const id2path = new Map<string, string>();
    const r = read({ "/a.ts": "v0" });

    recordBefore(snap, id2path, "c1", "/a.ts", r); // 首次 → before=v0
    // 模拟 c1 执行后文件变为 v1
    const r1 = read({ "/a.ts": "v1" });
    recordAfter(snap, id2path, "c1", r1); // after=v1

    recordBefore(snap, id2path, "c2", "/a.ts", r1); // 二次编辑 → 已有 before，跳过
    const r2 = read({ "/a.ts": "v2" });
    recordAfter(snap, id2path, "c2", r2); // after 覆盖为 v2

    expect(snap.get("/a.ts")).toEqual({ before: "v0", after: "v2" });
  });

  test("write 新建：before 为 null（ENOENT）", () => {
    const snap = new Map<string, FileSnapshotRecord>();
    const id2path = new Map<string, string>();
    const r = read({ "/new.ts": { code: "ENOENT" } });
    recordBefore(snap, id2path, "c1", "/new.ts", r);
    const r1 = read({ "/new.ts": "content" });
    recordAfter(snap, id2path, "c1", r1);
    expect(snap.get("/new.ts")).toEqual({ before: null, after: "content" });
  });

  test("读取失败（非 ENOENT）→ error 标记", () => {
    const snap = new Map<string, FileSnapshotRecord>();
    const id2path = new Map<string, string>();
    recordBefore(snap, id2path, "c1", "/x.ts", read({ "/x.ts": { code: "EACCES" } }));
    expect(snap.get("/x.ts")?.error).toBe(true);
  });

  test("applySizeLimit：超过阈值置 oversized 并清空内容", () => {
    const snap = new Map<string, FileSnapshotRecord>();
    const big = "a".repeat(SNAPSHOT_SIZE_LIMIT + 1);
    snap.set("/big.ts", { before: big, after: "x" });
    applySizeLimit(snap);
    const s = snap.get("/big.ts")!;
    expect(s.oversized).toBe(true);
    expect(s.before).toBeNull();
    expect(s.after).toBeNull();
  });

  test("serializeSnapshots：输出 path/before/after/标记", () => {
    const snap = new Map<string, FileSnapshotRecord>();
    snap.set("/a.ts", { before: "v0", after: "v1" });
    snap.set("/new.ts", { before: null, after: "c" });
    const out = serializeSnapshots(snap);
    expect(out).toEqual([
      { path: "/a.ts", before: "v0", after: "v1" },
      { path: "/new.ts", before: null, after: "c" },
    ]);
  });
});
