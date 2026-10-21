import { create } from "zustand";
import { persist } from "zustand/middleware";

/** 左侧会话列表侧栏宽度（可拖拽调整，持久化到 localStorage） */
interface SidebarState {
  /** 侧栏宽度（px），默认 264 */
  width: number;
  setWidth: (w: number) => void;
}

const STORAGE_KEY = "wa-pi-sidebar";

export const useSidebarStore = create<SidebarState>()(
  persist(
    (set) => ({
      width: 264,
      setWidth: (w) => set({ width: w }),
    }),
    { name: STORAGE_KEY },
  ),
);
