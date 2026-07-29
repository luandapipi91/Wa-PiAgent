import { useState } from "react";
import type { McpToolSummary } from "@wa-pi/shared";
import { Modal } from "../ui/Modal";

interface Props {
  serverName: string;
  tools: McpToolSummary[];
  /** 工具列表加载中（首次查看、尚未拿到结果时显示 loading 过渡） */
  loading?: boolean;
  onClose: () => void;
}

export function McpToolsModal({ serverName, tools, loading, onClose }: Props) {
  const [search, setSearch] = useState("");

  const filtered = tools.filter(t =>
    !search || t.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <Modal onClose={onClose} width="60vw" height="80vh" data-testid="mcp-tools-modal">
      <div className="p-4 border-b border-hairline flex items-center justify-between">
        <span className="text-primary font-bold text-sm">🔧 {serverName} 工具列表</span>
        <button onClick={onClose} className="text-tertiary text-xs">✕</button>
      </div>
      <div className="p-3 border-b border-hairline">
        <input
          className="w-full text-[12px] px-3 py-1.5 rounded-lg"
          style={{ background: "var(--canvas)", border: "1px solid var(--hairline)", color: "var(--text-primary)" }}
          placeholder="🔍 搜索工具..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          data-testid="mcp-tools-search"
        />
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {loading && tools.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8" data-testid="mcp-tools-loading">
            <span
              className="inline-block w-4 h-4 rounded-full animate-spin"
              style={{ border: "2px solid var(--accent)", borderTopColor: "transparent" }}
            />
            <span className="text-tertiary text-[12.5px]">工具加载中...</span>
          </div>
        ) : tools.length === 0 ? (
          <div className="text-center py-8 text-tertiary text-[12.5px]">
            暂无可用的工具缓存，请先执行连接测试。
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-8 text-tertiary text-[12.5px]">
            没有匹配的工具
          </div>
        ) : (
          <>
            {filtered.map(t => (
              <div key={t.name} className="mb-3 p-3 rounded-lg" style={{ border: "1px solid var(--hairline)" }}>
                <div className="text-[13px] font-semibold text-primary mb-1">{t.name}</div>
                {t.description && (
                  <div className="text-[11.5px] text-secondary mb-2">{t.description}</div>
                )}
                <div className="text-[10.5px]" style={{ color: "var(--text-tertiary)" }}>
                  {t.parameters && t.parameters.length > 0 ? (
                    <div className="p-2 rounded" style={{ background: "var(--surface-elevated)" }}>
                      <div className="font-semibold mb-1">参数</div>
                      {t.parameters.map(p => (
                        <div key={p.name} className="ml-1">
                          <span className="font-medium text-secondary">{p.name}</span>
                          {" "}
                          <span style={{ color: "var(--accent)" }}>{p.type}</span>
                          {p.required && <span className="text-[var(--danger)] ml-0.5">*</span>}
                          {p.description && <span className="text-tertiary ml-1">— {p.description}</span>}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="p-2 rounded" style={{ background: "var(--surface-elevated)" }}>无参数</div>
                  )}
                </div>
              </div>
            ))}
            <div className="text-[11px] text-tertiary text-center pt-2">
              共 {filtered.length} 个工具
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
