import { test, expect } from "bun:test";
import { createLogger } from "../src/log";
import { readFile, rm } from "node:fs/promises";

test("createLogger: 写带时间戳的行", async () => {
  const path = `${import.meta.dir}/.tmp.log`;
  const log = createLogger(path);
  log.info("hello");
  log.error("bad", new Error("x"));
  await new Promise((r) => setTimeout(r, 50));
  const txt = await readFile(path, "utf8");
  expect(txt).toContain("hello");
  expect(txt).toContain("bad");
  expect(txt).toContain("Error: x");
  await rm(path, { force: true });
});
