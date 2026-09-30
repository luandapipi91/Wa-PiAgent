import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { getExtensionPath } from "@sqliteai/sqlite-vector";

test("sqlite-vector 扩展可加载并报告版本", () => {
  const db = new Database(":memory:");
  db.loadExtension(getExtensionPath());
  const v = db.query("select vector_version() v").get() as { v: string };
  expect(v.v).toMatch(/^\d+\.\d+\.\d+/);
  db.close();
});
