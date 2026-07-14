// packages/frontend/src/store/extensions.ts
import { create } from "zustand";
import type {
  PackageInfo,
  ExtensionListResult,
  ExtensionChangedEvent,
  ExtensionErrorEvent,
  ExtensionProgressEvent,
  ExtensionInstallDoneEvent,
} from "@hiagent/shared";
import { send } from "../ws-instance";

/** 安装占位卡状态：installing（进行中，显示进度）| failed（失败，提供重试/移除） */
export type InstallStatus = "installing" | "failed";

/** 进行中 / 失败的安装条目；key 为用户原始输入（与 kernel 回推的 name 一致） */
export interface InstallEntry {
  name: string;       // 用户原始输入（同时作为 key 与展示名）
  status: InstallStatus;
  error?: string;     // failed 时的错误信息
  progress?: string;  // 最新的包管理器日志行
}

interface ExtensionsState {
  packages: PackageInfo[];
  installs: Record<string, InstallEntry>;
  error: string | null;
  load: () => void;
  setAll: (data: ExtensionListResult | ExtensionChangedEvent) => void;
  setError: (data: ExtensionErrorEvent) => void;
  applyProgress: (data: ExtensionProgressEvent) => void;
  completeInstall: (data: ExtensionInstallDoneEvent) => void;
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
  error: null,

  load: () => send({ type: "extension:list" }),

  // extension:changed / extension:list 回复：更新真实列表，保留占位 installs
  setAll: (data) => set({ packages: data.packages, error: null }),

  // extension:error：若对应占位条目存在则标记 failed，否则落到全局 error（卸载/升级失败等）
  setError: (data) =>
    set((s) => {
      const entry = s.installs[data.name];
      if (entry && entry.status === "installing") {
        return {
          installs: { ...s.installs, [data.name]: { ...entry, status: "failed", error: data.error } },
        };
      }
      return { error: data.error };
    }),

  // extension:progress：更新对应占位条目的最新进度行
  applyProgress: (data) =>
    set((s) => {
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
    send({ type: "extension:install", name });
  },

  uninstallPackage: (name) => {
    set({ error: null });
    send({ type: "extension:uninstall", name });
  },

  upgradePackage: (name) => {
    set({ error: null });
    send({ type: "extension:upgrade", name });
  },

  togglePackage: (name, enabled) => {
    set({ error: null });
    send({ type: "extension:toggle", name, enabled });
  },

  // 重试：把 failed 条目重置为 installing 并清错，重新发起安装
  retryInstall: (name) => {
    set((s) => {
      if (!s.installs[name]) return {};
      return { installs: { ...s.installs, [name]: { name, status: "installing" } } };
    });
    send({ type: "extension:install", name });
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
