import { create } from "zustand";
import type { ModelProvider, ProviderApi, ProviderModel } from "@hiagent/shared";
import { api } from "../api-client";

interface TestInput {
  baseUrl: string;
  apiKey: string;
  api: ProviderApi;
  models: ProviderModel[];
}

interface ProvidersState {
  providers: ModelProvider[];
  loading: boolean;
  load: () => void;
  save: (p: ModelProvider) => void;
  remove: (id: string) => void;
  setProviders: (ps: ModelProvider[]) => void;
  test: (input: TestInput) => Promise<{ ok: boolean; error?: string }>;
}

export const useProvidersStore = create<ProvidersState>((set) => ({
  providers: [],
  loading: false,
  load: () => { api.get("/api/providers").then((data: any) => { if (data) set({ providers: data.providers ?? [], loading: false }); }).catch(() => set({ loading: false })); },
  save: (p) => { void api.post("/api/providers", { provider: p }); },
  remove: (id) => { void api.del(`/api/providers/${encodeURIComponent(id)}`); },
  setProviders: (ps) => set({ providers: ps, loading: false }),
  test: async (input) => {
    const res = (await api.post("/api/providers/test", input)) as { ok: boolean; error?: string };
    return { ok: res.ok, error: res.error };
  },
}));
