import { useState } from "react";
import { useProvidersStore } from "../../store/providers";
import { ProviderCard } from "./ProviderCard";
import { ProviderFormModal } from "./ProviderFormModal";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import type { ModelProvider } from "@hiagent/shared";

export function ProviderSection() {
  const { providers, remove, test } = useProvidersStore();
  const [editing, setEditing] = useState<ModelProvider | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<ModelProvider | null>(null);
  const [testStatuses, setTestStatuses] = useState<Record<string, { state: "idle" | "testing" | "ok" | "fail"; error?: string }>>({});

  const handleTest = async (p: ModelProvider) => {
    setTestStatuses(prev => ({ ...prev, [p.id]: { state: "testing" } }));
    const result = await test({ baseUrl: p.baseUrl, apiKey: p.apiKey, api: p.api, models: p.models });
    setTestStatuses(prev => ({
      ...prev,
      [p.id]: result.ok ? { state: "ok" } : { state: "fail", error: result.error },
    }));
  };

  return (
    <div className="flex flex-col gap-2 p-4 overflow-auto">
      <button
        onClick={() => setAdding(true)}
        className="self-start px-3 py-1.5 rounded-sm text-sm border-0 cursor-pointer"
        style={{ background: "var(--brand)", color: "var(--on-brand)" }}
        data-testid="add-provider-btn"
      >+ 添加供应商</button>
      {providers.map(p => (
        <ProviderCard
          key={p.id}
          provider={p}
          onEdit={() => setEditing(p)}
          onTest={() => { void handleTest(p); }}
          onDelete={() => setConfirmDelete(p)}
          testStatus={testStatuses[p.id]}
        />
      ))}
      {adding && <ProviderFormModal onClose={() => setAdding(false)} />}
      {editing && <ProviderFormModal initial={editing} onClose={() => setEditing(null)} />}
      {confirmDelete && (
        <ConfirmDialog
          title="删除供应商"
          message={`确定删除「${confirmDelete.name}」？此操作不可撤销。`}
          danger
          confirmText="删除"
          onConfirm={() => { remove(confirmDelete.id); setConfirmDelete(null); }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
