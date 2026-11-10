import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, unlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KB_SCHEMA_SQL } from "../src/knowledge/schema";
import { KnowledgeStore } from "../src/knowledge/store";
import { closeAllKbDbs } from "../src/knowledge/kb-db";
import { runIndex, type KbContext, type EmbedFn } from "../src/knowledge/indexer";
import { diagnoseKb } from "../src/knowledge/diagnostics";
import { runDoctor, scoreFromIssues } from "../src/knowledge/doctor";
import { EMBED_DIM } from "../src/memory/schema";

const fakeEmbed: EmbedFn = async (texts) => texts.map(() => new Uint8Array(EMBED_DIM).fill(128));

let waPiDir: string;
let srcDir: string;
let reg: Database;
let store: KnowledgeStore;
let ctx: KbContext;
let kbId: string;

beforeEach(async () => {
  waPiDir = mkdtempSync(join(tmpdir(), "kb-doctor-wapidir-"));
  srcDir = mkdtempSync(join(tmpdir(), "kb-doctor-src-"));
  await Bun.write(join(srcDir, "a.md"), "# A\n\n甲内容。");
  await Bun.write(join(srcDir, "b.txt"), "乙内容。");
  reg = new Database(join(waPiDir, "knowledge.db"));
  reg.run(KB_SCHEMA_SQL);
  store = new KnowledgeStore(reg, waPiDir);
  ctx = { store, waPiDir, sse: () => {} };
  kbId = store.createKb({ folderPath: srcDir }).id;
});

afterEach(() => {
  closeAllKbDbs();
  reg.close();
  rmSync(waPiDir, { recursive: true, force: true });
  rmSync(srcDir, { recursive: true, force: true });
});

test("诊断：stale 文件（索引后被修改）与 orphan 文件（块在、源文件没了）都能识别", async () => {
  await runIndex(ctx, kbId, fakeEmbed);
  const future = Date.now() / 1000 + 60;
  utimesSync(join(srcDir, "a.md"), future, future); // 索引后修改
  unlinkSync(join(srcDir, "b.txt")); // 源文件删除
  const d = await diagnoseKb(ctx, kbId);
  expect(d.stale_files).toContain("a.md");
  expect(d.orphan_files).toContain("b.txt");
  expect(d.coverage_percent).toBeGreaterThanOrEqual(0);
});

test("健康分：无问题时 100；blocking 每条扣 35、warning 每条扣 12", () => {
  expect(scoreFromIssues([])).toBe(100);
  expect(scoreFromIssues([{ severity: "blocking" }, { severity: "warning" }])).toBe(53);
  expect(scoreFromIssues(Array(5).fill({ severity: "blocking" }))).toBe(0);
});

test("医生报告：有 stale 问题时给出 warning 与动作", async () => {
  await runIndex(ctx, kbId, fakeEmbed);
  const future = Date.now() / 1000 + 60;
  utimesSync(join(srcDir, "a.md"), future, future);
  const report = await runDoctor(ctx);
  expect(report.health_score).toBeLessThan(100);
  expect(report.issues.some((i) => i.severity === "warning" && /修改/.test(i.message))).toBe(true);
  expect(report.diagnostics.length).toBe(1);
});

test("诊断失败不冒充健康：源目录不可读时给 diagnosis_error 与 warning", async () => {
  await runIndex(ctx, kbId, fakeEmbed);
  store.updateStatus(kbId, "ready", { fileCount: 1, chunkCount: 1, lastIndexedAt: Date.now() });
  // 目录换成不存在路径 → 扫描失败
  const broken = store.createKb({ folderPath: "/definitely/not/exists/kb-xyz" });
  const d = await diagnoseKb(ctx, broken.id);
  expect(d.diagnosis_error).toBeTruthy();
  const report = await runDoctor(ctx);
  expect(report.issues.some((i) => /诊断未完成/.test(i.message))).toBe(true);
});

test("切块/模型指纹失配在体检里给出重建提示", async () => {
  await runIndex(ctx, kbId, fakeEmbed);
  store.updateStatus(kbId, "ready", { embedMeta: "stale-model:q8:768:chunker=1" });
  const report = await runDoctor(ctx);
  expect(report.issues.some((i) => /指纹/.test(i.message))).toBe(true);
});
