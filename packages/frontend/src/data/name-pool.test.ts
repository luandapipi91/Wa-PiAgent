import { test, expect } from "bun:test";
import { randomPersonName } from "./name-pool";

test("生成 2-3 字中文人名", () => {
  const name = randomPersonName();
  expect(name).toMatch(/^[\u4e00-\u9fa5]{2,3}$/);
});

test("避开已存在的名字", () => {
  // rng 恒为 0 → 永远取第一个组合；它已被占用时应重试或兜底
  const name = randomPersonName(["林晓岚"], () => 0);
  expect(name).not.toBe("林晓岚");
});

test("全部组合耗尽时兜底数字后缀", () => {
  // existing 包含第一个组合，rng 恒 0 → 50 次重试全撞 → 兜底
  const name = randomPersonName(["林晓岚", "林晓岚2"], () => 0);
  expect(name).toBe("林晓岚3");
});

test("多次生成不立即重复（统计性）", () => {
  const names = new Set(Array.from({ length: 20 }, () => randomPersonName()));
  expect(names.size).toBeGreaterThan(10);
});
