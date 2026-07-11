// MemoryPage.tsx — 记忆管理页主容器
import { useEffect, useState } from "react";
import { useMemoryStore } from "../../store/memory";
import { useProjectsStore } from "../../store/projects";
import { MemoryCard } from "./MemoryCard";
import { InstructionItem } from "./InstructionItem";
import { MemoryEmpty } from "./MemoryEmpty";

export function MemoryPage() {
  const {
    memories, archived, instructions, config,
    activeTab, categoryFilter, scopeFilter, memoryScope, searchQuery,
    load, loadInstructions, setMemories, setInstructions, setConfig,
    update, archive, restore, purge, add, setConfigValue,
    setTab, setCategoryFilter, setScopeFilter, setMemoryScope, setSearchQuery,
  } = useMemoryStore();

  const currentProjectId = useProjectsStore(s => s.currentProjectId);
  const projects = useProjectsStore(s => s.projects);

  // 项目选择器：默认跟随 currentProjectId，用户可手动切换（记忆「项目」作用域与指令文件 Tab 共用）
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(currentProjectId);
  // 手动添加记忆表单
  const [showAddForm, setShowAddForm] = useState(false);
  const [newMemoryText, setNewMemoryText] = useState("");

  // 当前查看的项目：优先用户手选，回退当前打开项目
  const activeProjectId = selectedProjectId ?? currentProjectId;

  // currentProjectId 变化时同步本地选择
  useEffect(() => {
    setSelectedProjectId(currentProjectId);
  }, [currentProjectId]);

  // 记忆列表随查看项目重新加载（全局记忆包含在任意项目返回里，前端按 memoryScope 过滤）
  useEffect(() => {
    if (activeProjectId) load(activeProjectId);
  }, [load, activeProjectId]);

  // 切到指令文件 Tab 且已选项目时加载；null → 有值时也触发刷新
  useEffect(() => {
    if (activeTab === "instructions" && selectedProjectId) {
      loadInstructions(selectedProjectId);
    }
  }, [selectedProjectId, activeTab, loadInstructions]);

  // 筛选后的记忆：先按作用域（全局/项目）过滤，再按分类与搜索词
  const filteredMemories = memories
    .filter(m => m.scope === memoryScope)
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
          // 指令文件筛选：左侧 scope chips，右侧项目选择器
          <>
            <div className="flex gap-1.5">
              {(["all", "project", "global"] as const).map(f => (
                <FilterChip key={f} active={scopeFilter === f} onClick={() => setScopeFilter(f)}
                  label={f === "all" ? "全部" : f === "project" ? "项目" : "全局"} />
              ))}
            </div>
            <div className="flex-1" />
            {scopeFilter === "project" && (
            <select
              className="text-[11.5px] px-2.5 py-1 rounded-md"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--hairline)",
                color: "var(--text-primary)",
              }}
              value={selectedProjectId ?? ""}
              onChange={e => setSelectedProjectId(e.target.value)}
              data-testid="instruction-project-select"
            >
              {projects.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            )}
          </>
        ) : (
          // 记忆筛选：作用域选择器 →（项目作用域时）项目选择器 → 搜索 → 分类 → 添加
          <>
            <select
              className="text-[11.5px] px-2.5 py-1.5 rounded-md shrink-0"
              style={{ background: "var(--surface)", border: "1px solid var(--hairline)", color: "var(--text-primary)" }}
              value={memoryScope}
              onChange={e => setMemoryScope(e.target.value as "global" | "project")}
              data-testid="memory-scope-select"
            >
              <option value="global">全局记忆</option>
              <option value="project">项目记忆</option>
            </select>

            {memoryScope === "project" && (
              <select
                className="text-[11.5px] px-2.5 py-1.5 rounded-md shrink-0"
                style={{ background: "var(--surface)", border: "1px solid var(--hairline)", color: "var(--text-primary)" }}
                value={activeProjectId ?? ""}
                onChange={e => setSelectedProjectId(e.target.value)}
                data-testid="memory-project-select"
              >
                {projects.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            )}

            <input
              className="flex-1 text-[12px] px-3 py-1.5 rounded-lg min-w-0"
              style={{ background: "var(--canvas)", border: "1px solid var(--hairline)", color: "var(--text-primary)" }}
              placeholder="🔍 搜索记忆..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              data-testid="memory-search"
            />
            <div className="flex gap-1.5 shrink-0">
              {(["all", "memory", "user", "failure"] as const).map(f => (
                <FilterChip key={f} active={categoryFilter === f} onClick={() => setCategoryFilter(f)}
                  label={f === "all" ? "全部" : f === "memory" ? "记忆" : f === "user" ? "用户" : "失败"} />
              ))}
            </div>
            {activeTab === "saved" && (
              <button
                onClick={() => setShowAddForm(v => !v)}
                className="text-[11px] font-semibold px-3 py-1.5 rounded-md text-white shrink-0"
                style={{ background: "var(--accent)", border: "none" }}
                data-testid="memory-add-button"
              >+ 添加</button>
            )}
          </>
        )}
      </div>

      {/* 手动添加记忆表单（仅「已保存」Tab 展开时） */}
      {showAddForm && activeTab === "saved" && (
        <div className="px-5 py-3" style={{ background: "var(--surface)", borderBottom: "1px solid var(--hairline)" }}>
          <textarea
            className="w-full text-[12px] p-2.5 rounded-lg resize-none"
            style={{ background: "var(--canvas)", border: "1px solid var(--hairline)", color: "var(--text-primary)", minHeight: 72 }}
            placeholder={`输入要保存的${memoryScope === "global" ? "全局" : "项目"}记忆...`}
            value={newMemoryText}
            onChange={e => setNewMemoryText(e.target.value)}
            data-testid="memory-add-textarea"
          />
          <div className="flex justify-end gap-2 mt-2">
            <button
              onClick={() => { setShowAddForm(false); setNewMemoryText(""); }}
              className="text-[11px] px-3 py-1 rounded-md"
              style={{ border: "1px solid var(--hairline)", color: "var(--text-secondary)" }}
            >取消</button>
            <button
              onClick={() => {
                const text = newMemoryText.trim();
                if (!text) return;
                add(memoryScope, text, memoryScope === "project" ? (activeProjectId ?? undefined) : undefined);
                setNewMemoryText("");
                setShowAddForm(false);
              }}
              className="text-[11px] font-semibold px-3 py-1 rounded-md text-white"
              style={{ background: "var(--accent)", border: "none" }}
              data-testid="memory-add-save"
            >保存</button>
          </div>
        </div>
      )}

      {/* 列表内容 */}
      <div className="flex-1 overflow-y-auto px-5 py-3.5">
        {activeTab === "saved" && (
          filteredMemories.length === 0
            ? <MemoryEmpty type="memory" />
            : filteredMemories.map(m => (
              <MemoryCard
                key={m.id} entry={m}
                onEdit={(text) => activeProjectId && update(activeProjectId, m.id, text)}
                onArchive={() => activeProjectId && archive(activeProjectId, m.id)}
              />
            ))
        )}
        {activeTab === "archived" && (
          archived.length === 0
            ? <MemoryEmpty type="memory" />
            : archived.map(m => (
              <MemoryCard
                key={m.id} entry={m} mode="archived"
                onRestore={() => activeProjectId && restore(activeProjectId, m.id)}
                onPurge={() => activeProjectId && purge(activeProjectId, m.id)}
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
