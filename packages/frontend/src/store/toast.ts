import { create } from "zustand";

export interface ToastItem {
  id: string;
  message: string;
  /** info 用于中性提示（如预览后目录变化），渲染回退到品牌色 */
  type: "error" | "success" | "info";
}

interface ToastState {
  toasts: ToastItem[];
  add: (message: string, type?: "error" | "success" | "info") => void;
  dismiss: (id: string) => void;
}

let nextId = 0;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  add: (message, type = "error") => {
    const id = `toast-${++nextId}`;
    set(s => ({ toasts: [...s.toasts, { id, message, type }] }));
    // 3 秒后自动消失
    setTimeout(() => {
      set(s => ({ toasts: s.toasts.filter(t => t.id !== id) }));
    }, 3000);
  },
  dismiss: (id) => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })),
}));
