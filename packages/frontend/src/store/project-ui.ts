import { create } from "zustand";
import { persist } from "zustand/middleware";

interface ProjectUiState {
  collapsedProjectIds: string[];
  isExpanded: (projectId: string) => boolean;
  toggleProject: (projectId: string) => void;
  setExpanded: (projectId: string, expanded: boolean) => void;
}

const STORAGE_KEY = "wa-pi-project-ui";

export const useProjectUiStore = create<ProjectUiState>()(
  persist(
    (set, get) => ({
      collapsedProjectIds: [],
      isExpanded: (projectId) => !get().collapsedProjectIds.includes(projectId),
      toggleProject: (projectId) => set((state) => {
        const collapsed = state.collapsedProjectIds;
        const next = collapsed.includes(projectId)
          ? collapsed.filter((id) => id !== projectId)
          : [...collapsed, projectId];
        return { collapsedProjectIds: next };
      }),
      setExpanded: (projectId, expanded) => set((state) => {
        const collapsed = state.collapsedProjectIds;
        const contains = collapsed.includes(projectId);
        if (expanded && contains) {
          return { collapsedProjectIds: collapsed.filter((id) => id !== projectId) };
        }
        if (!expanded && !contains) {
          return { collapsedProjectIds: [...collapsed, projectId] };
        }
        return state;
      }),
    }),
    { name: STORAGE_KEY }
  )
);
