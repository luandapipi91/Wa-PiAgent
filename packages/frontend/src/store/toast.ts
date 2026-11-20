import { create } from "zustand";

export interface ToastItem {
  id: string;
  message: string;
  /** info 用于中性提示（如预览后目录变化），渲染回退到品牌色 */
  type: "error" | "success" | "info";
  /**
   * 同类标记（如代理告警固定 "proxy-status"）：调用方按 tag 在 store 里查找
   * 自己创建的常驻 toast，不依赖易失的模块级变量（dev HMR 后变量会归 null
   * 而 store 里的 toast 还挂着，导致收不掉/叠加）。
   */
  tag?: string;
}

interface ToastState {
  toasts: ToastItem[];
  /**
   * 追加一条 toast，返回 id（可供调用方后续 dismiss，如代理恢复时收掉告警）。
   * durationMs = 0 表示不自动消失，只能点击关闭。
   * tag 可选：同类标记，供调用方按 tag 查找（见 ToastItem.tag）。
   */
  add: (
    message: string,
    type?: "error" | "success" | "info",
    durationMs?: number,
    tag?: string,
  ) => string;
  /** 原地更新文案（不销毁重建，不重放入场动画） */
  update: (id: string, message: string) => void;
  /** 按 tag 收掉所有匹配的 toast（兜底：tag 唯一性靠调用纪律维持，可能残留多条） */
  dismissByTag: (tag: string) => void;
  dismiss: (id: string) => void;
}

let nextId = 0;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  add: (message, type = "error", durationMs = 3000, tag) => {
    const id = `toast-${++nextId}`;
    set(s => ({ toasts: [...s.toasts, { id, message, type, ...(tag ? { tag } : {}) }] }));
    // 3 秒后自动消失
    if (durationMs > 0) {
      setTimeout(() => {
        set(s => ({ toasts: s.toasts.filter(t => t.id !== id) }));
      }, durationMs);
    }
    return id;
  },
  update: (id, message) =>
    set(s => ({
      toasts: s.toasts.map(t => (t.id === id ? { ...t, message } : t)),
    })),
  dismissByTag: (tag) =>
    set(s => ({ toasts: s.toasts.filter(t => t.tag !== tag) })),
  dismiss: (id) => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })),
}));
