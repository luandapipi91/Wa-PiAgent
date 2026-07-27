// amaster-memory.ts — 对 @amaster.ai/pi-memory 的 host-controlled 包装
//
// 目标：让 kernel 自己决定全局/项目记忆的存储目录，而不是依赖 Pi 扩展加载时的 cwd。
// 所有读写经此层委托给 amaster MemoryStore，确保 § 分隔格式由 amaster 单一维护，
// 避免外部裸写文件触发 amaster 的 drift 检测。
//
// 作用域目录约定：
// - 全局：<hiagentDir>/memories/global/{MEMORY.md,USER.md}
// - 项目：<hiagentDir>/projects-memory/<cwd-basename>/{MEMORY.md,USER.md}
//
// amaster 的 MemoryStore 仅区分 memory(MEMORY.md) 与 user(USER.md) 两个 target；
// failure 等其它分类不在此层管理。

import { MemoryStore } from "@amaster.ai/pi-memory";
export type { MemoryTarget } from "@amaster.ai/pi-memory";
/** 透传 amaster 的 createMemoryTools（绑定 raw store 生成 agent 可用的记忆 tool 集） */
export { createMemoryTools } from "@amaster.ai/pi-memory";
import type { MemoryTarget } from "@amaster.ai/pi-memory";
import {
  MEM_ADD_DESC,
  MEM_ADD_SNIPPET,
  MEM_REPLACE_DESC,
  MEM_REPLACE_SNIPPET,
  MEM_REMOVE_DESC,
  MEM_REMOVE_SNIPPET,
  MEM_READ_DESC,
  MEM_READ_SNIPPET,
  MEM_TARGET_DESC,
  MEM_SCOPE_DESC,
  MemoryTargetSchema,
  MemoryScopeSchema,
} from "@hiagent/shared";
import { Type } from "typebox";
import { join } from "node:path";

/** pi ToolDefinition 的最小结构类型（RPC 迁移后不再从 SDK import 类型，按结构对齐即可） */
export interface ToolDefinition {
  name: string;
  label?: string;
  description: string;
  parameters: unknown;
  promptGuidelines?: string[];
  execute: (toolCallId: string, params: any, signal?: AbortSignal) => Promise<unknown>;
}

/** 单个作用域（全局或某项目）的记忆读写门面 */
export interface AmasterStore {
  /** 该 store 落盘的绝对目录 */
  readonly dir: string;
  /** 底层 amaster MemoryStore（供 createMemoryTools 等需要原始实例的场合） */
  readonly raw: MemoryStore;
  /** 追加一条记忆（空串或命中 promptware 扫描会被拒绝并抛错） */
  add(target: MemoryTarget, content: string): Promise<void>;
  /** 按 oldText 精确匹配替换；返回是否命中 */
  replace(target: MemoryTarget, oldText: string, newContent: string): Promise<boolean>;
  /** 按 oldText 精确匹配删除；返回是否命中 */
  remove(target: MemoryTarget, oldText: string): Promise<boolean>;
  /** 读取 live 条目原文（同步 getEntries 前需 loadFromDisk，本方法已封装） */
  entries(target: MemoryTarget): Promise<string[]>;
  /** 读取冻结的系统提示词快照（已做 promptware 清洗，注入提示词用） */
  snapshot(target: MemoryTarget): Promise<string>;
  /** memory + user 合并快照（一次 loadFromDisk），无内容返回空串 */
  snapshotAll(): Promise<string>;
}

/** 全局记忆 store：<hiagentDir>/memories/global */
export function getGlobalMemoryStore(hiagentDir: string): AmasterStore {
  return createAmasterStore(join(hiagentDir, "memories", "global"));
}

/** 项目记忆 store：<hiagentDir>/projects-memory/<cwd basename> */
export function getProjectMemoryStore(hiagentDir: string, cwd: string): AmasterStore {
  return createAmasterStore(join(hiagentDir, "projects-memory", projectNameFromCwd(cwd)));
}

/** 按任意目录构造 store：用于从 entry id / 归档 sourceFile 反推 store（见 memory-store.ts） */
export function createAmasterStore(dir: string): AmasterStore {
  return createStore(dir);
}

/**
 * 构造 agent 记忆工具，含可选 `scope` 参数由 agent 决定写入全局还是项目。
 *
 * - target：memory（笔记 MEMORY.md）/ user（用户画像 USER.md）
 * - scope：可选 global / project。**默认值**——target=user → global，target=memory → project。
 *   agent 可显式传 scope 覆盖（如把某条工作笔记显式存到全局）。
 *
 * 自定义 TypeBox schema + execute，按 (target, scope) 路由到对应 amaster store。
 * 全局+项目记忆快照另由 AgentManager 注入系统提示词（只读上下文）。
 */
export function createAgentMemoryTools(
  globalStore: AmasterStore,
  projectStore: AmasterStore,
): ToolDefinition[] {
  const targetSchema = MemoryTargetSchema;
  const scopeSchema = MemoryScopeSchema;

  const resolveScope = (target: MemoryTarget, scope: unknown): "global" | "project" =>
    scope === "global" || scope === "project" ? scope : target === "user" ? "global" : "project";
  const storeFor = (target: MemoryTarget, scope: unknown): MemoryStore =>
    resolveScope(target, scope) === "global" ? globalStore.raw : projectStore.raw;
  const jsonResult = (v: unknown) => ({
    content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }],
    details: undefined,
  });
  const str = (v: unknown): string => (typeof v === "string" ? v : "");

  return [
    {
      name: "memory_add",
      label: "Memory",
      description: MEM_ADD_DESC,
      promptSnippet: MEM_ADD_SNIPPET,
      parameters: Type.Object({
        target: targetSchema,
        scope: Type.Optional(scopeSchema),
        content: Type.String({ description: "The entry content to append." }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const t = str(params.target) === "user" ? "user" : "memory";
        return jsonResult(await storeFor(t, params.scope).add(t, str(params.content)));
      },
    },
    {
      name: "memory_replace",
      label: "Memory",
      description: MEM_REPLACE_DESC,
      promptSnippet: MEM_REPLACE_SNIPPET,
      parameters: Type.Object({
        target: targetSchema,
        scope: Type.Optional(scopeSchema),
        oldText: Type.String({ description: "A short substring uniquely identifying the entry to replace." }),
        newContent: Type.String({ description: "The replacement entry content." }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const t = str(params.target) === "user" ? "user" : "memory";
        return jsonResult(await storeFor(t, params.scope).replace(t, str(params.oldText), str(params.newContent)));
      },
    },
    {
      name: "memory_remove",
      label: "Memory",
      description: MEM_REMOVE_DESC,
      promptSnippet: MEM_REMOVE_SNIPPET,
      parameters: Type.Object({
        target: targetSchema,
        scope: Type.Optional(scopeSchema),
        oldText: Type.String({ description: "A short substring uniquely identifying the entry to remove." }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const t = str(params.target) === "user" ? "user" : "memory";
        return jsonResult(await storeFor(t, params.scope).remove(t, str(params.oldText)));
      },
    },
    {
      name: "memory_read",
      label: "Memory",
      description: MEM_READ_DESC,
      promptSnippet: MEM_READ_SNIPPET,
      parameters: Type.Object({
        target: targetSchema,
        scope: Type.Optional(scopeSchema),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const t = str(params.target) === "user" ? "user" : "memory";
        return jsonResult(await storeFor(t, params.scope).read(t));
      },
    },
  ] as unknown as ToolDefinition[];
}

/** 按 cwd 生成项目目录名（basename；与历史 projects-memory/<basename> 约定对齐）。
 *  净化 Windows 非法文件名字符（如盘根 cwd `H:` 的冒号），避免 mkdir 失败。 */
export function projectNameFromCwd(cwd: string): string {
  const parts = cwd.replace(/\\/g, "/").replace(/\/$/, "").split("/");
  const raw = (parts[parts.length - 1] || "default")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "") // 去非法字符（含盘符冒号）
    .trim();
  return raw || "default";
}

function createStore(dir: string): AmasterStore {
  // MemoryStore 自身保证 add/replace/remove 经 withFileLock + drift 校验后落盘，
  // 无需调用方先 loadFromDisk；但同步的 getEntries / formatForSystemPrompt 需先 load。
  const store = new MemoryStore({ dir });

  return {
    dir,
    raw: store,
    async add(target, content) {
      assertOk(await store.add(target, content), "记忆写入失败");
    },
    async replace(target, oldText, newContent) {
      const r = await store.replace(target, oldText, newContent);
      return r.success;
    },
    async remove(target, oldText) {
      const r = await store.remove(target, oldText);
      return r.success;
    },
    async entries(target) {
      await store.loadFromDisk();
      return store.getEntries(target);
    },
    async snapshot(target) {
      await store.loadFromDisk();
      return store.formatForSystemPrompt(target);
    },
    async snapshotAll() {
      await store.loadFromDisk();
      return store.formatAllForSystemPrompt();
    },
  };
}

/** amaster 的失败结果（含 drift / 超限 / 未命中外的错误）统一转抛 */
function assertOk(r: { success: boolean; error?: string }, fallback: string): void {
  if (!r.success) {
    throw new Error(r.error ?? fallback);
  }
}
