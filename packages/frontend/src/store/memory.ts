// store/memory.ts — 记忆与指令文件管理 store
import { create } from "zustand";
import type {
  MemoryEntry,
  ArchivedMemory,
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

/** 服务端检索参数：关键词/作用域/层/是否只看归档 一并下推内核 FTS+BM25 */
export interface MemorySearchParams {
  query: string;
  scope: MemoryScope;
  /** scope=project 时必填（UI 侧 project id，内核解析成项目名）*/
  projectId: string | null;
  kind: MemoryKind | null;
  archivedOnly: boolean;
  limit?: number;
}

interface MemoryState {
  // 数据
  memories: MemoryEntry[];
  archived: ArchivedMemory[];
  instructions: InstructionFile[];
  config: MemoryConfig | null;

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

  // actions
  load: (projectId: string) => void;
  loadInstructions: (projectId: string) => void;
  setMemories: (data: MemoryListResult | MemoryChangedEvent) => void;
  setInstructions: (data: InstructionListResult) => void;
  setConfig: (data: MemoryConfigEvent) => void;
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
  clearSearch: () => void;
}

export const useMemoryStore = create<MemoryState>((set, get) => ({
  memories: [],
  archived: [],
  instructions: [],
  config: null,

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
  setMemories: (data) => {
    set({
      memories: data.memories,
      archived: data.archived,
      loading: false,
    });
    // 检索态下（归档/恢复/彻底删除后列表回推）用同参数重跑，避免结果陈旧
    const { searchResults, searchParams, search } = get();
    if (searchResults !== null && searchParams) search(searchParams);
  },
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
      });
      return;
    }
    // scope=project 但没有项目 id：内核会 400 project.notFound，直接落空结果
    if (params.scope === "project" && !params.projectId) {
      set({ searchResults: [], searchTotalMatched: 0, searching: false, searchParams: params });
      return;
    }
    const qs = new URLSearchParams();
    qs.set("q", params.query);
    qs.set("scope", params.scope);
    if (params.scope === "project" && params.projectId) {
      qs.set("projectId", params.projectId);
    }
    if (params.kind) qs.set("kind", params.kind);
    if (params.archivedOnly) qs.set("archivedOnly", "true");
    qs.set("limit", String(params.limit ?? 50));

    set({ searching: true, searchParams: params });
    api
      .get(`/api/memories/search?${qs.toString()}`)
      .then((data: any) => {
        if (data?.type === "memory:search") {
          set({
            searchResults: data.results ?? [],
            searchTotalMatched: data.totalMatched ?? 0,
            searching: false,
          });
        }
      })
      .catch((err) => {
        console.error("[memory] 检索失败:", err);
        set({ searching: false, searchResults: [], searchTotalMatched: 0 });
      });
  },
  clearSearch: () =>
    set({
      searchResults: null,
      searchTotalMatched: 0,
      searching: false,
      searchParams: null,
    }),
}));
