import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadKnowledgeRerankSettings,
  saveKnowledgeRerankSettings,
} from "../src/settings-store";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kb-rerank-settings-"));
  file = join(dir, "settings.json");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("knowledgeRerank 默认关闭；保存后读回 enabled=true", async () => {
  expect(await loadKnowledgeRerankSettings(file)).toEqual({ enabled: false });
  await saveKnowledgeRerankSettings({ enabled: true }, file);
  expect(await loadKnowledgeRerankSettings(file)).toEqual({ enabled: true });
});

test("保存只改 rerank 字段，不覆盖其它设置", async () => {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(file, JSON.stringify({ language: "zh", retry: { maxRetries: 3 } }), "utf8");
  await saveKnowledgeRerankSettings({ enabled: true }, file);
  const raw = JSON.parse(require("node:fs").readFileSync(file, "utf8"));
  expect(raw.language).toBe("zh");
  expect(raw.retry.maxRetries).toBe(3);
  expect(raw.knowledgeRerank.enabled).toBe(true);
});
