#!/usr/bin/env bun
// eval-delegate-trigger.ts — delegate/fleet 派发触发率评测
//
// 仿 cocode-master/scripts/eval-task-trigger.mts：用分类提示集实测主 agent
// 在"该派/视情况/不该派"场景下调用 delegate/fleet 的触发率。
//
// 与生产一致的部分（保证测的就是线上行为）：
// - 系统提示词：composePrompt(prompts.json segments, { defaultBasePrompt, delegateRoster, builtinSkillsDir })
// - 工具面：默认排除式（不传 --tools，仅 -xt subagent）+ 全套扩展（pi-open-agents/web-access/mcp-adapter + provider-extension + wa-pi-bridge）
//
// 与生产不同的部分（压成本）：
// - bridge 的 /bridge/tool 由本脚本内置 stub server 应答：delegate/fleet 只记录调用并立即
//   返回固定文本，不真 spawn 子代理——每个用例的成本 ≈ 主 agent 一次任务的开销。
//
// 用法：
//   bun run scripts/eval-delegate-trigger.ts [--limit N] [--sample N] [--category a,b] [--repeat N] [--model slug/modelId] [--thinking off|low|medium|high|xhigh] [--dry-run] [--out path] [--timeout sec]
//   --limit N：取前 N 条；--sample N：每类各取前 N 条（冒烟推荐 --sample 1）
//   --category：只跑指定类别（如 --category explore,simple）；--repeat N：整个用例集重复 N 轮，汇总 mean±std
// 默认模型：providers.json 第一个 provider 的第一个模型。
// 配置来源：真实 ~/.wa-pi（只读 providers/prompts；生成的扩展文件与 app 启动时幂等一致）。
// 注意：edit 类用例会让 agent 真实改动 cwd 下的文件。务必在隔离 worktree 中运行
// （git worktree add .worktrees/eval-delegate HEAD && cd 后 bun install），
// 不要在主工作区直接跑——主工作区可能有用户并行开发的未提交代码。

import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  WA_PI_DIR,
  BUILTIN_SKILLS_DIR,
  PROMPTS_FILE,
  slugifyProviderName,
} from "@wa-pi/shared";
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
  WA_PI_DEFAULT_BASE_PROMPT,
} from "../src/system-prompt";
import { buildDelegateRoster } from "../src/delegate-tool";
import { ensureBridgeExtension } from "../src/bridge-extension";
import { ensureProviderExtensionRegistered } from "../src/provider-extension";
import { ProviderStore } from "../src/provider-store";
import { buildAdditionalExtensionPaths } from "../src/extensions";

// ---- 用例集（60 条，针对 WaPi 自身代码库）----
// explore (30)：多步搜索/审计，应触发 delegate/fleet
// edit (10)：小改动，视情况（可能需要先探索）
// simple (20)：单次查找/问答，不应触发
type Category = "explore" | "edit" | "simple";
const CASES: Array<{ category: Category; prompt: string }> = [
  // --- explore (30) ---
  { category: "explore", prompt: "找出 packages/kernel/src 里所有调用 RpcClient.command 的地方，总结它们分别做什么。" },
  { category: "explore", prompt: "审计整个 packages/frontend/src 下 data-testid 的使用，按组件归类列出。" },
  { category: "explore", prompt: "agent-manager.ts 的会话生命周期是怎样的？从创建到销毁经过哪些方法，把调用链整理出来。" },
  { category: "explore", prompt: "搜索全仓库，列出所有读取或写入 ~/.wa-pi 下文件的代码位置。" },
  { category: "explore", prompt: "packages/kernel 里有哪些地方处理了 pi 子进程异常退出？把每条路径的文件和处理方式找出来。" },
  { category: "explore", prompt: "调查 packages/frontend 的 store 目录：每个 store 的职责是什么，它们之间有没有交叉引用？" },
  { category: "explore", prompt: "找出所有引用 SUBAGENT_TYPES 常量的文件，解释每处用它来做什么。" },
  { category: "explore", prompt: "bridge-extension.ts 生成的扩展注册了哪些工具？每个工具的 schema 和超时分别是多少，逐条列出。" },
  { category: "explore", prompt: "审计 packages/kernel/tests 下哪些测试文件用到了 fake-pi fixture，各自覆盖了什么场景。" },
  { category: "explore", prompt: "系统提示词从 prompts.json 到最终注入 pi 进程经过哪些步骤？把相关函数和调用点都找出来。" },
  { category: "explore", prompt: "列出 packages/shared/src 里所有导出的常量，并按用途分类。" },
  { category: "explore", prompt: "调查前端 MessageList 组件的渲染分块逻辑：segmentBlocks 怎么工作，有哪些块类型？" },
  { category: "explore", prompt: "找出 packages/frontend 里所有发送 WebSocket 消息的调用点，归纳它们各发什么类型的消息。" },
  { category: "explore", prompt: "审计 packages/kernel/src/routes 下所有 HTTP 端点，按 方法+路径+handler 列出清单。" },
  { category: "explore", prompt: "调查 packages/desktop：它的入口在哪，和 kernel/frontend 是怎么协作的？" },
  { category: "explore", prompt: "找出所有使用 ProviderStore 的代码位置，说明每处读写了什么数据。" },
  { category: "explore", prompt: "搜索全仓库对 process.env 的读取，按环境变量名归组，说明每个变量的用途。" },
  { category: "explore", prompt: "调查 scripts/ 目录：每个脚本的用途是什么，分别被谁调用（package.json 脚本、启动脚本、CI）？" },
  { category: "explore", prompt: "找出前端所有 localStorage 读写点，列出每个 key 的名称和用途。" },
  { category: "explore", prompt: "审计 kernel 里 WebSocket 消息的分发链路：从收到前端消息到业务处理经过哪些模块？" },
  { category: "explore", prompt: "调查 patches/ 目录下的补丁：各自改了哪个包的什么行为，为什么需要这些补丁？" },
  { category: "explore", prompt: "列出 packages/kernel/tests 下所有测试文件，并给出每个文件主要覆盖的 src 模块对应关系。" },
  { category: "explore", prompt: "搜索全仓库的 TODO 和 FIXME 注释，按包归类统计并列出内容。" },
  { category: "explore", prompt: "调查前端的路由结构：有哪些页面路由，各自对应哪个组件文件？" },
  { category: "explore", prompt: "找出所有 spawn/fork 子进程的代码位置，说明各自的进程类型和生命周期管理方式。" },
  { category: "explore", prompt: "调查 kernel 的会话持久化机制：消息历史写到哪里、什么格式、由谁触发落盘？" },
  { category: "explore", prompt: "找出前端所有 fetch/HTTP 请求调用，归纳它们分别打到 kernel 的哪些端点。" },
  { category: "explore", prompt: "搜索全仓库对 projects.json / providers.json / prompts.json 等配置文件的读写点，按文件归类。" },
  { category: "explore", prompt: "调查 packages/kernel/src/extensions.ts：扩展路径是怎么收集的，涉及哪些扩展源？" },
  { category: "explore", prompt: "找出所有处理子代理遥测（telemetry）的代码，说明数据从产生到落盘的完整链路。" },
  // --- edit (10) ---
  { category: "edit", prompt: "给 packages/kernel/src/subagent-telemetry.ts 的文件头注释补充一句落盘位置说明。" },
  { category: "edit", prompt: "packages/frontend/src/components/settings/SkillSection.tsx 里搜索框的 placeholder 改成「搜索技能名称...」。" },
  { category: "edit", prompt: "把 packages/kernel/src/delegate-tool.ts 里 MAX_SUBAGENT_CONCURRENCY 的注释更新为当前实际语义。" },
  { category: "edit", prompt: "给 packages/kernel/src/rpc-client.ts 的 getSessionStats 方法补一段 JSDoc 说明返回结构。" },
  { category: "edit", prompt: "CHANGELOG.md 顶部加一条今天的占位条目（类型：其他，内容：评测脚本冒烟）。" },
  { category: "edit", prompt: "packages/kernel/src/subagent-runner.ts 中 mapThinking 函数加一个 'minimal' 级别的注释说明。" },
  { category: "edit", prompt: "把 packages/kernel/scripts/eval-delegate-trigger.ts 里的每用例默认超时改为 240s（已在 2025-03 从 180s 更新）。" },
  { category: "edit", prompt: "给 packages/kernel/src/agent-manager.ts 的 _flushSubagentTelemetry 方法补充边界情况注释（无记录时不落盘）。" },
  { category: "edit", prompt: "给 packages/shared/src/constants.ts 的 WA_PI_DIR 常量注释补充一句「可用 WA_PI_DIR 环境变量覆盖」。" },
  { category: "edit", prompt: "scripts/port.ts 文件头加一行注释说明这个脚本的用途。" },
  // --- simple (20) ---
  { category: "simple", prompt: "packages/kernel/src/rpc-client.ts 的 buildPiArgs 函数支持哪些参数？念一下。" },
  { category: "simple", prompt: "MAX_SUBAGENT_CONCURRENCY 的值是多少？" },
  { category: "simple", prompt: "读 packages/kernel/package.json，告诉我 test 脚本是什么。" },
  { category: "simple", prompt: "PROMPTS_SCHEMA_VERSION 当前是几？" },
  { category: "simple", prompt: "delegate 工具的参数有哪两个？" },
  { category: "simple", prompt: "WA_PI_DIR 默认指向哪个目录？" },
  { category: "simple", prompt: "subagent-telemetry.ts 里 estimateTokens 的估算比例是多少？" },
  { category: "simple", prompt: "packages/shared/src/constants.ts 里 SUBAGENT_TYPES 有哪几个内置类型？" },
  { category: "simple", prompt: "fleet 工具的并发上限是多少？" },
  { category: "simple", prompt: "读 packages/kernel/src/system-prompt.ts 前 20 行，告诉我这个文件是做什么的。" },
  { category: "simple", prompt: "DEFAULT_AGENT_TOOLS 里包含哪几个工具名？" },
  { category: "simple", prompt: "packages/kernel/package.json 的 name 字段是什么？" },
  { category: "simple", prompt: "resolvePiCliPath 函数定义在哪个文件里？" },
  { category: "simple", prompt: "bunfig.toml 里配置了什么？读一下告诉我。" },
  { category: "simple", prompt: "tsconfig.base.json 的 compilerOptions.target 是什么？" },
  { category: "simple", prompt: "PI_AGENTS_DIR 指向哪个目录？" },
  { category: "simple", prompt: "packages/frontend/package.json 里有没有 vitest 这个依赖？" },
  { category: "simple", prompt: "SUBAGENT_OVERRIDES_FILE 这个常量定义在哪个文件？" },
  { category: "simple", prompt: "start.bat 是干什么的？读一下告诉我。" },
  { category: "simple", prompt: "eval-delegate-trigger.ts 里 stub server 监听哪个地址和端口？" },
];

// ---- CLI 参数 ----
interface CliOpts {
  limit: number;
  /** 每类各取 N 条（冒烟用，优先于 --limit） */
  sample: number;
  /** 只跑指定类别（逗号分隔，如 --category explore,simple） */
  categories: Category[] | null;
  /** 重复采样次数：整个用例集跑 N 轮，汇总 mean±std（对齐 τ-bench 多轮采样做法） */
  repeat: number;
  model: string | null;
  /** thinking level（off/low/medium/high/xhigh）；null = 不动 pi 默认值 */
  thinking: string | null;
  dryRun: boolean;
  out: string | null;
  timeoutSec: number;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = { limit: CASES.length, sample: 0, categories: null, repeat: 1, model: null, thinking: null, dryRun: false, out: null, timeoutSec: 240 };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--limit": opts.limit = parseInt(argv[++i]!, 10); break;
      case "--sample": opts.sample = parseInt(argv[++i]!, 10); break;
      case "--category": opts.categories = argv[++i]!.split(",").map(s => s.trim()) as Category[]; break;
      case "--repeat": opts.repeat = Math.max(1, parseInt(argv[++i]!, 10)); break;
      case "--model": opts.model = argv[++i]!; break;
      case "--thinking": opts.thinking = argv[++i]!; break;
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

/** 选用例：--category 过滤类别；--sample N = 每类前 N 条；否则前 --limit 条 */
function selectCases(opts: CliOpts): typeof CASES {
  let pool = CASES;
  if (opts.categories && opts.categories.length > 0) {
    pool = pool.filter((c) => opts.categories!.includes(c.category));
  }
  if (opts.sample > 0) {
    const picked: typeof CASES = [];
    for (const cat of ["explore", "edit", "simple"] as const) {
      picked.push(...pool.filter((c) => c.category === cat).slice(0, opts.sample));
    }
    return picked;
  }
  return pool.slice(0, Math.max(0, Math.min(opts.limit, pool.length)));
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
    /** thinking level；null = 不动 pi 默认值 */
    thinking: string | null;
    timeoutSec: number;
    /** 每用例前重新生成扩展文件（抗外部并发清理 .generated） */
    ensureExtensions: () => Promise<void>;
  },
  attempt = 0,
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
      PI_CODING_AGENT_DIR: WA_PI_DIR,
      WA_PI_BRIDGE_URL: ctx.bridgeUrl,
      WA_PI_BRIDGE_TOKEN: ctx.bridgeToken,
      WA_PI_SESSION_ID: sessionId,
    },
    onEvent,
    onExit: () => {},
  });

  try {
    // 每用例前重新确保扩展文件存在：外部进程（如运行中的 WaPi 实例）
    // 可能并发清理 .generated，导致 pi 启动时扩展加载失败
    await ctx.ensureExtensions();
    await client.start();
    await client.setModel(ctx.provider, ctx.modelId);
    if (ctx.thinking) await client.setThinkingLevel(ctx.thinking);
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

  // pi 进程启动即退出（多为 .generated 被外部并发清理）→ 重试一次
  if (result.error?.includes("pi rpc 进程已退出") && attempt < 1) {
    return runOneCase(index, category, prompt, ctx, attempt + 1);
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
  console.log(`模型: ${providerSlug}/${modelId}   thinking: ${opts.thinking ?? "(pi 默认)"}   单例超时: ${opts.timeoutSec}s`);

  if (opts.dryRun) {
    for (const [i, c] of cases.entries()) {
      console.log(`[${i + 1}] ${c.category}: ${c.prompt.slice(0, 60)}`);
    }
    return;
  }

  // 准备：prompts / 系统提示词 / 扩展 / stub bridge
  await ensurePromptsConfig(PROMPTS_FILE);
  const segments = (await loadPromptSegments(PROMPTS_FILE)) ?? DEFAULT_PROMPT_SEGMENTS;
  const agentsDir = join(WA_PI_DIR, "agents");
  const delegateRoster = buildDelegateRoster([], {}, agentsDir);
  const composed = composePrompt(segments, {
    defaultBasePrompt: WA_PI_DEFAULT_BASE_PROMPT,
    delegateRoster,
    builtinSkillsDir: BUILTIN_SKILLS_DIR,
  });
  const tmpDir = join(WA_PI_DIR, "tmp", "eval-delegate-trigger");
  await mkdir(tmpDir, { recursive: true });
  const promptFile = join(tmpDir, `sysprompt-${randomUUID()}.md`);
  await writeFile(promptFile, composed, "utf8");

  await ensureProviderExtensionRegistered(store);
  await ensureBridgeExtension();
  const extensionPaths = buildAdditionalExtensionPaths([]);

  const stub = await startStubBridge();
  const bridgeUrl = `http://127.0.0.1:${stub.port}`;

  const runs: CaseResult[][] = [];
  try {
    for (let round = 0; round < opts.repeat; round++) {
      if (opts.repeat > 1) console.log(`\n--- 第 ${round + 1}/${opts.repeat} 轮 ---`);
      const results: CaseResult[] = [];
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
          thinking: opts.thinking,
          ensureExtensions: async () => {
            await ensureProviderExtensionRegistered(store);
            await ensureBridgeExtension();
          },
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
      runs.push(results);
    }
  } finally {
    stub.server.close();
    await rm(promptFile, { force: true }).catch(() => {});
  }

  // 汇总：单轮报原始计数；多轮报每轮比例 + mean±std（对齐 τ-bench 多轮采样）
  const rate = (rs: CaseResult[], cat: Category) => {
    const catResults = rs.filter((r) => r.category === cat);
    if (catResults.length === 0) return null;
    const n = catResults.filter((r) => r.calledDelegate).length;
    return { n, total: catResults.length, pct: (n / catResults.length) * 100 };
  };
  const stats = (values: number[]) => {
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const std = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
    return { mean, std };
  };

  console.log("\n=== SUMMARY ===");
  for (const cat of ["explore", "edit", "simple"] as const) {
    const perRun = runs.map((rs) => rate(rs, cat)).filter((x): x is NonNullable<typeof x> => x !== null);
    if (perRun.length === 0) continue;
    if (perRun.length === 1) {
      console.log(`${cat}: ${perRun[0]!.n}/${perRun[0]!.total} 触发 delegate/fleet (${perRun[0]!.pct.toFixed(0)}%)`);
    } else {
      const { mean, std } = stats(perRun.map((x) => x.pct));
      const detail = perRun.map((x) => `${x.pct.toFixed(0)}%`).join(" / ");
      console.log(`${cat}: mean ${mean.toFixed(1)}% ± ${std.toFixed(1)}  (${perRun.length} 轮: ${detail})`);
    }
  }
  const exploreRates = runs.map((rs) => rate(rs, "explore")?.pct ?? 0);
  if (exploreRates.some((v) => v > 0)) {
    const { mean } = stats(exploreRates);
    console.log(`\nExplore 触发率（达标线 >=80%）: mean ${mean.toFixed(1)}%`);
  }
  const simpleRates = runs.map((rs) => rate(rs, "simple")?.pct ?? 0);
  if (runs.some((rs) => rate(rs, "simple") !== null)) {
    const { mean } = stats(simpleRates);
    console.log(`Simple 误派率（应接近 0%）: mean ${mean.toFixed(1)}%`);
  }
  const allResults = runs.flat();
  console.log(`错误用例: ${allResults.filter((r) => r.error).length}`);
  console.log(`总耗时: ${(allResults.reduce((s, r) => s + r.elapsedMs, 0) / 1000).toFixed(1)}s`);

  const outPath = opts.out ?? join(WA_PI_DIR, `eval-delegate-trigger-${Date.now()}.json`);
  await writeFile(
    outPath,
    JSON.stringify({ model: `${providerSlug}/${modelId}`, thinking: opts.thinking, at: new Date().toISOString(), repeat: opts.repeat, runs }, null, 2),
    "utf8",
  );
  console.log(`结果已写入: ${outPath}`);
}

main().catch((e) => {
  console.error("EVAL FAILED:", e);
  process.exit(1);
});
