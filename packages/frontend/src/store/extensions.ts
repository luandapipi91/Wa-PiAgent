// packages/frontend/src/store/extensions.ts
import { create } from "zustand";
import type {
  PackageInfo,
  ExtensionListResult,
  ExtensionChangedEvent,
  ExtensionErrorEvent,
} from "@hiagent/shared";
import { send } from "../ws-instance";

interface ExtensionsState {
  packages: PackageInfo[];
  error: string | null;
  load: () => void;
  setAll: (data: ExtensionListResult | ExtensionChangedEvent) => void;
  setError: (data: ExtensionErrorEvent) => void;
  installPackage: (name: string) => void;
  uninstallPackage: (name: string) => void;
  upgradePackage: (name: string) => void;
  togglePackage: (name: string, enabled: boolean) => void;
}

export const useExtensionsStore = create<ExtensionsState>((set) => ({
  packages: [],
  error: null,

  load: () => send({ type: "extension:list" }),

  setAll: (data) => set({ packages: data.packages, error: null }),

  setError: (data) => set({ error: data.error }),

  installPackage: (name) => {
    set({ error: null });
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
}));
