// session-history.ts — 从 pi 会话 JSONL 文件直读历史消息（不启动 pi 进程）
//
// 背景：session:messages 旧路径要 ensureStarted 拉起完整 pi rpc 进程才能拿历史，
// 冷启动数秒。pi 会话文件（version 3）是 append-only JSONL 日志，每行一个事件：
//   {"type":"session","version":3,"id":<sessionUuid>,...}        文件头（不进事件树）
//   {"type":"model_change"|"thinking_level_change"|..., id, parentId, timestamp, ...}
//   {"type":"message", id, parentId, timestamp, message: AgentMessage}
// id/parentId 构成事件树（重试/编辑会产生分支）；「当前分支」= 从最新叶子沿 parentId
// 回溯到根（append-only 日志最新操作总在文件末尾）。本模块只取当前分支上
// type==="message" 的条目，返回 message 字段序列——与 RPC get_messages 同语义。
//
// 只读解析，容错：坏行跳过；文件不存在/无任何有效行时抛错，由调用方回退进程路径。

import { readFile } from "node:fs/promises";
import { reconcileDanglingAsks } from "./ask-tool";
import { isTransientErrorMessage } from "./sdk-errors";
import type { AgentMessage } from "@wa-pi/shared";

interface SessionLogEntry {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  message?: unknown;
}

/**
 * 判断一条历史消息是否为「应过滤的 transient 错误消息」。
 * 仅匹配 assistant 角色 + stopReason:error + 网络类 errorMessage 的条目。
 */
function isTransientAssistantError(message: any): boolean {
  if (!message || typeof message !== "object") return false;
  if (message.role !== "assistant" || message.stopReason !== "error") return false;
  return isTransientErrorMessage(message.errorMessage ?? "");
}

/**
 * 解析 pi 会话文件，返回当前分支的历史消息（含 reconcileDanglingAsks 对账）。
 * @param opts.isSessionActive 当 session 仍在活跃运行时跳过 dangling ask 对账
 * @throws 文件不可读或没有任何有效 JSON 行（格式变更/损坏）——调用方应回退进程路径。
 */
export async function readSessionHistory(file: string, opts?: { isSessionActive?: boolean }): Promise<AgentMessage[]> {
  const raw = await readFile(file, "utf8"); // ENOENT 等直接抛 → 回退
  const entries: SessionLogEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e === "object") entries.push(e as SessionLogEntry);
    } catch {
      // 坏行跳过（写入中途截断等）
    }
  }
  if (entries.length === 0) throw new Error(`会话文件无有效行: ${file}`);

  const byId = new Map<string, SessionLogEntry>();
  for (const e of entries) {
    if (typeof e.id === "string" && e.type !== "session") byId.set(e.id, e);
  }

  // 从叶子沿 parentId 回溯，收集当前分支的 message 条目（根→叶顺序）
  const collectFrom = (leaf: SessionLogEntry | undefined): unknown[] => {
    const chain: SessionLogEntry[] = [];
    const visited = new Set<string>();
    let cur = leaf;
    while (cur && typeof cur.id === "string" && !visited.has(cur.id)) {
      visited.add(cur.id);
      chain.push(cur);
      cur = typeof cur.parentId === "string" ? byId.get(cur.parentId) : undefined;
    }
    chain.reverse();
    return chain
      .filter(e => e.type === "message" && e.message != null)
      .map(e => e.message)
      // 过滤 transient error（网络/超时类临时错误）：这类错误是临时性的，
      // 不应作为历史消息残留进对话流（刷新后会重新出现并堆积）。
      // pi 已将其落盘，这里在读出时剔除——仅前端展示层过滤，JSONL 原文不动。
      // fatal error（鉴权/配额）保留，需提示用户改配置。
      .filter((m: any) => !isTransientAssistantError(m));
  };

  // 叶子候选 1：文件末尾向前找第一个事件树节点
  let leaf: SessionLogEntry | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (typeof e.id === "string" && e.type !== "session") { leaf = e; break; }
  }
  let messages = collectFrom(leaf);

  // 极端情况：叶子链上没有 message（如末尾是非消息事件且链断裂），
  // 但文件里确实有 message → 以最后一条 message 为叶子重来
  if (messages.length === 0 && entries.some(e => e.type === "message" && e.message != null)) {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.type === "message" && e.message != null) { leaf = e; break; }
    }
    messages = collectFrom(leaf);
  }

  // 重启兜底：对「无 result 的 ask 调用」注入 cancelled（若 session 活跃则跳过，避免误杀 pending ask）
  // 解析器仅产出有效 message 条目（见上方 filter），这里收窄为 AgentMessage[]。
  return reconcileDanglingAsks(messages, { isSessionActive: opts?.isSessionActive }) as AgentMessage[];
}
