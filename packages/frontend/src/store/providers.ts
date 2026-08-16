import { create } from "zustand";
import type { ModelProvider, ProviderApi, ProviderModel } from "@wa-pi/shared";
import { api } from "../api-client";

interface TestInput {
  baseUrl: string;
  apiKey: string;
  api: ProviderApi;
  models: ProviderModel[];
  slug?: string;
}

interface ProvidersState {
  providers: ModelProvider[];
  loading: boolean;
  /** 首次 load() 返回合法 providers 数组才为 true（App 首次启动引导据此判定，避免 mount 闪弹/SSE 早到事件误触发） */
  loaded: boolean;
  load: () => void;
  save: (p: ModelProvider) => void;
  remove: (id: string) => void;
  setProviders: (ps: ModelProvider[]) => void;
  test: (input: TestInput) => Promise<{ ok: boolean; error?: string }>;
}

export const useProvidersStore = create<ProvidersState>((set) => ({
  providers: [],
  loading: false,
  loaded: false,
  load: () => {
    api
      .get("/api/providers")
      .then((data: any) => {
        if (data)
          set({
            providers: data.providers ?? [],
            loading: false,
            loaded: Array.isArray(data.providers),
          });
      })
      .catch(() => set({ loading: false }));
  },
  save: (p) => {
    void api.post("/api/providers", { provider: p });
  },
  remove: (id) => {
    void api.del(`/api/providers/${encodeURIComponent(id)}`);
  },
  setProviders: (ps) => set({ providers: ps, loading: false }),
  test: async (input) => {
    const res = (await api.post("/api/providers/test", input)) as {
      ok: boolean;
      error?: string;
    };
    return { ok: res.ok, error: res.error };
  },
}));
