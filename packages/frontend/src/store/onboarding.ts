import { create } from "zustand";

interface OnboardingState {
	/** 初始化向导是否打开（不持久化：触发逻辑见 App.tsx，无模型供应商时自动弹出） */
	wizardOpen: boolean;
	openWizard: () => void;
	closeWizard: () => void;
}

export const useOnboardingStore = create<OnboardingState>((set) => ({
	wizardOpen: false,
	openWizard: () => set({ wizardOpen: true }),
	closeWizard: () => set({ wizardOpen: false }),
}));
