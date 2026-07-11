// store/memory.ts — 记忆与指令文件管理 store
import { create } from "zustand";
import type {
  MemoryEntry, ArchivedMemory, InstructionFile, MemoryConfig,
  MemoryListResult, MemoryChangedEvent, InstructionListResult, MemoryConfigEvent,
} from "@hiagent/shared";
import { send } from "../ws-instance";

type ActiveTab = "saved" | "archived" | "instructions";
type CategoryFilter = "all" | "memory" | "user" | "failure";
type ScopeFilter = "all" | "global" | "project";

interface MemoryState {
  // 数据
  memories: MemoryEntry[];
  archived: ArchivedMemory[];
  instructions: InstructionFile[];
  config: MemoryConfig | null;

  // UI 状态
  activeTab: ActiveTab;
  categoryFilter: CategoryFilter;
  scopeFilter: ScopeFilter;
  searchQuery: string;
  loading: boolean;

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
  setConfigValue: (opts: Partial<MemoryConfig>) => void;
  setTab: (tab: ActiveTab) => void;
  setCategoryFilter: (f: CategoryFilter) => void;
  setScopeFilter: (f: ScopeFilter) => void;
  setSearchQuery: (q: string) => void;
}

export const useMemoryStore = create<MemoryState>((set) => ({
  memories: [],
  archived: [],
  instructions: [],
  config: null,

  activeTab: "saved",
  categoryFilter: "all",
  scopeFilter: "all",
  searchQuery: "",
  loading: false,

  load: (projectId) => {
    set({ loading: true });
    send({ type: "memory:list", projectId });
    send({ type: "memory:config:get" });
  },
  loadInstructions: (projectId) => send({ type: "instruction:list", projectId }),
  setMemories: (data) => set({
    memories: data.memories,
    archived: data.archived,
    loading: false,
  }),
  setInstructions: (data) => set({ instructions: data.instructions }),
  setConfig: (data) => set({ config: data.config }),
  update: (projectId, entryId, text) => send({ type: "memory:update", projectId, entryId, text }),
  archive: (projectId, entryId) => send({ type: "memory:archive", projectId, entryId }),
  restore: (projectId, entryId) => send({ type: "memory:restore", projectId, entryId }),
  purge: (projectId, entryId) => send({ type: "memory:purge", projectId, entryId }),
  setConfigValue: (opts) => send({ type: "memory:config:set", ...opts }),
  setTab: (tab) => set({ activeTab: tab }),
  setCategoryFilter: (f) => set({ categoryFilter: f }),
  setScopeFilter: (f) => set({ scopeFilter: f }),
  setSearchQuery: (q) => set({ searchQuery: q }),
}));
