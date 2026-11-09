// knowledge_search 工具的宿主侧组装（任务 8）：
// 把 KnowledgeStore / waPiDir / 绑定清单包成 search(query, limit) 闭包，
// bridge-registry 只依赖 KnowledgeToolContext 窄接口（同 memory/tools 的先例：
// 接口定义在业务模块，分发层 import type），不感知 db 生命周期。
// db 惰性打开（首次 search 才建连），打开失败向上抛、由 /bridge/tool 的
// handleBridgeRequest 兜底成 500，不阻断会话创建。
import { Database } from "bun:sqlite";
import { searchKnowledge } from "./search";
import { knowledgeDbPath } from "./paths";
import { KB_SCHEMA_SQL } from "./schema";
import { KnowledgeStore } from "./store";
import type { KbContext } from "./index";

/** knowledge_search 的宿主上下文：bridge-registry opts.knowledgeCtx 的形状 */
export interface KnowledgeToolContext {
  search(query: string, limit: number): Promise<import("./search").KbSearchResult>;
}

/**
 * 组装真实 knowledgeCtx：绑定清单（kbIds）由调用方从 agent config /
 * override 的 knowledgeBaseIds 读出传入。连接与登记库惰性初始化一次。
 */
export function makeKnowledgeToolContext(
  waPiDir: string,
  kbIds: string[],
): KnowledgeToolContext {
  let store: KnowledgeStore | null = null;
  const getStore = (): KnowledgeStore => {
    if (!store) {
      const db = new Database(knowledgeDbPath(waPiDir));
      // WAL 允许读写并发，busy_timeout 防短暂锁竞争直接抛错（与 memory/db.ts、kb-db.ts 同款先例）
      db.run("PRAGMA journal_mode = WAL");
      db.run("PRAGMA busy_timeout = 60000");
      db.exec(KB_SCHEMA_SQL); // 幂等建表（不存在 knowledge.db 时自动创建）
      store = new KnowledgeStore(db, waPiDir);
    }
    return store;
  };
  return {
    async search(query, limit) {
      // search 不消费进度事件，sse 给 noop 满足 KbContext 形状即可
      const ctx: KbContext = { store: getStore(), waPiDir, sse: () => {} };
      return searchKnowledge(ctx, kbIds, query, limit);
    },
  };
}
