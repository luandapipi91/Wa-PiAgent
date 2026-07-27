#!/usr/bin/env bun
// eval-delegate-trigger.ts — delegate/fleet 派发触发率评测
//
// 仿 cocode-master/scripts/eval-task-trigger.mts：用分类提示集实测主 agent
// 在"该派/视情况/不该派"场景下调用 delegate/fleet 的触发率。
//
// 与生产一致的部分（保证测的就是线上行为）：
// - 系统提示词：composePrompt(prompts.json segments, { defaultBasePrompt, delegateRoster, builtinSkillsDir })
// - 工具面：默认排除式（不传 --tools，仅 -xt subagent）+ 全套扩展（pi-open-agents/web-access/mcp-adapter + provider-extension + hiagent-bridge）
//
// 与生产不同的部分（压成本）：
// - bridge 的 /bridge/tool 由本脚本内置 stub server 应答：delegate/fleet 只记录调用并立即
//   返回固定文本，不真 spawn 子代理——每个用例的成本 ≈ 主 agent 一次任务的开销。
//
// 用法：
//   bun run scripts/eval-delegate-trigger.ts [--limit N] [--sample N] [--model slug/modelId] [--dry-run] [--out path] [--timeout sec]
//   --limit N：取前 N 条；--sample N：每类各取前 N 条（冒烟推荐 --sample 1）
// 默认模型：providers.json 第一个 provider 的第一个模型。
// 配置来源：真实 ~/.hiagent（只读 providers/prompts；生成的扩展文件与 app 启动时幂等一致）。
// 注意：edit 类用例会让 agent 真实改动工作区文件，评测后请 git 检查并还原。

import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  HIAGENT_DIR,
  BUILTIN_SKILLS_DIR,
  PROMPTS_FILE,
  slugifyProviderName,
} from "@hiagent/shared";
import {
  RpcClient,
  buildPiArgs,
  resolvePiCliPath,
  resolvePiRuntime,
  type RpcEvent,
} from "../src/rpc-client";
import {
  composePrompt,
  ensurePromptsConfig,
  loadPromptSegments,
  DEFAULT_PROMPT_SEGMENTS,
  HIAGENT_DEFAULT_BASE_PROMPT,
} from "../src/system-prompt";
import { buildDelegateRoster } from "../src/delegate-tool";
import { ensureBridgeExtension } from "../src/bridge-extension";
import { ensureProviderExtensionRegistered } from "../src/provider-extension";
import { ProviderStore } from "../src/provider-store";
import { buildAdditionalExtensionPaths } from "../src/extensions";

// ---- 用例集（30 条，针对 HiAgent 自身代码库）----
// explore (12)：多步搜索/审计，应触发 delegate/fleet
// edit (8)：小改动，视情况（可能需要先探索）
// simple (10)：单次查找/问答，不应触发
type Category = "explore" | "edit" | "simple";
const CASES: Array<{ category: Category; prompt: string }> = [
  // --- explore (12) ---
  { category: "explore", prompt: "找出 packages/kernel/src 里所有调用 RpcClient.command 的地方，总结它们分别做什么。" },
  { category: "explore", prompt: "审计整个 packages/frontend/src 下 data-testid 的使用，按组件归类列出。" },
  { category: "explore", prompt: "agent-manager.ts 的会话生命周期是怎样的？从创建到销毁经过哪些方法，把调用链整理出来。" },
  { category: "explore", prompt: "搜索全仓库，列出所有读取或写入 ~/.hiagent 下文件的代码位置。" },
  { category: "explore", prompt: "packages/kernel 里有哪些地方处理了 pi 子进程异常退出？把每条路径的文件和处理方式找出来。" },
  { category: "explore", prompt: "调查 packages/frontend 的 store 目录：每个 store 的职责是什么，它们之间有没有交叉引用？" },
  { category: "explore", prompt: "找出所有引用 SUBAGENT_TYPES 常量的文件，解释每处用它来做什么。" },
  { category: "explore", prompt: "bridge-extension.ts 生成的扩展注册了哪些工具？每个工具的 schema 和超时分别是多少，逐条列出。" },
  { category: "explore", prompt: "审计 packages/kernel/tests 下哪些测试文件用到了 fake-pi fixture，各自覆盖了什么场景。" },
  { category: "explore", prompt: "系统提示词从 prompts.json 到最终注入 pi 进程经过哪些步骤？把相关函数和调用点都找出来。" },
  { category: "explore", prompt: "列出 packages/shared/src 里所有导出的常量，并按用途分类。" },
  { category: "explore", prompt: "调查前端 MessageList 组件的渲染分块逻辑：segmentBlocks 怎么工作，有哪些块类型？" },
  // --- edit (8) ---
  { category: "edit", prompt: "给 packages/kernel/src/subagent-telemetry.ts 的文件头注释补充一句落盘位置说明。" },
  { category: "edit", prompt: "packages/frontend/src/components/settings/SkillSection.tsx 里搜索框的 placeholder 改成「搜索技能名称...」。" },
  { category: "edit", prompt: "把 packages/kernel/src/delegate-tool.ts 里 MAX_SUBAGENT_CONCURRENCY 的注释更新为当前实际语义。" },
  { category: "edit", prompt: "给 packages/kernel/src/rpc-client.ts 的 getSessionStats 方法补一段 JSDoc 说明返回结构。" },
  { category: "edit", prompt: "CHANGELOG.md 顶部加一条今天的占位条目（类型：其他，内容：评测脚本冒烟）。" },
  { category: "edit", prompt: "packages/kernel/src/subagent-runner.ts 中 mapThinking 函数加一个 'minimal' 级别的注释说明。" },
  { category: "edit", prompt: "把 packages/kernel/scripts/eval-delegate-trigger.ts 里的每用例默认超时从 180s 改为 240s。" },
  { category: "edit", prompt: "给 packages/kernel/src/agent-manager.ts 的 _flushSubagentTelemetry 方法补充边界情况注释（无记录时不落盘）。" },
  // --- simple (10) ---
  { category: "simple", prompt: "packages/kernel/src/rpc-client.ts 的 buildPiArgs 函数支持哪些参数？念一下。" },
  { category: "simple", prompt: "MAX_SUBAGENT_CONCURRENCY 的值是多少？" },
  { category: "simple", prompt: "读 packages/kernel/package.json，告诉我 test 脚本是什么。" },
  { category: "simple", prompt: "PROMPTS_SCHEMA_VERSION 当前是几？" },
  { category: "simple", prompt: "delegate 工具的参数有哪两个？" },
  { category: "simple", prompt: "HIAGENT_DIR 默认指向哪个目录？" },
  { category: "simple", prompt: "subagent-telemetry.ts 里 estimateTokens 的估算比例是多少？" },
  { category: "simple", prompt: "packages/shared/src/constants.ts 里 SUBAGENT_TYPES 有哪几个内置类型？" },
  { category: "simple", prompt: "fleet 工具的并发上限是多少？" },
  { category: "simple", prompt: "读 packages/kernel/src/system-prompt.ts 前 20 行，告诉我这个文件是做什么的。" },
];

// ---- CLI 参数 ----
interface CliOpts {
  limit: number;
  /** 每类各取 N 条（冒烟用，优先于 --limit） */
  sample: number;
  model: string | null;
  dryRun: boolean;
  out: string | null;
  timeoutSec: number;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = { limit: CASES.length, sample: 0, model: null, dryRun: false, out: null, timeoutSec: 240 };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--limit": opts.limit = parseInt(argv[++i]!, 10); break;
      case "--sample": opts.sample = parseInt(argv[++i]!, 10); break;
      case "--model": opts.model = argv[++i]!; break;
      case "--dry-run": opts.dryRun = true; break;
      case "--out": opts.out = argv[++i]!; break;
      case "--timeout": opts.timeoutSec = parseInt(argv[++i]!, 10); break;
      default:
        console.error(`未知参数: ${argv[i]}`);
        process.exit(2);
    }
  }
  return opts;
}

/** 选用例：--sample N = 每类前 N 条；否则前 --limit 条 */
function selectCases(opts: CliOpts): typeof CASES {
  if (opts.sample > 0) {
    const picked: typeof CASES = [];
    for (const cat of ["explore", "edit", "simple"] as const) {
      picked.push(...CASES.filter((c) => c.category === cat).slice(0, opts.sample));
    }
    return picked;
  }
  return CASES.slice(0, Math.max(0, Math.min(opts.limit, CASES.length)));
}

// ---- stub bridge server：记录 delegate/fleet 调用并立即应答，不真跑子代理 ----
interface StubCall { tool: string; params: unknown; at: string }

function startStubBridge(): Promise<{ server: Server; port: number; token: string; calls: StubCall[] }> {
  const token = randomUUID();
  const calls: StubCall[] = [];
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/bridge/tool") {
      res.writeHead(404).end("{}");
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let msg: any = null;
      try { msg = JSON.parse(body); } catch { /* 非法 JSON 按 400 处理 */ }
      if (!msg || msg.token !== token) {
        res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "bad_token" }));
        return;
      }
      const tool = String(msg.tool ?? "");
      calls.push({ tool, params: msg.params, at: new Date().toISOString() });
      const text =
        tool === "delegate" || tool === "fleet"
          ? "（评测桩：子代理已完成任务，结果略）"
          : tool === "ask_user_question"
            ? "（评测桩：用户已取消提问）"
            : "（评测桩：ok）";
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ content: [{ type: "text", text }] }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0, token, calls });
    });
  });
}

// ---- 单用例执行 ----
interface CaseResult {
  index: number;
  category: Category;
  prompt: string;
  calledDelegate: boolean;
  delegateCalls: Array<{ tool: string; agent?: string }>;
  toolsCalled: string[];
  elapsedMs: number;
  error?: string;
}

async function runOneCase(
  index: number,
  category: Category,
  prompt: string,
  ctx: {
    promptFile: string;
    extensionPaths: string[];
    bridgeUrl: string;
    bridgeToken: string;
    stubCalls: StubCall[];
    provider: string;
    modelId: string;
    timeoutSec: number;
  },
): Promise<CaseResult> {
  const startedAt = Date.now();
  const result: CaseResult = {
    index,
    category,
    prompt,
    calledDelegate: false,
    delegateCalls: [],
    toolsCalled: [],
    elapsedMs: 0,
  };
  const sessionId = `eval-${randomUUID()}`;
  const stubMark = ctx.stubCalls.length; // 记录本用例前的 stub 调用数，用例后取增量

  let settled!: () => void;
  const settledPromise = new Promise<void>((resolve) => { settled = resolve; });
  const onEvent = (e: RpcEvent) => {
    if (e.type === "tool_execution_start" && typeof (e as any).toolName === "string") {
      result.toolsCalled.push((e as any).toolName);
    }
    if (e.type === "agent_settled") settled();
  };

  const client = new RpcClient({
    cliPath: resolvePiCliPath(),
    runtime: resolvePiRuntime(),
    args: buildPiArgs({
      noSession: true,
      systemPromptFile: ctx.promptFile,
      extensionPaths: ctx.extensionPaths,
      noSkills: true,
      excludeTools: ["subagent"], // 与生产默认排除式一致
      name: sessionId,
    }),
    cwd: join(import.meta.dir, "../../.."), // 仓库根：explore 用例的探索对象
    env: {
      PI_CODING_AGENT_DIR: HIAGENT_DIR,
      HIAGENT_BRIDGE_URL: ctx.bridgeUrl,
      HIAGENT_BRIDGE_TOKEN: ctx.bridgeToken,
      HIAGENT_SESSION_ID: sessionId,
    },
    onEvent,
    onExit: () => {},
  });

  try {
    await client.start();
    await client.setModel(ctx.provider, ctx.modelId);
    await client.prompt(prompt);
    await Promise.race([
      settledPromise,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error(`用例超时 (${ctx.timeoutSec}s)`)), ctx.timeoutSec * 1000),
      ),
    ]);
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    try { await client.abort(); } catch { /* 忽略 */ }
  } finally {
    await client.dispose().catch(() => {});
  }

  // 从 stub 增量里提取本用例的 delegate/fleet 调用
  for (const call of ctx.stubCalls.slice(stubMark)) {
    if (call.tool === "delegate" || call.tool === "fleet") {
      result.calledDelegate = true;
      const params = call.params as any;
      if (call.tool === "delegate") {
        result.delegateCalls.push({ tool: "delegate", agent: params?.agent });
      } else {
        const agents = Array.isArray(params?.tasks) ? params.tasks.map((t: any) => t?.agent).join("+") : undefined;
        result.delegateCalls.push({ tool: "fleet", agent: agents });
      }
    }
  }
  result.elapsedMs = Date.now() - startedAt;
  return result;
}

// ---- main ----
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cases = selectCases(opts);
  console.log(`\n=== Delegate 触发率评测：${cases.length}/${CASES.length} 条用例 ===`);

  // 模型：--model 或 providers.json 第一个 provider 的第一个模型
  const store = new ProviderStore();
  const providers = await store.load();
  let providerSlug: string;
  let modelId: string;
  if (opts.model) {
    const slash = opts.model.indexOf("/");
    if (slash <= 0) {
      console.error("--model 需要 slug/modelId 形式");
      process.exit(2);
    }
    providerSlug = opts.model.slice(0, slash);
    modelId = opts.model.slice(slash + 1);
  } else {
    const p = providers[0];
    if (!p || p.models.length === 0) {
      console.error("providers.json 无可用 provider/模型，请先配置或用 --model 指定");
      process.exit(2);
    }
    providerSlug = slugifyProviderName(p.name, []);
    modelId = p.models[0]!.id;
  }
  console.log(`模型: ${providerSlug}/${modelId}   单例超时: ${opts.timeoutSec}s`);

  if (opts.dryRun) {
    for (const [i, c] of cases.entries()) {
      console.log(`[${i + 1}] ${c.category}: ${c.prompt.slice(0, 60)}`);
    }
    return;
  }

  // 准备：prompts / 系统提示词 / 扩展 / stub bridge
  await ensurePromptsConfig(PROMPTS_FILE);
  const segments = (await loadPromptSegments(PROMPTS_FILE)) ?? DEFAULT_PROMPT_SEGMENTS;
  const agentsDir = join(HIAGENT_DIR, "agents");
  const delegateRoster = buildDelegateRoster([], {}, agentsDir);
  const composed = composePrompt(segments, {
    defaultBasePrompt: HIAGENT_DEFAULT_BASE_PROMPT,
    delegateRoster,
    builtinSkillsDir: BUILTIN_SKILLS_DIR,
  });
  const tmpDir = join(HIAGENT_DIR, "tmp", "eval-delegate-trigger");
  await mkdir(tmpDir, { recursive: true });
  const promptFile = join(tmpDir, `sysprompt-${randomUUID()}.md`);
  await writeFile(promptFile, composed, "utf8");

  await ensureProviderExtensionRegistered(store);
  await ensureBridgeExtension();
  const extensionPaths = buildAdditionalExtensionPaths([]);

  const stub = await startStubBridge();
  const bridgeUrl = `http://127.0.0.1:${stub.port}`;

  const results: CaseResult[] = [];
  try {
    for (const [i, c] of cases.entries()) {
      process.stdout.write(`[${i + 1}/${cases.length}] ${c.category}: ${c.prompt.slice(0, 40)}... `);
      const r = await runOneCase(i, c.category, c.prompt, {
        promptFile,
        extensionPaths,
        bridgeUrl,
        bridgeToken: stub.token,
        stubCalls: stub.calls,
        provider: providerSlug,
        modelId,
        timeoutSec: opts.timeoutSec,
      });
      results.push(r);
      const tag = r.calledDelegate
        ? `DELEGATE ✓ (${r.delegateCalls.map((d) => `${d.tool}:${d.agent ?? "?"}`).join(", ")})`
        : r.toolsCalled.length > 0
          ? r.toolsCalled.join(",")
          : "no-tools";
      process.stdout.write(
        `→ ${tag} (${(r.elapsedMs / 1000).toFixed(1)}s)${r.error ? " ERR:" + r.error.slice(0, 50) : ""}\n`,
      );
    }
  } finally {
    stub.server.close();
    await rm(promptFile, { force: true }).catch(() => {});
  }

  // 汇总
  console.log("\n=== SUMMARY ===");
  for (const cat of ["explore", "edit", "simple"] as const) {
    const catResults = results.filter((r) => r.category === cat);
    if (catResults.length === 0) continue;
    const n = catResults.filter((r) => r.calledDelegate).length;
    console.log(`${cat}: ${n}/${catResults.length} 触发 delegate/fleet (${((n / catResults.length) * 100).toFixed(0)}%)`);
  }
  const exploreResults = results.filter((r) => r.category === "explore");
  if (exploreResults.length > 0) {
    const n = exploreResults.filter((r) => r.calledDelegate).length;
    console.log(`\nExplore 触发率（达标线 >=80%）: ${n}/${exploreResults.length} = ${((n / exploreResults.length) * 100).toFixed(0)}%`);
  }
  const simpleResults = results.filter((r) => r.category === "simple");
  if (simpleResults.length > 0) {
    const n = simpleResults.filter((r) => r.calledDelegate).length;
    console.log(`Simple 误派率（应接近 0%）: ${n}/${simpleResults.length} = ${((n / simpleResults.length) * 100).toFixed(0)}%`);
  }
  console.log(`错误用例: ${results.filter((r) => r.error).length}`);
  console.log(`总耗时: ${(results.reduce((s, r) => s + r.elapsedMs, 0) / 1000).toFixed(1)}s`);

  const outPath = opts.out ?? join(HIAGENT_DIR, `eval-delegate-trigger-${Date.now()}.json`);
  await writeFile(
    outPath,
    JSON.stringify({ model: `${providerSlug}/${modelId}`, at: new Date().toISOString(), results }, null, 2),
    "utf8",
  );
  console.log(`结果已写入: ${outPath}`);
}

main().catch((e) => {
  console.error("EVAL FAILED:", e);
  process.exit(1);
});
