import { create } from "zustand";
import type { ModelProvider, ProviderApi, ProviderModel } from "@hiagent/shared";
import { send, onMessage } from "../ws-instance";

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
  load: () => send({ type: "provider:list" }),
  save: (p) => send({ type: "provider:save", provider: p }),
  remove: (id) => send({ type: "provider:delete", id }),
  setProviders: (ps) => set({ providers: ps, loading: false }),
  test: (input) => new Promise((resolve) => {
    const off = onMessage((e: any) => {
      if (e.type === "provider:test") {
        off();
        resolve({ ok: e.ok, error: e.error });
      }
    });
    send({ type: "provider:test", ...input });
  }),
}));
