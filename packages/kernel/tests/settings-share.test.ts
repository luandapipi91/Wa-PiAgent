import { test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import {
  loadShareSettings,
  saveShareSettings,
  SHARE_DEFAULTS,
} from "../src/settings-store";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "settings-share-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("默认值：channel=edgeone, token 为空", async () => {
  expect(await loadShareSettings(join(dir, "settings.json"))).toEqual({
    ...SHARE_DEFAULTS,
  });
});
test("save 后 load 往返一致（token 脱敏无关，原样存取）", async () => {
  const file = join(dir, "settings.json");
  await saveShareSettings({ token: "tk_abc", channel: "edgeone" }, file);
  expect(await loadShareSettings(file)).toEqual({
    token: "tk_abc",
    channel: "edgeone",
  });
});
