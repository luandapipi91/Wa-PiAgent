import { create } from "zustand";

export interface ExtDialogRequest {
  requestId: string;
  sessionId?: string;
  method: string; // select | confirm | input | editor
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
}

// pi 扩展 dialog 请求队列：kernel 经 sdk:event(extension_dialog) 推入（带 sessionId），
// ExtensionDialog（挂在 SessionView 内）按会话过滤后逐个展示；应答后按 requestId 出队。
interface ExtDialogState {
  queue: ExtDialogRequest[];
  enqueue: (r: ExtDialogRequest) => void;
  // 按 requestId 出队：各会话各自展示自己的 dialog，被应答的未必是全局队首，
  // 不能再用 slice(1)（会误删其它会话的 pending 请求）
  resolveById: (requestId: string) => void;
}

export const useExtDialogStore = create<ExtDialogState>((set) => ({
  queue: [],
  enqueue: (r) => set((s) => ({ queue: [...s.queue, r] })),
  resolveById: (requestId) =>
    set((s) => ({
      queue: s.queue.filter((d) => d.requestId !== requestId),
    })),
}));
