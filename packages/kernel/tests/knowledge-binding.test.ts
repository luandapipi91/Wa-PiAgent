// knowledge-binding 测试（任务 9）：
// 绑定关系持久化（override JSON 直写透传 / 命名 agent 走 agent.md frontmatter），
// 删库悬挂引用清理（KnowledgeStore.onKbDeleted 回调 → removeKbBinding 写回），
// composePrompt 的 knowledge-bases 段含/不含语义。
import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KB_SCHEMA_SQL } from "../src/knowledge/schema";
import { KnowledgeStore } from "../src/knowledge/store";
import { removeKbBinding } from "../src/agent-manager";
import { ConfigStore } from "../src/config-store";
import { makeDefaultAgentConfig } from "../src/agent-md";
import {
  loadSubagentOverrides,
  saveSubagentOverride,
  getSubagentOverride,
} from "../src/subagent-store";
import {
  composePrompt,
  DEFAULT_PROMPT_SEGMENTS,
  WA_PI_DEFAULT_BASE_PROMPT,
} from "../src/system-prompt";

let tmpDir: string;
let overridesFile: string;
let agentsDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "kb-binding-test-"));
  overridesFile = join(tmpDir, "subagent-overrides.json");
  agentsDir = join(tmpDir, "agents");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const ctx = {
  defaultBasePrompt: WA_PI_DEFAULT_BASE_PROMPT,
  builtinSkillsDir: "/tmp/skills",
};

test("saveSubagentOverride 持久化 knowledgeBaseIds", async () => {
  await saveSubagentOverride(overridesFile, {
    type: "general-purpose",
    knowledgeBaseIds: ["kb_1", "kb_2"],
  });
  const override = await getSubagentOverride(overridesFile, "general-purpose");
  expect(override!.knowledgeBaseIds).toEqual(["kb_1", "kb_2"]);
});

test("deleteKb 清理所有绑定中的悬挂引用（审查重点 5）", async () => {
  // override 与 agent config 各含 kb_1
  await saveSubagentOverride(overridesFile, {
    type: "general-purpose",
    model: null,
    knowledgeBaseIds: ["kb_1", "kb_keep"],
  });
  const configStore = new ConfigStore(agentsDir);
  await configStore.saveAgent({
    ...makeDefaultAgentConfig("研究员"),
    knowledgeBaseIds: ["kb_1", "kb_keep"],
  });

  const db = new Database(":memory:");
  db.run(KB_SCHEMA_SQL);
  const store = new KnowledgeStore(db, tmpDir);
  let cleanupDone: Promise<void> = Promise.resolve();
  const triggered: string[] = [];
  store.setOnKbDeleted((kbId) => {
    triggered.push(kbId);
    cleanupDone = removeKbBinding(kbId, { configStore, overridesFile });
  });

  store.deleteKb("kb_1");
  expect(triggered).toEqual(["kb_1"]);
  await cleanupDone;

  // override 中的悬挂引用被移除，其余绑定保留
  const override = await getSubagentOverride(overridesFile, "general-purpose");
  expect(override!.knowledgeBaseIds).toEqual(["kb_keep"]);
  // agent config 中的悬挂引用被移除，其余绑定保留
  const config = await configStore.getAgent("研究员");
  expect(config!.knowledgeBaseIds).toEqual(["kb_keep"]);
});

test("removeKbBinding 对无绑定的 override/config 不做无谓写盘", async () => {
  await saveSubagentOverride(overridesFile, {
    type: "Plan",
    knowledgeBaseIds: ["kb_other"],
  });
  const configStore = new ConfigStore(agentsDir);
  await configStore.saveAgent(makeDefaultAgentConfig("助手"));
  await removeKbBinding("kb_1", { configStore, overridesFile });
  const override = await getSubagentOverride(overridesFile, "Plan");
  expect(override!.knowledgeBaseIds).toEqual(["kb_other"]);
});

test("agent.md 绑定字段往返：saveAgent → getAgent 保留 knowledgeBaseIds（不剥离）", async () => {
  const configStore = new ConfigStore(agentsDir);
  await configStore.saveAgent({
    ...makeDefaultAgentConfig("研究员"),
    knowledgeBaseIds: ["kb_a", "kb_b"],
  });
  const config = await configStore.getAgent("研究员");
  expect(config!.knowledgeBaseIds).toEqual(["kb_a", "kb_b"]);
});

test("composePrompt 含 knowledge-bases 段", () => {
  const out = composePrompt(DEFAULT_PROMPT_SEGMENTS, {
    ...ctx,
    knowledgeBasesContext: "<available_knowledge_bases>…",
  });
  expect(out).toContain("<available_knowledge_bases>");
});

test("未配置 knowledgeBasesContext 时该段不出现", () => {
  const out = composePrompt(DEFAULT_PROMPT_SEGMENTS, { ...ctx });
  expect(out).not.toContain("available_knowledge_bases");
});

test("loadSubagentOverrides 读回的 overrides 含 knowledgeBaseIds（JSON 直写透传）", async () => {
  await saveSubagentOverride(overridesFile, {
    type: "Explore",
    knowledgeBaseIds: ["kb_9"],
  });
  const all = await loadSubagentOverrides(overridesFile);
  expect(all).toEqual([
    { type: "Explore", knowledgeBaseIds: ["kb_9"] },
  ]);
});
