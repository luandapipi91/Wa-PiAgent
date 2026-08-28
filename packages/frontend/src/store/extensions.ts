// packages/frontend/src/store/extensions.ts
import { create } from "zustand";
import type {
  PackageInfo,
  ExtensionListResult,
  ExtensionChangedEvent,
  ExtensionErrorEvent,
  ExtensionProgressEvent,
  ExtensionInstallDoneEvent,
  ExtensionRepairProgressEvent,
} from "@wa-pi/shared";
import { api } from "../api-client";
import { formatKernelError } from "../util/kernel-error";

/** 安装占位卡状态：installing（进行中，显示进度）| failed（失败，提供重试/移除） */
export type InstallStatus = "installing" | "failed";

/** 进行中 / 失败的安装条目；key 为用户原始输入（与 kernel 回推的 name 一致） */
export interface InstallEntry {
  name: string;       // 用户原始输入（同时作为 key 与展示名）
  status: InstallStatus;
  error?: string;     // failed 时的错误信息
  progress?: string;  // 最新的包管理器日志行
}

/** 升级中标记：name → 最新进度行（键存在即表示该包升级进行中） */
export type UpgradingMap = Record<string, string>;

interface ExtensionsState {
  packages: PackageInfo[];
  installs: Record<string, InstallEntry>;
  upgrading: UpgradingMap;
  uninstalling: Record<string, boolean>;
  repairing: string | null; // 修复中：最新进度行（null = 未在修复）
  error: string | null;
  load: () => void;
  setAll: (data: ExtensionListResult | ExtensionChangedEvent) => void;
  setError: (data: ExtensionErrorEvent) => void;
  applyProgress: (data: ExtensionProgressEvent) => void;
  completeInstall: (data: ExtensionInstallDoneEvent) => void;
  applyRepairProgress: (data: ExtensionRepairProgressEvent) => void;
  completeRepair: () => void;
  repairExtensions: () => void;
  installPackage: (name: string) => void;
  uninstallPackage: (name: string) => void;
  upgradePackage: (name: string) => void;
  togglePackage: (name: string, enabled: boolean) => void;
  retryInstall: (name: string) => void;
  removeInstall: (name: string) => void;
}

export const useExtensionsStore = create<ExtensionsState>((set) => ({
  packages: [],
  installs: {},
  upgrading: {},
  uninstalling: {},
  repairing: null,
  error: null,

  load: () => { api.get("/api/extensions").then((data: any) => { if (data) set({ packages: data.packages ?? [], error: null }); }).catch(() => {}); },

  // extension:changed / extension:list 回复：更新真实列表，保留占位 installs；
  // changed 由 kernel 在操作（含升级/卸载）成功后推送 → 清除 upgrading/uninstalling 标记
  setAll: (data) => set({ packages: data.packages, upgrading: {}, uninstalling: {}, error: null }),

  // extension:error：若对应占位条目存在则标记 failed，否则落到全局 error（卸载/升级失败等）
  setError: (data) =>
    set((s) => {
      // code 化错误：先按字典格式化成当前语言文案再落 state（渲染点保持字符串语义）
      const errorMsg = data.code
        ? formatKernelError({
            code: data.code,
            params: data.params,
            detail: data.detail,
            message: data.error,
          }).main
        : data.error;
      // 修复失败（name=repair）：清 repairing 解除按钮禁用 + 落全局 error。
      // repairing !== null 条件防御：用户真的装了叫 "repair" 的包时不受干扰
      if (data.name === "repair" && s.repairing !== null) {
        return { repairing: null, error: errorMsg };
      }
      const entry = s.installs[data.name];
      if (entry && entry.status === "installing") {
        return {
          installs: { ...s.installs, [data.name]: { ...entry, status: "failed", error: errorMsg } },
        };
      }
      // 升级失败：清除 upgrading 标记 + 落全局 error
      if (s.upgrading[data.name] !== undefined) {
        const nextUp = { ...s.upgrading };
        delete nextUp[data.name];
        return { upgrading: nextUp, error: errorMsg };
      }
      // 卸载失败：清除 uninstalling 标记 + 落全局 error
      if (s.uninstalling[data.name]) {
        const nextUn = { ...s.uninstalling };
        delete nextUn[data.name];
        return { uninstalling: nextUn, error: errorMsg };
      }
      return { error: errorMsg };
    }),

  // extension:progress：升级中更新 upgrading 进度；安装中更新占位条目进度
  applyProgress: (data) =>
    set((s) => {
      if (s.upgrading[data.name] !== undefined) {
        return { upgrading: { ...s.upgrading, [data.name]: data.message } };
      }
      const entry = s.installs[data.name];
      if (!entry) return {};
      return { installs: { ...s.installs, [data.name]: { ...entry, progress: data.message } } };
    }),

  // extension:install:done：清除占位条目（真实卡片由 extension:changed 提供）
  completeInstall: (data) =>
    set((s) => {
      if (!s.installs[data.name]) return {};
      const next = { ...s.installs };
      delete next[data.name];
      return { installs: next };
    }),

  installPackage: (name) => {
    set((s) => ({
      error: null,
      installs: { ...s.installs, [name]: { name, status: "installing" } },
    }));
    void api.post("/api/extensions/install", { name });
  },

  uninstallPackage: (name) => {
    set((s) => ({ error: null, uninstalling: { ...s.uninstalling, [name]: true } }));
    void api.post("/api/extensions/uninstall", { name });
  },

  upgradePackage: (name) => {
    set((s) => ({ error: null, upgrading: { ...s.upgrading, [name]: "" } }));
    void api.post("/api/extensions/upgrade", { name });
  },

  // extension:repair:progress：更新修复进度行
  applyRepairProgress: (data) => set({ repairing: data.message }),

  // extension:repair:done：清除修复态并 toast 成功（错误走全局 error 不经此处）
  completeRepair: () => set({ repairing: null }),

  // 触发修复：fire-and-forget（与 install 同模式，结果经 SSE 事件回流）
  repairExtensions: () => {
    set({ error: null, repairing: "" });
    void api.post("/api/extensions/repair", {});
  },

  togglePackage: (name, enabled) => {
    set({ error: null });
    void api.post("/api/extensions/toggle", { name, enabled });
  },

  // 重试：把 failed 条目重置为 installing 并清错，重新发起安装
  retryInstall: (name) => {
    set((s) => {
      if (!s.installs[name]) return {};
      return { installs: { ...s.installs, [name]: { name, status: "installing" } } };
    });
    void api.post("/api/extensions/install", { name });
  },

  // 移除：从占位列表删除（仅前端态；失败包并未真正写入 settings）
  removeInstall: (name) =>
    set((s) => {
      if (!s.installs[name]) return {};
      const next = { ...s.installs };
      delete next[name];
      return { installs: next };
    }),
}));
