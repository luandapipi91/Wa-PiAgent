import { create } from "zustand";

interface SettingsState {
  showSettings: boolean;
  open: () => void;
  close: () => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  showSettings: false,
  open: () => set({ showSettings: true }),
  close: () => set({ showSettings: false }),
}));
