import { create } from "zustand";

export interface ToastItem {
  id: string;
  message: string;
  /** info 用于中性提示（如预览后目录变化），渲染回退到品牌色 */
  type: "error" | "success" | "info";
}

interface ToastState {
  toasts: ToastItem[];
  /**
   * 追加一条 toast，返回 id（可供调用方后续 dismiss）。
   * durationMs = 0 表示不自动消失，只能点击关闭。
   */
  add: (
    message: string,
    type?: "error" | "success" | "info",
    durationMs?: number,
  ) => string;
  dismiss: (id: string) => void;
}

let nextId = 0;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  add: (message, type = "error", durationMs = 3000) => {
    const id = `toast-${++nextId}`;
    set(s => ({ toasts: [...s.toasts, { id, message, type }] }));
    // 3 秒后自动消失
    if (durationMs > 0) {
      setTimeout(() => {
        set(s => ({ toasts: s.toasts.filter(t => t.id !== id) }));
      }, durationMs);
    }
    return id;
  },
  dismiss: (id) => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })),
}));
