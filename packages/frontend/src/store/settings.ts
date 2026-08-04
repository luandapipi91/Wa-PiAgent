import { create } from "zustand";

export type SettingsSection =
	| "general"
	| "models"
	| "skills"
	| "plugins"
	| "memory"
	| "mcp";

interface SettingsState {
	showSettings: boolean;
	activeSection: SettingsSection;
	open: () => void;
	close: () => void;
	setSection: (s: SettingsSection) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
	showSettings: false,
	activeSection: "general",
	open: () => set({ showSettings: true }),
	close: () => set({ showSettings: false }),
	setSection: (s) => set({ activeSection: s }),
}));
