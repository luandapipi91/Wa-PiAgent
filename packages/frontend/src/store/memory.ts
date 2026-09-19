// store/memory.ts — 记忆与指令文件管理 store
import { create } from "zustand";
import type {
  MemoryEntry,
  InstructionFile,
  MemoryConfig,
  MemoryKind,
  MemoryListResult,
  MemoryChangedEvent,
  InstructionListResult,
  MemoryConfigEvent,
  MemorySearchResult,
} from "@wa-pi/shared";
import { api } from "../api-client";

type ActiveTab = "saved" | "archived" | "instructions";
type ScopeFilter = "all" | "global" | "project";
/** 记忆页顶部作用域选择：global 全局记忆，project 当前选中项目记忆 */
type MemoryScope = "global" | "project";

/** 服务端检索参数：关键词/作用域/层/归档/日期窗 一并下推内核 FTS+BM25 */
export interface MemorySearchParams {
  query: string;
  scope: MemoryScope;
  /** scope=project 时必填（UI 侧 project id，内核解析成项目名）*/
  projectId: string | null;
  kind: MemoryKind | null;
  archivedOnly: boolean;
  /** 起始日期（YYYY-MM-DD，含当天）→ since 毫秒；null 表示不限 */
  dateFrom: string | null;
  /** 截止日期（YYYY-MM-DD，含当天）→ until 毫秒；null 表示不限 */
  dateTo: string | null;
  limit?: number;
}

const PAGE_SIZE = 50;

/** 列表分页参数（组件组装下传，store 保存最近一次供 loadMore / 广播重拉复用） */
export interface MemoryPageParams {
  scope: MemoryScope;
  projectId: string | null;
  tab: "active" | "archived";
  kind: MemoryKind | null;
  dateFrom: string | null;
  dateTo: string | null;
}

/** 本地日期（YYYY-MM-DD）→ 毫秒时间戳边界：本地时区，与卡片展示日期所见即所筛 */
export function dateFromToSinceMs(date: string): number {
  return new Date(`${date}T00:00:00`).getTime();
}
export function dateToToUntilMs(date: string): number {
  return new Date(`${date}T23:59:59.999`).getTime();
}

/** 组装 GET /api/memories 分页查询串：limit 恒在下推，可选参数只在有值时出现 */
function buildPageQuery(p: MemoryPageParams, offset: number, limit: number): string {
  const qs = new URLSearchParams();
  qs.set("limit", String(limit));
  qs.set("scope", p.scope);
  qs.set("tab", p.tab);
  if (p.scope === "project" && p.projectId) qs.set("projectId", p.projectId);
  if (p.kind) qs.set("kind", p.kind);
  if (p.dateFrom) qs.set("since", String(dateFromToSinceMs(p.dateFrom)));
  if (p.dateTo) qs.set("until", String(dateToToUntilMs(p.dateTo)));
  if (offset > 0) qs.set("offset", String(offset));
  return qs.toString();
}

/** 组装 GET /api/memories/search 查询串（search 首拉与 searchMore 翻页共用） */
function buildSearchQuery(p: MemorySearchParams, offset: number): string {
  const qs = new URLSearchParams();
  qs.set("q", p.query);
  qs.set("scope", p.scope);
  if (p.scope === "project" && p.projectId) {
    qs.set("projectId", p.projectId);
  }
  if (p.kind) qs.set("kind", p.kind);
  if (p.archivedOnly) qs.set("archivedOnly", "true");
  if (p.dateFrom) qs.set("since", String(dateFromToSinceMs(p.dateFrom)));
  if (p.dateTo) qs.set("until", String(dateToToUntilMs(p.dateTo)));
  qs.set("limit", String(p.limit ?? 50));
  if (offset > 0) qs.set("offset", String(offset));
  return qs.toString();
}

interface MemoryState {
  // 数据
  instructions: InstructionFile[];
  config: MemoryConfig | null;

  // 列表分页状态（替代旧全量 memories/archived 字段）
  /** 当前筛选参数下已加载的条目（第一页 + 已追加的后续页） */
  pageEntries: MemoryEntry[];
  /** 服务端是否还有下一页 */
  pageHasMore: boolean;
  /** active/archived 计数（来自分页响应的 counts） */
  pageCounts: { active: number; archived: number };
  pageLoading: boolean;
  /** loadMore 竞态防重门 */
  loadingMore: boolean;
  /** 日期范围筛选（YYYY-MM-DD，本地时区） */
  dateFrom: string | null;
  dateTo: string | null;
  /** 最近一次 loadPage 的参数（loadMore / 广播重拉复用） */
  lastPageParams: MemoryPageParams | null;

  // UI 状态
  activeTab: ActiveTab;
  scopeFilter: ScopeFilter;
  /** 层级筛选（L1 画像 / L2 知识 / L3 执行）；null 表示不筛 */
  kindFilter: MemoryKind | null;
  /** 记忆作用域：控制列表过滤与手动添加落点 */
  memoryScope: MemoryScope;
  /** 选中查看的项目（记忆作用域 + 指令文件 Tab 共用）。持久化到 store，
   *  关闭设置弹窗后保留，避免重开时与 memoryScope 错位 */
  selectedProjectId: string | null;
  searchQuery: string;
  loading: boolean;

  // 服务端检索状态（searchResults === null 表示未处于检索态）
  searchResults: MemorySearchResult[] | null;
  searchTotalMatched: number;
  searching: boolean;
  searchParams: MemorySearchParams | null;
  /** 服务端是否还有下一页检索结果 */
  searchHasMore: boolean;
  /** searchMore 竞态防重门 */
  searchLoadingMore: boolean;

  // actions
  load: (projectId: string) => void;
  loadInstructions: (projectId: string) => void;
  setMemories: (data: MemoryListResult | MemoryChangedEvent) => void;
  setInstructions: (data: InstructionListResult) => void;
  setConfig: (data: MemoryConfigEvent) => void;
  /** 拉取第一页（params 记入 lastPageParams 供 loadMore / 广播重拉复用） */
  loadPage: (params: MemoryPageParams) => void;
  /** 追加下一页（offset=已加载数，去重合并） */
  loadMore: () => void;
  setDateRange: (from: string | null, to: string | null) => void;
  update: (projectId: string, entryId: string, text: string) => void;
  archive: (projectId: string, entryId: string) => void;
  restore: (projectId: string, entryId: string) => void;
  purge: (projectId: string, entryId: string) => void;
  add: (scope: MemoryScope, text: string, projectId?: string) => void;
  setConfigValue: (opts: Partial<MemoryConfig>) => void;
  setTab: (tab: ActiveTab) => void;
  setScopeFilter: (f: ScopeFilter) => void;
  setKindFilter: (k: MemoryKind | null) => void;
  setMemoryScope: (s: MemoryScope) => void;
  setSelectedProjectId: (id: string | null) => void;
  setSearchQuery: (q: string) => void;
  search: (params: MemorySearchParams) => void;
  /** 追加下一页检索结果（offset=已检索数，去重合并） */
  searchMore: () => void;
  clearSearch: () => void;
}

export const useMemoryStore = create<MemoryState>((set, get) => ({
  instructions: [],
  config: null,

  pageEntries: [],
  pageHasMore: false,
  pageCounts: { active: 0, archived: 0 },
  pageLoading: false,
  loadingMore: false,
  dateFrom: null,
  dateTo: null,
  lastPageParams: null,

  activeTab: "saved",
  scopeFilter: "all",
  kindFilter: null,
  memoryScope: "global",
  selectedProjectId: null,
  searchQuery: "",
  loading: false,
  searchResults: null,
  searchTotalMatched: 0,
  searching: false,
  searchParams: null,
  searchHasMore: false,
  searchLoadingMore: false,

  load: (projectId) => {
    set({ loading: true });
    api
      .get(`/api/memories?projectId=${projectId}`)
      .then((data: any) => {
        if (data) get().setMemories(data);
      })
      .catch((err) => {
        console.error("[memory] 加载记忆列表失败:", err);
        set({ loading: false });
      });
    api
      .get("/api/memories/config")
      .then((data: any) => {
        if (data) get().setConfig(data);
      })
      .catch((err) => {
        console.error("[memory] 加载记忆配置失败:", err);
      });
  },
  loadInstructions: (projectId) => {
    api
      .get(`/api/instructions?projectId=${projectId}`)
      .then((data: any) => {
        if (data) get().setInstructions(data);
      })
      .catch((err) => {
        console.error("[memory] 加载指令文件失败:", err);
      });
  },
  setMemories: (_data) => {
    // kernel 广播 memory:changed（写操作回推）降级为变更信号：重拉第一页（滚动重置可接受——
    // 写操作后该条 updated_at 变化，重置后「最近修改」正好排最前）；检索态同参数重跑。
    const { lastPageParams, loadPage, searchResults, searchParams, search } = get();
    if (lastPageParams) loadPage({ ...lastPageParams });
    if (searchResults !== null && searchParams) search(searchParams);
  },

  loadPage: (params) => {
    set({ pageLoading: true, lastPageParams: params });
    api
      .get(`/api/memories?${buildPageQuery(params, 0, PAGE_SIZE)}`)
      .then((data: any) => {
        if (data?.type === "memory:list:page") {
          set({
            pageEntries: data.entries ?? [],
            pageHasMore: !!data.hasMore,
            pageCounts: data.counts ?? { active: 0, archived: 0 },
            pageLoading: false,
          });
        } else set({ pageLoading: false });
      })
      .catch((err) => {
        console.error("[memory] 分页加载失败:", err);
        set({ pageLoading: false });
      });
  },

  loadMore: () => {
    const { lastPageParams, pageEntries, loadingMore, pageHasMore } = get();
    if (!lastPageParams || loadingMore || !pageHasMore) return;
    set({ loadingMore: true });
    api
      .get(`/api/memories?${buildPageQuery(lastPageParams, pageEntries.length, PAGE_SIZE)}`)
      .then((data: any) => {
        if (data?.type === "memory:list:page") {
          const got = data.entries ?? [];
          // 去重合并（广播重拉与 loadMore 竞态时防重复）
          const seen = new Set(pageEntries.map((e) => e.id));
          set({
            pageEntries: [
              ...pageEntries,
              ...got.filter((e: MemoryEntry) => !seen.has(e.id)),
            ],
            pageHasMore: !!data.hasMore,
            loadingMore: false,
          });
        } else set({ loadingMore: false });
      })
      .catch((err) => {
        console.error("[memory] 加载更多失败:", err);
        set({ loadingMore: false });
      });
  },

  setDateRange: (from, to) => set({ dateFrom: from, dateTo: to }),
  setInstructions: (data) => set({ instructions: data.instructions }),
  setConfig: (data) => set({ config: data.config }),
  update: (projectId, entryId, text) => {
    void api.post("/api/memories/update", { projectId, entryId, text });
  },
  archive: (projectId, entryId) => {
    void api.post("/api/memories/archive", { projectId, entryId });
  },
  restore: (projectId, entryId) => {
    void api.post("/api/memories/restore", { projectId, entryId });
  },
  purge: (projectId, entryId) => {
    void api.del(
      `/api/memories/${encodeURIComponent(entryId)}?projectId=${projectId}`,
    );
  },
  add: (scope, text, projectId) => {
    void api.post("/api/memories", { scope, text, projectId });
  },
  setConfigValue: (opts) => {
    void api.put("/api/memories/config", opts);
  },
  setTab: (tab) => set({ activeTab: tab }),
  setScopeFilter: (f) => set({ scopeFilter: f }),
  setKindFilter: (k) => set({ kindFilter: k }),
  setMemoryScope: (s) => set({ memoryScope: s }),
  setSelectedProjectId: (id) => set({ selectedProjectId: id }),
  setSearchQuery: (q) => set({ searchQuery: q }),
  search: (params) => {
    if (!params.query.trim()) {
      set({
        searchResults: null,
        searchTotalMatched: 0,
        searching: false,
        searchParams: null,
        searchHasMore: false,
        searchLoadingMore: false,
      });
      return;
    }
    // scope=project 但没有项目 id：内核会 400 project.notFound，直接落空结果
    if (params.scope === "project" && !params.projectId) {
      set({
        searchResults: [],
        searchTotalMatched: 0,
        searching: false,
        searchParams: params,
        searchHasMore: false,
        searchLoadingMore: false,
      });
      return;
    }

    set({ searching: true, searchParams: params });
    api
      .get(`/api/memories/search?${buildSearchQuery(params, 0)}`)
      .then((data: any) => {
        if (data?.type === "memory:search") {
          set({
            searchResults: data.results ?? [],
            searchTotalMatched: data.totalMatched ?? 0,
            searchHasMore: !!data.hasMore,
            searching: false,
          });
        }
      })
      .catch((err) => {
        console.error("[memory] 检索失败:", err);
        set({
          searching: false,
          searchResults: [],
          searchTotalMatched: 0,
          searchHasMore: false,
        });
      });
  },

  searchMore: () => {
    const { searchParams, searchResults, searchLoadingMore, searchHasMore } = get();
    if (!searchParams || !searchResults || searchLoadingMore || !searchHasMore) return;
    set({ searchLoadingMore: true });
    api
      .get(`/api/memories/search?${buildSearchQuery(searchParams, searchResults.length)}`)
      .then((data: any) => {
        if (data?.type === "memory:search") {
          const got = data.results ?? [];
          // 去重合并，与 loadMore 同型。
          // 注意：内核 FTS 候选池硬上限 50，want 超过后服务端 hasMore 恒 false 且返回空页，
          // 此处不特判（多发一次空请求无害）。
          const seen = new Set(searchResults.map((r) => r.id));
          set({
            searchResults: [
              ...searchResults,
              ...got.filter((r: MemorySearchResult) => !seen.has(r.id)),
            ],
            searchHasMore: !!data.hasMore,
            searchLoadingMore: false,
          });
        } else set({ searchLoadingMore: false });
      })
      .catch((err) => {
        console.error("[memory] 加载更多检索结果失败:", err);
        set({ searchLoadingMore: false });
      });
  },

  clearSearch: () =>
    set({
      searchResults: null,
      searchTotalMatched: 0,
      searching: false,
      searchParams: null,
      searchHasMore: false,
      searchLoadingMore: false,
    }),
}));
