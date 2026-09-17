#!/usr/bin/env bun
// eval-delegate-trigger.ts — delegate/fleet 派发触发率评测
//
// 仿 cocode-master/scripts/eval-task-trigger.mts：用分类提示集实测主 agent
// 在"该派/视情况/不该派"场景下调用 delegate/fleet 的触发率。
//
// 与生产一致的部分（保证测的就是线上行为）：
// - 系统提示词：composePrompt(prompts.json segments, { defaultBasePrompt, delegateRoster, builtinSkillsDir })
// - 工具面：默认排除式（不传 --tools，仅 -xt subagent）+ 全套扩展（web-access/mcp-adapter + provider-extension + wa-pi-bridge）
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
//
// ---- 评测扩充设计（2026-09 定稿）----
// 背景：实测「随便改一个文件也调用了子代理」——小改动被过度委派。本扩充以量化误派为核心。
// 新增类别（原 60 条用例只增不改；类别追加后 --category/--sample 天然支持）：
//   edit-small   小改应自己做（错字/注释/单行文案/单文件局部改动）→ 期望不派，12 条
//   edit-explore 需先探索的编辑（跨文件/需先审计现状）→ 期望派，6 条
//   fleet        串并行派发决策，20 条三类期望（2026-09-18 二期扩充，原 6 条
//                全部为应并行并补 expectTool 标注）：应一次 fleet 并行
//                （expectTool=fleet，10 条）/ 应逐个 delegate（expectTool=delegate，
//                6 条）/ 不该派（no-delegate，4 条）
//   zh-casual    中文口语/模糊表述 → 按语义逐条标注期望，8 条
//   hiagent      特色任务（定时任务/IM 推送/记忆操作）→ 按语义逐条标注期望，10 条
// 期望标注：新增用例直接带 expect: "delegate" | "no-delegate"；原 60 条不改条目，
//   由 expectFor(category) 派生：explore→delegate、simple→no-delegate、edit→无期望
//   （视情况，只报派发率，不进混淆矩阵）。
// 新增指标：
//   1) 混淆矩阵：TP 应派已派 / FP 不应派误派 / TN 不应派未派 / FN 应派漏派；
//      误派率 = FP/(FP+TN)、漏派率 = FN/(FN+TP)，按类别与整体汇报（多轮报 mean±std）
//   2) 首次派发轮次：toolsCalled 序列中首次出现 delegate/fleet 的序号（1 起），
//      仅对已派用例统计，报均值
//   3) 单用例 token 开销：settle 后 getSessionStats().tokens.total（字段缺失降级为 0），
//      报分类均值 + 「已派 vs 未派」均值对比（量化误派的额外成本）
//   4) fleet 选择正确率（二期 2026-09-18）：期望已派用例的工具选择——
//      expectTool=fleet 的用例，调用中出现 fleet 即选对；expectTool=delegate 的用例，
//      调用了 delegate 且全程未用 fleet 才算选对（误用 fleet 单独计数）；
//      合计正确率 = (应 fleet 选中数 + 应顺序选对数) / (应 fleet + 应顺序 总数)

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

// ---- 用例集（原 60 条只增不改；扩充类别见文件头「评测扩充设计」）----
// explore (30)：多步搜索/审计，应触发 delegate/fleet
// edit (10)：小改动，视情况（可能需要先探索）
// simple (20)：单次查找/问答，不应触发
// edit-small (12)：小改应自己做，期望不派
// edit-explore (6)：需先探索的编辑，期望派
// fleet (6)：多独立子任务并行决策，期望派（fleet/delegate 均算派发）
// zh-casual (8)：中文口语/模糊表述，逐条标注期望
// hiagent (10)：特色任务（定时任务/IM 推送/记忆操作），逐条标注期望
type Expectation = "delegate" | "no-delegate";
type Category =
  | "explore"
  | "edit"
  | "simple"
  | "edit-small"
  | "edit-explore"
  | "fleet"
  | "zh-casual"
  | "hiagent";
/** 类别展示顺序（--sample 按此序每类取样；汇总按此序输出） */
const CATEGORY_ORDER: Category[] = [
  "explore",
  "edit",
  "simple",
  "edit-small",
  "edit-explore",
  "fleet",
  "zh-casual",
  "hiagent",
];
interface Case {
  category: Category;
  prompt: string;
  /** 期望派发行为；原 60 条不带此字段，由 expectFor() 按类别派生 */
  expect?: Expectation;
  /** 期望使用的工具（仅 expect="delegate" 时有意义）：fleet=应一次并行派发，delegate=应逐个派发 */
  expectTool?: "fleet" | "delegate";
}
const CASES: Case[] = [
  // --- explore (30) ---
  {
    category: "explore",
    prompt:
      "找出 packages/kernel/src 里所有调用 RpcClient.command 的地方，总结它们分别做什么。",
  },
  {
    category: "explore",
    prompt:
      "审计整个 packages/frontend/src 下 data-testid 的使用，按组件归类列出。",
  },
  {
    category: "explore",
    prompt:
      "agent-manager.ts 的会话生命周期是怎样的？从创建到销毁经过哪些方法，把调用链整理出来。",
  },
  {
    category: "explore",
    prompt: "搜索全仓库，列出所有读取或写入 ~/.wa-pi 下文件的代码位置。",
  },
  {
    category: "explore",
    prompt:
      "packages/kernel 里有哪些地方处理了 pi 子进程异常退出？把每条路径的文件和处理方式找出来。",
  },
  {
    category: "explore",
    prompt:
      "调查 packages/frontend 的 store 目录：每个 store 的职责是什么，它们之间有没有交叉引用？",
  },
  {
    category: "explore",
    prompt: "找出所有引用 SUBAGENT_TYPES 常量的文件，解释每处用它来做什么。",
  },
  {
    category: "explore",
    prompt:
      "bridge-extension.ts 生成的扩展注册了哪些工具？每个工具的 schema 和超时分别是多少，逐条列出。",
  },
  {
    category: "explore",
    prompt:
      "审计 packages/kernel/tests 下哪些测试文件用到了 fake-pi fixture，各自覆盖了什么场景。",
  },
  {
    category: "explore",
    prompt:
      "系统提示词从 prompts.json 到最终注入 pi 进程经过哪些步骤？把相关函数和调用点都找出来。",
  },
  {
    category: "explore",
    prompt: "列出 packages/shared/src 里所有导出的常量，并按用途分类。",
  },
  {
    category: "explore",
    prompt:
      "调查前端 MessageList 组件的渲染分块逻辑：segmentBlocks 怎么工作，有哪些块类型？",
  },
  {
    category: "explore",
    prompt:
      "找出 packages/frontend 里所有发送 WebSocket 消息的调用点，归纳它们各发什么类型的消息。",
  },
  {
    category: "explore",
    prompt:
      "审计 packages/kernel/src/routes 下所有 HTTP 端点，按 方法+路径+handler 列出清单。",
  },
  {
    category: "explore",
    prompt:
      "调查 packages/desktop：它的入口在哪，和 kernel/frontend 是怎么协作的？",
  },
  {
    category: "explore",
    prompt: "找出所有使用 ProviderStore 的代码位置，说明每处读写了什么数据。",
  },
  {
    category: "explore",
    prompt:
      "搜索全仓库对 process.env 的读取，按环境变量名归组，说明每个变量的用途。",
  },
  {
    category: "explore",
    prompt:
      "调查 scripts/ 目录：每个脚本的用途是什么，分别被谁调用（package.json 脚本、启动脚本、CI）？",
  },
  {
    category: "explore",
    prompt: "找出前端所有 localStorage 读写点，列出每个 key 的名称和用途。",
  },
  {
    category: "explore",
    prompt:
      "审计 kernel 里 WebSocket 消息的分发链路：从收到前端消息到业务处理经过哪些模块？",
  },
  {
    category: "explore",
    prompt:
      "调查 patches/ 目录下的补丁：各自改了哪个包的什么行为，为什么需要这些补丁？",
  },
  {
    category: "explore",
    prompt:
      "列出 packages/kernel/tests 下所有测试文件，并给出每个文件主要覆盖的 src 模块对应关系。",
  },
  {
    category: "explore",
    prompt: "搜索全仓库的 TODO 和 FIXME 注释，按包归类统计并列出内容。",
  },
  {
    category: "explore",
    prompt: "调查前端的路由结构：有哪些页面路由，各自对应哪个组件文件？",
  },
  {
    category: "explore",
    prompt:
      "找出所有 spawn/fork 子进程的代码位置，说明各自的进程类型和生命周期管理方式。",
  },
  {
    category: "explore",
    prompt:
      "调查 kernel 的会话持久化机制：消息历史写到哪里、什么格式、由谁触发落盘？",
  },
  {
    category: "explore",
    prompt:
      "找出前端所有 fetch/HTTP 请求调用，归纳它们分别打到 kernel 的哪些端点。",
  },
  {
    category: "explore",
    prompt:
      "搜索全仓库对 projects.json / providers.json / prompts.json 等配置文件的读写点，按文件归类。",
  },
  {
    category: "explore",
    prompt:
      "调查 packages/kernel/src/extensions.ts：扩展路径是怎么收集的，涉及哪些扩展源？",
  },
  {
    category: "explore",
    prompt:
      "找出所有处理子代理遥测（telemetry）的代码，说明数据从产生到落盘的完整链路。",
  },
  // --- edit (10) ---
  {
    category: "edit",
    prompt:
      "给 packages/kernel/src/subagent-telemetry.ts 的文件头注释补充一句落盘位置说明。",
  },
  {
    category: "edit",
    prompt:
      "packages/frontend/src/components/settings/SkillSection.tsx 里搜索框的 placeholder 改成「搜索技能名称...」。",
  },
  {
    category: "edit",
    prompt:
      "把 packages/kernel/src/delegate-tool.ts 里 MAX_SUBAGENT_CONCURRENCY 的注释更新为当前实际语义。",
  },
  {
    category: "edit",
    prompt:
      "给 packages/kernel/src/rpc-client.ts 的 getSessionStats 方法补一段 JSDoc 说明返回结构。",
  },
  {
    category: "edit",
    prompt:
      "CHANGELOG.md 顶部加一条今天的占位条目（类型：其他，内容：评测脚本冒烟）。",
  },
  {
    category: "edit",
    prompt:
      "packages/kernel/src/subagent-runner.ts 中 mapThinking 函数加一个 'minimal' 级别的注释说明。",
  },
  {
    category: "edit",
    prompt:
      "把 packages/kernel/scripts/eval-delegate-trigger.ts 里的每用例默认超时改为 240s（已在 2025-03 从 180s 更新）。",
  },
  {
    category: "edit",
    prompt:
      "给 packages/kernel/src/agent-manager.ts 的 _flushSubagentTelemetry 方法补充边界情况注释（无记录时不落盘）。",
  },
  {
    category: "edit",
    prompt:
      "给 packages/shared/src/constants.ts 的 WA_PI_DIR 常量注释补充一句「可用 WA_PI_DIR 环境变量覆盖」。",
  },
  {
    category: "edit",
    prompt: "scripts/port.ts 文件头加一行注释说明这个脚本的用途。",
  },
  // --- simple (20) ---
  {
    category: "simple",
    prompt:
      "packages/kernel/src/rpc-client.ts 的 buildPiArgs 函数支持哪些参数？念一下。",
  },
  { category: "simple", prompt: "MAX_SUBAGENT_CONCURRENCY 的值是多少？" },
  {
    category: "simple",
    prompt: "读 packages/kernel/package.json，告诉我 test 脚本是什么。",
  },
  { category: "simple", prompt: "PROMPTS_SCHEMA_VERSION 当前是几？" },
  { category: "simple", prompt: "delegate 工具的参数有哪两个？" },
  { category: "simple", prompt: "WA_PI_DIR 默认指向哪个目录？" },
  {
    category: "simple",
    prompt: "subagent-telemetry.ts 里 estimateTokens 的估算比例是多少？",
  },
  {
    category: "simple",
    prompt:
      "packages/shared/src/constants.ts 里 SUBAGENT_TYPES 有哪几个内置类型？",
  },
  { category: "simple", prompt: "fleet 工具的并发上限是多少？" },
  {
    category: "simple",
    prompt:
      "读 packages/kernel/src/system-prompt.ts 前 20 行，告诉我这个文件是做什么的。",
  },
  { category: "simple", prompt: "DEFAULT_AGENT_TOOLS 里包含哪几个工具名？" },
  {
    category: "simple",
    prompt: "packages/kernel/package.json 的 name 字段是什么？",
  },
  { category: "simple", prompt: "resolvePiCliPath 函数定义在哪个文件里？" },
  { category: "simple", prompt: "bunfig.toml 里配置了什么？读一下告诉我。" },
  {
    category: "simple",
    prompt: "tsconfig.base.json 的 compilerOptions.target 是什么？",
  },
  { category: "simple", prompt: "PI_AGENTS_DIR 指向哪个目录？" },
  {
    category: "simple",
    prompt: "packages/frontend/package.json 里有没有 vitest 这个依赖？",
  },
  {
    category: "simple",
    prompt: "SUBAGENT_OVERRIDES_FILE 这个常量定义在哪个文件？",
  },
  { category: "simple", prompt: "start.bat 是干什么的？读一下告诉我。" },
  {
    category: "simple",
    prompt: "eval-delegate-trigger.ts 里 stub server 监听哪个地址和端口？",
  },
  // --- edit-small (12)：小改应自己做，期望不派 ---
  { category: "edit-small", expect: "no-delegate", prompt: "给 packages/shared/src/types.ts 的 DelegationHints 接口加一行注释，说明 whenToDelegate 字段的用途。" },
  { category: "edit-small", expect: "no-delegate", prompt: "把 packages/kernel/src/extensions.ts 文件头注释补一句「扩展路径按优先级排序」。" },
  { category: "edit-small", expect: "no-delegate", prompt: "packages/frontend/src/styles.css 顶部加一行注释「全局变量定义见 :root」。" },
  { category: "edit-small", expect: "no-delegate", prompt: "给 packages/kernel/src/pi-catalog.ts 文件头加一行注释说明这个文件的作用。" },
  { category: "edit-small", expect: "no-delegate", prompt: "把 packages/kernel/tests/helpers/http-api-kit.ts 头部注释里的「工具」改成「工具集」。" },
  { category: "edit-small", expect: "no-delegate", prompt: "packages/desktop/package.json 的 description 字段末尾补一个句号。" },
  { category: "edit-small", expect: "no-delegate", prompt: "给 bunfig.toml 顶部加一行注释「安装相关配置」。" },
  { category: "edit-small", expect: "no-delegate", prompt: "给 packages/frontend/src/i18n/locales/zh.ts 文件头加一行中文注释「中文翻译文件」。" },
  { category: "edit-small", expect: "no-delegate", prompt: "给 packages/kernel/src/wa-pi-bridge.extension.ts 的导出函数加一行 JSDoc「桥接工具入口」。" },
  { category: "edit-small", expect: "no-delegate", prompt: "把 README.md 第一行标题下面补一行空行。" },
  { category: "edit-small", expect: "no-delegate", prompt: "给 packages/kernel/src/delegate-tool.ts 里 makeFleetTool 函数加一行注释「并行派发入口」。" },
  { category: "edit-small", expect: "no-delegate", prompt: "tsconfig.base.json 顶部加一行注释「基础编译配置，各包继承」。" },
  // --- edit-explore (6)：需先探索的编辑，期望派 ---
  { category: "edit-explore", expect: "delegate", prompt: "给 delegate 和 fleet 两个工具的描述补充「何时选 fleet」的段落——先看现有描述结构再改。" },
  { category: "edit-explore", expect: "delegate", prompt: "把前端所有卡片类组件的圆角统一从 8px 改成 12px，先找出所有涉及的文件。" },
  { category: "edit-explore", expect: "delegate", prompt: "给 kernel 新增一个 GET /healthz 端点返回 ok，先了解现有路由注册方式再加。" },
  { category: "edit-explore", expect: "delegate", prompt: "把 simple 类用例里引用的过时常量名全部更新为当前名称——先搜出所有引用点。" },
  { category: "edit-explore", expect: "delegate", prompt: "给 ws-server 的消息分发加一层入参类型校验，先梳理分发链路再动手。" },
  { category: "edit-explore", expect: "delegate", prompt: "统一 kernel 测试里创建临时目录的写法——先审计现有写法再统一修改。" },
  // --- fleet (20)：串并行派发决策，三类期望（二期 2026-09-18 扩充） ---
  // 应一次 fleet 并行（expectTool=fleet，10 条：原 6 + 新 4）——任务相互独立且范围可立刻写全
  { category: "fleet", expect: "delegate", expectTool: "fleet", prompt: "同时调查 packages/kernel、packages/frontend、packages/desktop 三处的错误处理风格，汇总成对比。" },
  { category: "fleet", expect: "delegate", expectTool: "fleet", prompt: "两路并行：A 组审计 packages/kernel/tests 覆盖场景，B 组审计 scripts 目录脚本用途，各出一份清单。" },
  { category: "fleet", expect: "delegate", expectTool: "fleet", prompt: "分别梳理 projects、ask、session 三个 store 的状态结构，汇总成对比表。" },
  { category: "fleet", expect: "delegate", expectTool: "fleet", prompt: "同时整理 Windows 和 macOS 两套打包注意事项，合并成一份文档。" },
  { category: "fleet", expect: "delegate", expectTool: "fleet", prompt: "对 en 和 zh 两份语言文件分别审计缺失的 key，汇总差异。" },
  { category: "fleet", expect: "delegate", expectTool: "fleet", prompt: "对 packages/kernel 和 packages/shared 各做一次 TODO 清点，合并统计。" },
  { category: "fleet", expect: "delegate", expectTool: "fleet", prompt: "同时对 packages/shared 和 packages/kernel 各出一份导出常量清单，汇总成对比。" },
  { category: "fleet", expect: "delegate", expectTool: "fleet", prompt: "三路并行：分别统计 en/zh 语言文件的 key 数、全仓库 TODO 数、测试文件数，汇总成一张表。" },
  { category: "fleet", expect: "delegate", expectTool: "fleet", prompt: "一组调查 patches/ 下每个补丁的用途，另一组调查 scripts/ 下每个脚本的用途，同时进行各出一份清单。" },
  { category: "fleet", expect: "delegate", expectTool: "fleet", prompt: "对 packages/frontend 和 packages/desktop 同时做依赖清点（直接依赖数与最重的三个包），汇总对比。" },
  // 应逐个 delegate（expectTool=delegate，6 条）——后一步依赖前一步结果，或对同一处文件逐步推进
  { category: "fleet", expect: "delegate", expectTool: "delegate", prompt: "先审计 packages/kernel/src/routes 的端点命名风格，然后照这个风格新增一个 GET /version 端点。" },
  { category: "fleet", expect: "delegate", expectTool: "delegate", prompt: "给 delegate-tool.ts 加一个结果聚合的帮助函数，并让 fleet 工具用它——先读懂现有结构再动手。" },
  { category: "fleet", expect: "delegate", expectTool: "delegate", prompt: "统计评测脚本里各 category 的用例数量，然后给数量最少的类别补 2 条用例。" },
  { category: "fleet", expect: "delegate", expectTool: "delegate", prompt: "把 ws-server.ts 的消息分发链路梳理成文档，写到 docs/architecture.md——先梳理再写。" },
  { category: "fleet", expect: "delegate", expectTool: "delegate", prompt: "重构 runWithConcurrency：先读懂实现，加 onProgress 回调，再更新调用点——三步有先后依赖。" },
  { category: "fleet", expect: "delegate", expectTool: "delegate", prompt: "审计 i18n 缺失 key，然后按审计结果补齐 zh 翻译——补什么取决于审计发现了什么。" },
  // 不该派（no-delegate，4 条）——查询/观点类，自己直接答
  { category: "fleet", expect: "no-delegate", prompt: "fleet 的并发上限是多少？" },
  { category: "fleet", expect: "no-delegate", prompt: "把 packages/shared/src/tool-schemas.ts 里 FLEET_MAX_CONCURRENCY 的值念一下。" },
  { category: "fleet", expect: "no-delegate", prompt: "fleet 工具的参数 schema 有哪几个字段？" },
  { category: "fleet", expect: "no-delegate", prompt: "fleet 和 delegate 在本项目里分别什么意思？一句话说说。" },
  // --- zh-casual (8)：中文口语/模糊表述，逐条标注期望 ---
  { category: "zh-casual", expect: "delegate", prompt: "帮我看看咱这项目里 WebSocket 心跳是怎么搞的？" },
  { category: "zh-casual", expect: "no-delegate", prompt: "那个 providers.json 都配了些啥呀？念给我听听。" },
  { category: "zh-casual", expect: "no-delegate", prompt: "随手把 AGENTS.md 里那个错别字改一下。" },
  { category: "zh-casual", expect: "delegate", prompt: "有啥办法能让测试跑快点儿？调研一下给个方案。" },
  { category: "zh-casual", expect: "no-delegate", prompt: "版本号现在是多少？" },
  { category: "zh-casual", expect: "delegate", prompt: "把 e2e 那几个用例为啥 skip 了整理一下说说。" },
  { category: "zh-casual", expect: "no-delegate", prompt: "顺手在 CHANGELOG 里补一条今天的记录。" },
  { category: "zh-casual", expect: "delegate", prompt: "咱们的发版流程是啥样的？从头到尾给我捋一遍。" },
  // --- hiagent (10)：特色任务（定时任务/IM 推送/记忆操作），逐条标注期望 ---
  { category: "hiagent", expect: "no-delegate", prompt: "现在有哪些定时任务？分别什么 cron 表达式？" },
  { category: "hiagent", expect: "delegate", prompt: "梳理定时任务体系：任务怎么注册、调度、落盘，把链路整理出来。" },
  { category: "hiagent", expect: "delegate", prompt: "给 cron-task.ts 加一个 list --json 输出。" },
  { category: "hiagent", expect: "no-delegate", prompt: "IM 推送支持哪些渠道？联系人 id 是什么格式？" },
  { category: "hiagent", expect: "delegate", prompt: "调查记忆系统：写入、检索、分层各在哪个模块，怎么串起来的。" },
  { category: "hiagent", expect: "no-delegate", prompt: "把「用户偏好深色主题」写入记忆。" },
  { category: "hiagent", expect: "no-delegate", prompt: "查一下记忆库里有哪些关于部署的条目。" },
  { category: "hiagent", expect: "no-delegate", prompt: "定时任务的日志在哪、怎么看？" },
  { category: "hiagent", expect: "delegate", prompt: "对比 superpowers 技能链和内置 skills 目录的加载机制差异。" },
  { category: "hiagent", expect: "no-delegate", prompt: "给 eval-memory-write.ts 的用法注释补充 --mem-root 示例。" },
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
  const opts: CliOpts = {
    limit: CASES.length,
    sample: 0,
    categories: null,
    repeat: 1,
    model: null,
    thinking: null,
    dryRun: false,
    out: null,
    timeoutSec: 240,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--limit":
        opts.limit = parseInt(argv[++i]!, 10);
        break;
      case "--sample":
        opts.sample = parseInt(argv[++i]!, 10);
        break;
      case "--category":
        opts.categories = argv[++i]!.split(",").map((s) =>
          s.trim(),
        ) as Category[];
        break;
      case "--repeat":
        opts.repeat = Math.max(1, parseInt(argv[++i]!, 10));
        break;
      case "--model":
        opts.model = argv[++i]!;
        break;
      case "--thinking":
        opts.thinking = argv[++i]!;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--out":
        opts.out = argv[++i]!;
        break;
      case "--timeout":
        opts.timeoutSec = parseInt(argv[++i]!, 10);
        break;
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
    const picked: Case[] = [];
    for (const cat of CATEGORY_ORDER) {
      picked.push(
        ...pool.filter((c) => c.category === cat).slice(0, opts.sample),
      );
    }
    return picked;
  }
  return pool.slice(0, Math.max(0, Math.min(opts.limit, pool.length)));
}

// ---- stub bridge server：记录 delegate/fleet 调用并立即应答，不真跑子代理 ----
interface StubCall {
  tool: string;
  params: unknown;
  at: string;
}

function startStubBridge(): Promise<{
  server: Server;
  port: number;
  token: string;
  calls: StubCall[];
}> {
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
      try {
        msg = JSON.parse(body);
      } catch {
        /* 非法 JSON 按 400 处理 */
      }
      if (!msg || msg.token !== token) {
        res
          .writeHead(403, { "content-type": "application/json" })
          .end(JSON.stringify({ error: "bad_token" }));
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
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ content: [{ type: "text", text }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        server,
        port: typeof addr === "object" && addr ? addr.port : 0,
        token,
        calls,
      });
    });
  });
}

// ---- 单用例执行 ----
interface CaseResult {
  index: number;
  category: Category;
  prompt: string;
  /** 期望派发行为（运行时由 expectFor 填入） */
  expectation?: Expectation;
  /** 期望工具选择（运行时由用例定义填入，仅 delegate 期望用例携带） */
  expectTool?: "fleet" | "delegate";
  calledDelegate: boolean;
  delegateCalls: Array<{ tool: string; agent?: string }>;
  toolsCalled: string[];
  /** 首次派发轮次：toolsCalled 中首个 delegate/fleet 的序号（1 起）；未派为 null */
  firstDelegateRound: number | null;
  /** 单用例 token 开销（getSessionStats().tokens.total，字段缺失降级为 0） */
  tokens: number;
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
    firstDelegateRound: null,
    tokens: 0,
    elapsedMs: 0,
  };
  const sessionId = `eval-${randomUUID()}`;
  const stubMark = ctx.stubCalls.length; // 记录本用例前的 stub 调用数，用例后取增量

  let settled!: () => void;
  const settledPromise = new Promise<void>((resolve) => {
    settled = resolve;
  });
  const onEvent = (e: RpcEvent) => {
    if (
      e.type === "tool_execution_start" &&
      typeof (e as any).toolName === "string"
    ) {
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
        setTimeout(
          () => reject(new Error(`用例超时 (${ctx.timeoutSec}s)`)),
          ctx.timeoutSec * 1000,
        ),
      ),
    ]);
    // settle 后抓取会话统计：token 用量（旧版 pi 无 tokens 字段 → 降级为 0）
    try {
      const st = await client.getSessionStats();
      const t = st?.tokens;
      result.tokens =
        typeof t?.total === "number"
          ? t.total
          : (t?.input ?? 0) + (t?.output ?? 0);
    } catch {
      result.tokens = 0;
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    // 中止当前用例的 pi 会话；abort 失败（如进程已退出）不影响用例失败结果上报
    try {
      await client.abort();
    } catch (abortErr) {
      console.log(
        `用例 #${index} abort 失败（忽略）: ${abortErr instanceof Error ? abortErr.message : String(abortErr)}`,
      );
    }
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
        const agents = Array.isArray(params?.tasks)
          ? params.tasks.map((t: any) => t?.agent).join("+")
          : undefined;
        result.delegateCalls.push({ tool: "fleet", agent: agents });
      }
    }
  }
  // 首次派发轮次：toolsCalled 序列中首个 delegate/fleet 的序号（1 起）
  const firstIdx = result.toolsCalled.findIndex(
    (t) => t === "delegate" || t === "fleet",
  );
  result.firstDelegateRound = firstIdx >= 0 ? firstIdx + 1 : null;
  result.elapsedMs = Date.now() - startedAt;
  return result;
}

/** 用例期望派发：新增用例自带 expect；原 60 条按类别派生（edit 视情况 → 无期望） */
function expectFor(c: Case): Expectation | null {
  if (c.expect) return c.expect;
  if (c.category === "explore") return "delegate";
  if (c.category === "simple") return "no-delegate";
  return null;
}

// ---- main ----
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cases = selectCases(opts);
  console.log(
    `\n=== Delegate 触发率评测：${cases.length}/${CASES.length} 条用例 ===`,
  );

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
      console.error(
        "providers.json 无可用 provider/模型，请先配置或用 --model 指定",
      );
      process.exit(2);
    }
    providerSlug = slugifyProviderName(p.name, []);
    modelId = p.models[0]!.id;
  }
  console.log(
    `模型: ${providerSlug}/${modelId}   thinking: ${opts.thinking ?? "(pi 默认)"}   单例超时: ${opts.timeoutSec}s`,
  );

  if (opts.dryRun) {
    for (const [i, c] of cases.entries()) {
      const exp = expectFor(c);
      const label =
        exp === "delegate" ? "派" : exp === "no-delegate" ? "不派" : "视情况";
      console.log(
        `[${i + 1}] ${c.category}（期望${label}）: ${c.prompt.slice(0, 60)}`,
      );
    }
    return;
  }

  // 准备：prompts / 系统提示词 / 扩展 / stub bridge
  await ensurePromptsConfig(PROMPTS_FILE);
  const segments =
    (await loadPromptSegments(PROMPTS_FILE)) ?? DEFAULT_PROMPT_SEGMENTS;
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
  const extensionPaths = buildAdditionalExtensionPaths();

  const stub = await startStubBridge();
  const bridgeUrl = `http://127.0.0.1:${stub.port}`;

  const runs: CaseResult[][] = [];
  try {
    for (let round = 0; round < opts.repeat; round++) {
      if (opts.repeat > 1)
        console.log(`\n--- 第 ${round + 1}/${opts.repeat} 轮 ---`);
      const results: CaseResult[] = [];
      for (const [i, c] of cases.entries()) {
        process.stdout.write(
          `[${i + 1}/${cases.length}] ${c.category}: ${c.prompt.slice(0, 40)}... `,
        );
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
        r.expectation = expectFor(c);
        r.expectTool = c.expectTool;
        results.push(r);
        const tag = r.calledDelegate
          ? `DELEGATE ✓ (${r.delegateCalls.map((d) => `${d.tool}:${d.agent ?? "?"}`).join(", ")})${r.firstDelegateRound ? ` 首派轮次=${r.firstDelegateRound}` : ""}`
          : r.toolsCalled.length > 0
            ? r.toolsCalled.join(",")
            : "no-tools";
        const tokTag =
          r.tokens > 0 ? `tok=${(r.tokens / 1000).toFixed(1)}k` : "tok=?";
        process.stdout.write(
          `→ ${tag} ${tokTag} (${(r.elapsedMs / 1000).toFixed(1)}s)${r.error ? " ERR:" + r.error.slice(0, 50) : ""}\n`,
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
    const std = Math.sqrt(
      values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length,
    );
    return { mean, std };
  };

  console.log("\n=== SUMMARY ===");
  for (const cat of CATEGORY_ORDER) {
    const perRun = runs
      .map((rs) => rate(rs, cat))
      .filter((x): x is NonNullable<typeof x> => x !== null);
    if (perRun.length === 0) continue;
    if (perRun.length === 1) {
      console.log(
        `${cat}: ${perRun[0]!.n}/${perRun[0]!.total} 触发 delegate/fleet (${perRun[0]!.pct.toFixed(0)}%)`,
      );
    } else {
      const { mean, std } = stats(perRun.map((x) => x.pct));
      const detail = perRun.map((x) => `${x.pct.toFixed(0)}%`).join(" / ");
      console.log(
        `${cat}: mean ${mean.toFixed(1)}% ± ${std.toFixed(1)}  (${perRun.length} 轮: ${detail})`,
      );
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
  const smallRates = runs.map((rs) => rate(rs, "edit-small")?.pct ?? 0);
  if (runs.some((rs) => rate(rs, "edit-small") !== null)) {
    const { mean } = stats(smallRates);
    console.log(
      `小改误派率 edit-small（应接近 0%，核心指标）: mean ${mean.toFixed(1)}%`,
    );
  }
  const allResults = runs.flat();
  console.log(`错误用例: ${allResults.filter((r) => r.error).length}`);
  console.log(
    `总耗时: ${(allResults.reduce((s, r) => s + r.elapsedMs, 0) / 1000).toFixed(1)}s`,
  );

  // ---- 新增指标 1：混淆矩阵（只统计有期望的用例；原 edit 类视情况不参与）----
  const confusionOf = (rs: CaseResult[]) => {
    let tp = 0;
    let fp = 0;
    let tn = 0;
    let fn = 0;
    for (const r of rs) {
      if (r.expectation === "delegate") {
        if (r.calledDelegate) tp++;
        else fn++;
      } else if (r.expectation === "no-delegate") {
        if (r.calledDelegate) fp++;
        else tn++;
      }
    }
    return { tp, fp, tn, fn };
  };
  const pctOf = (num: number, den: number) =>
    den > 0 ? (num / den) * 100 : null;
  console.log("\n--- 混淆矩阵（期望 vs 实际派发） ---");
  for (const cat of CATEGORY_ORDER) {
    const m = confusionOf(allResults.filter((r) => r.category === cat));
    if (m.tp + m.fp + m.tn + m.fn === 0) continue;
    const over = pctOf(m.fp, m.fp + m.tn);
    const miss = pctOf(m.fn, m.fn + m.tp);
    console.log(
      `${cat}: 应派 ${m.tp + m.fn}（派 ${m.tp}/漏 ${m.fn}）  不应派 ${m.fp + m.tn}（误派 ${m.fp}/正确 ${m.tn}）  误派率 ${over === null ? "—" : `${over.toFixed(0)}%`}  漏派率 ${miss === null ? "—" : `${miss.toFixed(0)}%`}`,
    );
  }
  {
    // 整体误派率（多轮时报 mean±std）
    const series = runs
      .map((rs) => {
        const m = confusionOf(
          rs.filter((r) => r.expectation === "no-delegate"),
        );
        return pctOf(m.fp, m.fp + m.tn);
      })
      .filter((x): x is number => x !== null);
    if (series.length > 0) {
      const { mean, std } = stats(series);
      const shown =
        series.length > 1
          ? `mean ${mean.toFixed(1)}% ± ${std.toFixed(1)}`
          : `${series[0]!.toFixed(1)}%`;
      console.log(`整体误派率（不应派用例中误派占比，应接近 0%）: ${shown}`);
    }
  }

  // ---- fleet 选择正确率（期望已派用例的工具选择，口径见文件头「新增指标 4」）----
  const usedFleet = (r: CaseResult) =>
    r.delegateCalls.some((c) => c.tool === "fleet");
  const expectFleetCases = allResults.filter(
    (r) => r.expectation === "delegate" && r.expectTool === "fleet",
  );
  const expectSeqCases = allResults.filter(
    (r) => r.expectation === "delegate" && r.expectTool === "delegate",
  );
  const fleetHit = expectFleetCases.filter(usedFleet).length;
  const seqHit = expectSeqCases.filter(
    (r) => !usedFleet(r) && r.calledDelegate,
  ).length;
  const seqMisusedFleet = expectSeqCases.filter(usedFleet).length;
  if (expectFleetCases.length > 0 || expectSeqCases.length > 0) {
    console.log("\n--- fleet 选择正确率（期望已派用例的工具选择） ---");
    if (expectFleetCases.length > 0) {
      console.log(
        `应 fleet 并行: ${fleetHit}/${expectFleetCases.length} 选中 fleet (${((fleetHit / expectFleetCases.length) * 100).toFixed(0)}%)`,
      );
    }
    if (expectSeqCases.length > 0) {
      console.log(
        `应逐个 delegate: ${seqHit}/${expectSeqCases.length} 顺序派发（误用 fleet ${seqMisusedFleet} 条，${((seqHit / expectSeqCases.length) * 100).toFixed(0)}%）`,
      );
    }
    const choiceTotal = expectFleetCases.length + expectSeqCases.length;
    console.log(
      `fleet 选择正确率合计: ${fleetHit + seqHit}/${choiceTotal} (${(((fleetHit + seqHit) / choiceTotal) * 100).toFixed(0)}%)`,
    );
  }

  // ---- 新增指标 2：首次派发轮次（已派用例中 toolsCalled 的首个 delegate/fleet 序号）----
  const firstRounds = allResults
    .filter((r) => r.calledDelegate && r.firstDelegateRound != null)
    .map((r) => r.firstDelegateRound!);
  if (firstRounds.length > 0) {
    const m = stats(firstRounds);
    console.log(
      `首次派发轮次（已派 ${firstRounds.length} 例）: mean ${m.mean.toFixed(1)} / max ${Math.max(...firstRounds)}`,
    );
  }

  // ---- 新增指标 3：单用例 token 开销（分类均值 + 已派 vs 未派对比）----
  const tokMean = (rs: CaseResult[]) => {
    const vals = rs.filter((r) => r.tokens > 0).map((r) => r.tokens);
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
  };
  {
    const parts: string[] = [];
    for (const cat of CATEGORY_ORDER) {
      const m = tokMean(allResults.filter((r) => r.category === cat));
      if (m !== null) parts.push(`${cat} ${(m / 1000).toFixed(1)}k`);
    }
    if (parts.length > 0) {
      console.log(`单用例 token 均值: ${parts.join("  ")}`);
      const del = tokMean(allResults.filter((r) => r.calledDelegate));
      const notDel = tokMean(allResults.filter((r) => !r.calledDelegate));
      if (del !== null && notDel !== null && notDel > 0) {
        console.log(
          `token 对比（量化误派额外成本）: 已派 ${(del / 1000).toFixed(1)}k vs 未派 ${(notDel / 1000).toFixed(1)}k（${(del / notDel).toFixed(1)}x）`,
        );
      }
    }
  }

  const outPath =
    opts.out ?? join(WA_PI_DIR, `eval-delegate-trigger-${Date.now()}.json`);
  await writeFile(
    outPath,
    JSON.stringify(
      {
        model: `${providerSlug}/${modelId}`,
        thinking: opts.thinking,
        at: new Date().toISOString(),
        repeat: opts.repeat,
        summary: {
          confusion: confusionOf(allResults),
          firstDelegateRoundMean: firstRounds.length
            ? firstRounds.reduce((s, v) => s + v, 0) / firstRounds.length
            : null,
          fleetChoice: {
            expectFleet: expectFleetCases.length,
            fleetHit,
            expectSeq: expectSeqCases.length,
            seqHit,
            seqMisusedFleet,
          },
        },
        runs,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`结果已写入: ${outPath}`);
}

main().catch((e) => {
  console.error("EVAL FAILED:", e);
  process.exit(1);
});
