import { create } from "zustand";

export interface AskItem {
  messageId: string; from: string; to: string; text: string; startedAt: number; resolved: boolean;
}
interface IntercomStore {
  asks: AskItem[];
  addAsk: (a: AskItem) => void;
  resolveAsk: (id: string) => void;
}
export const useIntercom = create<IntercomStore>((set) => ({
  asks: [],
  addAsk: (ask) => set((s) => ({ asks: [...s.asks.filter(a => a.messageId !== ask.messageId), ask] })),
  resolveAsk: (messageId) => set((s) => ({ asks: s.asks.map(a => a.messageId === messageId ? { ...a, resolved: true } : a) })),
}));
