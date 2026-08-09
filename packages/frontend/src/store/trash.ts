import { create } from "zustand";
import type { SessionEntity, ProjectEntity } from "@wa-pi/shared";
import { api } from "../api-client";

interface TrashState {
  sessions: SessionEntity[];
  projects: ProjectEntity[];
  total: number;
  currentPage: number;
  pageSize: number;
  activeProjectId: string | null;
  selectedIds: Set<string>;
  loading: boolean;
  viewerSessionId: string | null;

  loadTrash: () => Promise<void>;
  setPage: (page: number) => void;
  setProjectFilter: (projectId: string | null) => void;
  toggleSelect: (id: string) => void;
  selectAllOnPage: () => void;
  clearSelection: () => void;
  restore: (ids: string[]) => Promise<void>;
  permanentlyDelete: (ids: string[]) => Promise<void>;
  emptyTrash: () => Promise<number>;
  openViewer: (sessionId: string) => void;
  closeViewer: () => void;
}

export const useTrashStore = create<TrashState>((set, get) => ({
  sessions: [],
  projects: [],
  total: 0,
  currentPage: 0,
  pageSize: 100,
  activeProjectId: null,
  selectedIds: new Set(),
  loading: false,
  viewerSessionId: null,

  loadTrash: async () => {
    const { currentPage, pageSize, activeProjectId } = get();
    set({ loading: true });
    try {
      const params = new URLSearchParams();
      if (activeProjectId) params.set("projectId", activeProjectId);
      params.set("offset", String(currentPage * pageSize));
      params.set("limit", String(pageSize));
      const res = (await api.get(`/api/trash/sessions?${params}`)) as {
        sessions: SessionEntity[];
        projects: ProjectEntity[];
        total: number;
      };
      set({
        sessions: res.sessions ?? [],
        projects: res.projects ?? [],
        total: res.total ?? 0,
        loading: false,
      });
    } catch {
      set({ loading: false });
    }
  },

  setPage: (page) => { set({ currentPage: page }); void get().loadTrash(); },
  setProjectFilter: (projectId) => { set({ activeProjectId: projectId, currentPage: 0 }); void get().loadTrash(); },

  toggleSelect: (id) => set((s) => {
    const next = new Set(s.selectedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    return { selectedIds: next };
  }),

  selectAllOnPage: () => set((s) => {
    const allSelected = s.sessions.every(x => s.selectedIds.has(x.id));
    const next = new Set(s.selectedIds);
    if (allSelected) {
      s.sessions.forEach(x => next.delete(x.id));
    } else {
      s.sessions.forEach(x => next.add(x.id));
    }
    return { selectedIds: next };
  }),

  clearSelection: () => set({ selectedIds: new Set() }),

  restore: async (ids) => {
    await api.post("/api/trash/sessions/restore", { sessionIds: ids });
    set((s) => {
      const next = new Set(s.selectedIds);
      ids.forEach(id => next.delete(id));
      return { selectedIds: next };
    });
    await get().loadTrash();
  },

  permanentlyDelete: async (ids) => {
    await api.del("/api/trash/sessions", { sessionIds: ids });
    set((s) => {
      const next = new Set(s.selectedIds);
      ids.forEach(id => next.delete(id));
      return { selectedIds: next };
    });
    await get().loadTrash();
  },

  emptyTrash: async () => {
    const res = (await api.del("/api/trash/sessions")) as { deleted?: number };
    set({ selectedIds: new Set() });
    await get().loadTrash();
    return res.deleted ?? 0;
  },

  openViewer: (sessionId) => set({ viewerSessionId: sessionId }),
  closeViewer: () => set({ viewerSessionId: null }),
}));
