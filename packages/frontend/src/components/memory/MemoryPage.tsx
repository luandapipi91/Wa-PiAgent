// MemoryPage.tsx — 记忆管理页主容器
import { useEffect } from "react";
import { useMemoryStore } from "../../store/memory";
import { useProjectsStore } from "../../store/projects";
import { MemoryCard } from "./MemoryCard";
import { InstructionItem } from "./InstructionItem";
import { MemoryEmpty } from "./MemoryEmpty";

export function MemoryPage() {
  const {
    memories, archived, instructions, config,
    activeTab, categoryFilter, scopeFilter, searchQuery,
    load, loadInstructions, setMemories, setInstructions, setConfig,
    update, archive, restore, purge, setConfigValue,
    setTab, setCategoryFilter, setScopeFilter, setSearchQuery,
  } = useMemoryStore();

  const currentProjectId = useProjectsStore(s => s.currentProjectId);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (currentProjectId && activeTab === "instructions") {
      loadInstructions(currentProjectId);
    }
  }, [currentProjectId, activeTab, loadInstructions]);

  // 筛选后的记忆
  const filteredMemories = memories
    .filter(m => categoryFilter === "all" || m.category === categoryFilter)
    .filter(m => !searchQuery || m.text.toLowerCase().includes(searchQuery.toLowerCase()));

  const filteredInstructions = instructions
    .filter(i => scopeFilter === "all" || i.scope === scopeFilter);

  return (
    <div className="flex-1 flex flex-col overflow-hidden" data-testid="memory-page">
      {/* 标题栏 + 内联开关 */}
      <div
        className="flex items-center justify-between px-5 py-3.5"
        style={{ background: "var(--surface)", borderBottom: "1px solid var(--hairline)" }}
      >
        <h2 className="text-base font-extrabold text-primary m-0">🧠 记忆</h2>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 cursor-pointer" data-testid="toggle-review">
            <span className="text-[11.5px] text-secondary">自动学习</span>
            <ToggleSwitch
              on={config?.reviewEnabled ?? true}
              onChange={(v) => setConfigValue({ reviewEnabled: v })}
            />
          </label>
          <label className="flex items-center gap-2 cursor-pointer" data-testid="toggle-inject">
            <span className="text-[11.5px] text-secondary">注入提示</span>
            <ToggleSwitch
              on={config?.memoryPolicyStyle !== "none"}
              onChange={(v) => setConfigValue({ memoryPolicyStyle: v ? "full" : "none" })}
            />
          </label>
        </div>
      </div>

      {/* Tab 栏 */}
      <div
        className="flex px-5"
        style={{ background: "var(--surface)", borderBottom: "1px solid var(--hairline)" }}
      >
        <TabButton active={activeTab === "saved"} onClick={() => setTab("saved")} label="已保存" count={memories.length} />
        <TabButton active={activeTab === "archived"} onClick={() => setTab("archived")} label="归档" count={archived.length} />
        <TabButton active={activeTab === "instructions"} onClick={() => setTab("instructions")} label="指令文件" count={instructions.length} />
      </div>

      {/* 工具栏 */}
      <div className="flex items-center gap-2.5 px-5 py-2.5" style={{ background: "var(--surface)", borderBottom: "1px solid var(--hairline)" }}>
        {activeTab === "instructions" ? (
          // 指令文件筛选
          <div className="flex gap-1.5">
            {(["all", "project", "global"] as const).map(f => (
              <FilterChip key={f} active={scopeFilter === f} onClick={() => setScopeFilter(f)}
                label={f === "all" ? "全部" : f === "project" ? "项目" : "全局"} />
            ))}
          </div>
        ) : (
          // 记忆筛选
          <>
            <input
              className="flex-1 text-[12px] px-3 py-1.5 rounded-lg"
              style={{ background: "var(--canvas)", border: "1px solid var(--hairline)", color: "var(--text-primary)" }}
              placeholder="🔍 搜索记忆..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              data-testid="memory-search"
            />
            <div className="flex gap-1.5">
              {(["all", "memory", "user", "failure"] as const).map(f => (
                <FilterChip key={f} active={categoryFilter === f} onClick={() => setCategoryFilter(f)}
                  label={f === "all" ? "全部" : f === "memory" ? "记忆" : f === "user" ? "用户" : "失败"} />
              ))}
            </div>
          </>
        )}
      </div>

      {/* 列表内容 */}
      <div className="flex-1 overflow-y-auto px-5 py-3.5">
        {activeTab === "saved" && (
          filteredMemories.length === 0
            ? <MemoryEmpty type="memory" />
            : filteredMemories.map(m => (
              <MemoryCard
                key={m.id} entry={m}
                onEdit={(text) => update(m.id, text)}
                onArchive={() => archive(m.id)}
              />
            ))
        )}
        {activeTab === "archived" && (
          archived.length === 0
            ? <MemoryEmpty type="memory" />
            : archived.map(m => (
              <MemoryCard
                key={m.id} entry={m} mode="archived"
                onRestore={() => restore(m.id)}
                onPurge={() => purge(m.id)}
              />
            ))
        )}
        {activeTab === "instructions" && (
          filteredInstructions.length === 0
            ? <MemoryEmpty type="instructions" />
            : filteredInstructions.map(inst => (
              <InstructionItem key={inst.path} instruction={inst} />
            ))
        )}
      </div>
    </div>
  );
}

// —— 内联子组件 ——

function TabButton({ active, onClick, label, count }: {
  active: boolean; onClick: () => void; label: string; count: number;
}) {
  return (
    <button
      onClick={onClick}
      className="text-[12px] font-semibold py-1.5 px-3.5"
      style={{
        color: active ? "var(--brand)" : "var(--text-secondary)",
        borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
        marginBottom: -1,
      }}
      data-testid={`tab-${label}`}
    >
      {label}
      <span className="text-[10px] text-tertiary ml-1">{count}</span>
    </button>
  );
}

function FilterChip({ active, onClick, label }: {
  active: boolean; onClick: () => void; label: string;
}) {
  return (
    <button
      onClick={onClick}
      className="text-[11px] font-semibold px-2.5 py-1 rounded-full"
      style={{
        background: active ? "var(--accent-soft)" : "var(--surface)",
        color: active ? "var(--accent)" : "var(--text-secondary)",
        border: active ? "none" : "1px solid var(--hairline)",
      }}
    >{label}</button>
  );
}

function ToggleSwitch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div
      onClick={() => onChange(!on)}
      className="relative cursor-pointer"
      style={{
        width: 36, height: 20, borderRadius: 9999,
        background: on ? "var(--accent)" : "var(--hairline-strong)",
        transition: "background 0.2s",
      }}
      data-testid={`toggle-${on ? "on" : "off"}`}
    >
      <div
        className="absolute top-0.5 rounded-full bg-white"
        style={{
          width: 16, height: 16,
          left: on ? 18 : 2,
          transition: "left 0.2s",
          boxShadow: "0 1px 3px rgba(0,0,0,.15)",
        }}
      />
    </div>
  );
}
