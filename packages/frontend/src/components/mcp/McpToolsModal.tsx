import { useState } from "react";
import type { McpToolSummary } from "@wa-pi/shared";
import { Modal } from "../ui/Modal";
import { useTranslation } from "../../i18n/useTranslation";

interface Props {
  serverName: string;
  tools: McpToolSummary[];
  /** 工具列表加载中（首次查看、尚未拿到结果时显示 loading 过渡） */
  loading?: boolean;
  onClose: () => void;
}

export function McpToolsModal({ serverName, tools, loading, onClose }: Props) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");

  const filtered = tools.filter(t =>
    !search || t.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <Modal onClose={onClose} width="60vw" height="80vh" data-testid="mcp-tools-modal">
      <div className="p-4 border-b border-hairline flex items-center justify-between">
        <span className="text-primary font-bold text-sm">{t("mcpTools.title", { name: serverName })}</span>
        <button onClick={onClose} className="text-tertiary text-xs">✕</button>
      </div>
      <div className="p-3 border-b border-hairline">
        <input
          className="w-full text-[calc(12px*var(--font-scale))] px-3 py-1.5 rounded-lg"
          style={{ background: "var(--canvas)", border: "1px solid var(--hairline)", color: "var(--text-primary)" }}
          placeholder={t("mcpTools.searchPlaceholder")}
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
            <span className="text-tertiary text-[calc(12.5px*var(--font-scale))]">{t("mcpTools.loading")}</span>
          </div>
        ) : tools.length === 0 ? (
          <div className="text-center py-8 text-tertiary text-[calc(12.5px*var(--font-scale))]">
            {t("mcpTools.emptyCache")}
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-8 text-tertiary text-[calc(12.5px*var(--font-scale))]">
            {t("mcpTools.noMatch")}
          </div>
        ) : (
          <>
            {filtered.map(tool => (
              <div key={tool.name} className="mb-3 p-3 rounded-lg" style={{ border: "1px solid var(--hairline)" }}>
                <div className="text-[calc(13px*var(--font-scale))] font-semibold text-primary mb-1">{tool.name}</div>
                {tool.description && (
                  <div className="text-[calc(11.5px*var(--font-scale))] text-secondary mb-2">{tool.description}</div>
                )}
                <div className="text-[calc(10.5px*var(--font-scale))]" style={{ color: "var(--text-tertiary)" }}>
                  {tool.parameters && tool.parameters.length > 0 ? (
                    <div className="p-2 rounded" style={{ background: "var(--surface-elevated)" }}>
                      <div className="font-semibold mb-1">{t("mcpTools.paramsTitle")}</div>
                      {tool.parameters.map(p => (
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
                    <div className="p-2 rounded" style={{ background: "var(--surface-elevated)" }}>{t("mcpTools.noParams")}</div>
                  )}
                </div>
              </div>
            ))}
            <div className="text-[calc(11px*var(--font-scale))] text-tertiary text-center pt-2">
              {t("mcpTools.totalCount", { count: filtered.length })}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
