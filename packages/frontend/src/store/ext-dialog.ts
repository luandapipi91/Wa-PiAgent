import { create } from "zustand";

export interface ExtDialogRequest {
  requestId: string;
  sessionId?: string;
  method: string;            // select | confirm | input | editor
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
}

// pi 扩展 dialog 请求队列：kernel 经 sdk:event(extension_dialog) 推入，
// ExtensionDialog 逐个展示；应答后 resolveCurrent 弹出下一个。
interface ExtDialogState {
  queue: ExtDialogRequest[];
  enqueue: (r: ExtDialogRequest) => void;
  resolveCurrent: () => void;
}

export const useExtDialogStore = create<ExtDialogState>((set) => ({
  queue: [],
  enqueue: (r) => set((s) => ({ queue: [...s.queue, r] })),
  resolveCurrent: () => set((s) => ({ queue: s.queue.slice(1) })),
}));
