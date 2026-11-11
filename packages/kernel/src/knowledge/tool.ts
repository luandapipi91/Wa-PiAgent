// knowledge_search 工具的宿主侧组装（任务 8）：
// 把 KnowledgeStore / waPiDir / 绑定清单包成 search(query, limit) 闭包，
// bridge-registry 只依赖 KnowledgeToolContext 窄接口（同 memory/tools 的先例：
// 接口定义在业务模块，分发层 import type），不感知 db 生命周期。
//
// 连接所有权：生产路径由 agent-manager 传入共享 store（getKnowledgeStore()，生命周期与
// kernel 一致）——所有会话复用同一登记库连接，会话结束不再泄漏 fd，删库回调也只有一份。
// 未传 store（无 manager 的场景/测试）才退回惰性自建：首次 search 才建连，打开失败向上抛、
// 由 /bridge/tool 的 handleBridgeRequest 兜底成 500，不阻断会话创建。
import { Database } from "bun:sqlite";
import { searchKnowledge } from "./search";
import { knowledgeDbPath } from "./paths";
import { KB_SCHEMA_SQL } from "./schema";
import { KnowledgeStore } from "./store";
import type { KbContext } from "./index";

/** knowledge_search 的宿主上下文：bridge-registry opts.knowledgeCtx 的形状 */
export interface KnowledgeToolContext {
  search(
    query: string,
    limit: number,
    mode?: import("./search/modes").SearchMode,
  ): Promise<import("./search").KbSearchResult>;
}

/** makeKnowledgeToolContext 参数：绑定清单（kbIds）由调用方从 agent config / override 读出 */
export interface KnowledgeToolContextOptions {
  waPiDir: string;
  kbIds: string[];
  /** 共享登记库实例（agent-manager 持有）；缺省时本上下文惰性自建并独占连接 */
  store?: KnowledgeStore;
}

/** 组装真实 knowledgeCtx：注入共享 store 时不打开任何连接，否则惰性自建一次。 */
export function makeKnowledgeToolContext(
  opts: KnowledgeToolContextOptions,
): KnowledgeToolContext {
  const { waPiDir, kbIds } = opts;
  // 仅在未注入共享实例时使用：本上下文自己打开的连接
  let ownStore: KnowledgeStore | null = null;
  const getStore = (): KnowledgeStore => {
    if (opts.store) return opts.store;
    if (!ownStore) {
      const db = new Database(knowledgeDbPath(waPiDir));
      // WAL 允许读写并发，busy_timeout 防短暂锁竞争直接抛错（与 memory/db.ts、kb-db.ts 同款先例）
      db.run("PRAGMA journal_mode = WAL");
      db.run("PRAGMA busy_timeout = 60000");
      db.exec(KB_SCHEMA_SQL); // 幂等建表（不存在 knowledge.db 时自动创建）
      ownStore = new KnowledgeStore(db, waPiDir);
    }
    return ownStore;
  };
  return {
    async search(query, limit, mode) {
      // search 不消费进度事件，sse 给 noop 满足 KbContext 形状即可
      const ctx: KbContext = { store: getStore(), waPiDir, sse: () => {} };
      return searchKnowledge(ctx, kbIds, query, limit, undefined, { mode });
    },
  };
}
