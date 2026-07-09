import type { ModelProvider } from "@hiagent/shared";

interface Props {
  provider: ModelProvider;
  onEdit: () => void;
  onTest: () => void;
  onDelete: () => void;
  testStatus?: { state: "idle" | "testing" | "ok" | "fail"; error?: string };
}

export function ProviderCard({ provider, onEdit, onTest, onDelete, testStatus }: Props) {
  return (
    <div
      className="rounded-sm border border-hairline p-3 flex flex-col gap-2"
      data-testid={`provider-card-${provider.id}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex flex-col">
          <span className="text-sm font-bold text-primary">{provider.name}</span>
          <span className="text-xs text-tertiary">{provider.api}</span>
        </div>
      </div>
      <div className="flex flex-wrap gap-1">
        {provider.models.map(m => (
          <span
            key={m.id}
            className="px-1.5 py-0.5 rounded text-xs"
            style={{ background: "var(--surface-hover)", color: "var(--secondary)" }}
          >{m.id}</span>
        ))}
      </div>
      {testStatus?.state === "testing" && <span className="text-xs text-secondary">测试中…</span>}
      {testStatus?.state === "ok" && <span className="text-xs" style={{ color: "var(--success)" }}>✓ 连接成功</span>}
      {testStatus?.state === "fail" && <span className="text-xs" style={{ color: "var(--danger)" }}>✗ {testStatus.error}</span>}
      <div className="flex gap-2">
        <button onClick={onEdit} className="px-2 py-1 rounded-sm text-xs text-secondary border border-hairline hover:text-primary">编辑</button>
        <button onClick={onTest} className="px-2 py-1 rounded-sm text-xs text-secondary border border-hairline hover:text-primary">测试连接</button>
        <button
          onClick={onDelete}
          className="px-2 py-1 rounded-sm text-xs text-secondary border border-hairline hover:text-danger"
          data-testid={`provider-delete-${provider.id}`}
        >删除</button>
      </div>
    </div>
  );
}
