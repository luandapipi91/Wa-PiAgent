import { useState } from "react";
import { Modal } from "../ui/Modal";
import { TagInput } from "../ui/TagInput";
import { useProvidersStore } from "../../store/providers";
import { PROVIDER_PRESETS } from "@hiagent/shared";
import type { ModelProvider, ProviderApi, ProviderModel } from "@hiagent/shared";

interface Props {
  initial?: ModelProvider;   // 编辑时传，新增时不传
  onClose: () => void;
}

const DEFAULT_CONTEXT = 128000;
const DEFAULT_MAX_TOKENS = 4096;

export function ProviderFormModal({ initial, onClose }: Props) {
  const save = useProvidersStore(s => s.save);
  const test = useProvidersStore(s => s.test);

  const [name, setName] = useState(initial?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? "");
  const [api, setApi] = useState<ProviderApi>(initial?.api ?? "openai-completions");
  const [modelIds, setModelIds] = useState<string[]>(initial?.models.map(m => m.id) ?? []);
  // 模型长度配置：key = modelId
  const [modelConfigs, setModelConfigs] = useState<Record<string, ProviderModel>>(
    Object.fromEntries((initial?.models ?? []).map(m => [m.id, m]))
  );
  const [testStatus, setTestStatus] = useState<{ state: "idle" | "testing" | "ok" | "fail"; error?: string }>({ state: "idle" });
  const [selectedPresetKey, setSelectedPresetKey] = useState<string>("");
  const selectedPreset = PROVIDER_PRESETS.find(p => p.key === selectedPresetKey);

  // tag 变化 → 同步 modelConfigs（新增的用默认值，删除的移除）
  const handleTagsChange = (tags: string[]) => {
    setModelIds(tags);
    setModelConfigs(prev => {
      const next: Record<string, ProviderModel> = {};
      for (const id of tags) {
        next[id] = prev[id] ?? { id, contextWindow: DEFAULT_CONTEXT, maxTokens: DEFAULT_MAX_TOKENS };
      }
      return next;
    });
  };

  // 选预设 → 填表（不走 handleTagsChange，避免把预设数值套成默认 128000/4096）
  const applyPreset = (key: string): void => {
    setSelectedPresetKey(key);
    if (!key) return; // 选「自定义」不清空
    const preset = PROVIDER_PRESETS.find(p => p.key === key);
    if (!preset) return;
    setName(preset.name);
    setBaseUrl(preset.baseUrl);
    setApi(preset.api);
    setModelIds(preset.models.map(m => m.id));
    setModelConfigs(Object.fromEntries(preset.models.map(m => [m.id, m])));
    // apiKey 不动（新增时为空）
  };

  const valid = name.trim() && baseUrl.trim() && apiKey.trim() && modelIds.length > 0;

  const handleSave = () => {
    if (!valid) return;
    const provider: ModelProvider = {
      id: initial?.id ?? crypto.randomUUID(),
      name: name.trim(),
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim(),
      api,
      models: modelIds.map(id => modelConfigs[id]),
    };
    save(provider);
    onClose();
  };

  const handleTest = async () => {
    setTestStatus({ state: "testing" });
    const result = await test({ baseUrl, apiKey, api, models: modelIds.map(id => modelConfigs[id]) });
    setTestStatus(result.ok ? { state: "ok" } : { state: "fail", error: result.error });
  };

  return (
    <Modal onClose={onClose} width={640} data-testid="provider-form-modal">
      <div className="p-4 border-b border-hairline">
        <span className="text-primary font-bold text-sm">{initial ? "编辑供应商" : "添加供应商"}</span>
      </div>
      <div className="p-4 flex flex-col gap-3 overflow-auto" style={{ maxHeight: "70vh" }}>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-secondary">快捷选择</span>
          <select
            data-testid="preset-select"
            value={selectedPresetKey}
            onChange={e => applyPreset(e.target.value)}
            className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none"
          >
            <option value="">自定义（手动填写）</option>
            {PROVIDER_PRESETS.map(p => (
              <option key={p.key} value={p.key}>
                {p.plan ? "🏷 " : ""}{p.name}
              </option>
            ))}
          </select>
          {initial && (
            <span className="text-xs" style={{ color: "var(--danger)" }}>选择预设会覆盖当前表单</span>
          )}
          {selectedPreset?.hint && (
            <span className="text-xs text-tertiary">{selectedPreset.hint}</span>
          )}
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-secondary">供应商名称</span>
          <input
            data-testid="field-name"
            value={name}
            onChange={e => setName(e.target.value)}
            className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-secondary">Base URL</span>
          <input
            data-testid="field-baseUrl"
            value={baseUrl}
            onChange={e => setBaseUrl(e.target.value)}
            placeholder="https://api.example.com/v1"
            className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-secondary">API Key</span>
          <input
            data-testid="field-apiKey"
            type="password"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none"
          />
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-secondary">API 格式</span>
          <div className="flex gap-4">
            <label className="flex items-center gap-1.5 text-sm text-primary cursor-pointer">
              <input type="radio" checked={api === "openai-completions"} onChange={() => setApi("openai-completions")} />
              OpenAI 兼容
            </label>
            <label className="flex items-center gap-1.5 text-sm text-primary cursor-pointer">
              <input type="radio" checked={api === "anthropic-messages"} onChange={() => setApi("anthropic-messages")} />
              Anthropic
            </label>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-secondary">模型 ID（输入 | 添加，× 移除）</span>
          <TagInput value={modelIds} onChange={handleTagsChange} placeholder="输入模型 ID，回车或 | 添加" />
        </div>
        {modelIds.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="text-xs text-secondary">模型列表</span>
            <div className="rounded-sm border border-hairline overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-surface-hover text-tertiary">
                  <tr>
                    <th className="text-left px-2 py-1 font-normal">模型 ID</th>
                    <th className="text-left px-2 py-1 font-normal">上下文窗口</th>
                    <th className="text-left px-2 py-1 font-normal">最大输出</th>
                    <th className="text-left px-2 py-1 font-normal">图片</th>
                  </tr>
                </thead>
                <tbody>
                  {modelIds.map((id, i) => (
                    <tr key={id} className="border-t border-hairline">
                      <td className="px-2 py-1 text-primary">{id}</td>
                      <td className="px-2 py-1">
                        <input
                          data-testid={`model-contextWindow-${i}`}
                          type="number"
                          value={modelConfigs[id]?.contextWindow ?? DEFAULT_CONTEXT}
                          onChange={e => setModelConfigs(prev => ({
                            ...prev,
                            [id]: { ...prev[id], contextWindow: Number(e.target.value) || 0 },
                          }))}
                          className="w-24 px-1 py-0.5 rounded-sm border border-hairline bg-surface text-primary outline-none"
                        />
                      </td>
                      <td className="px-2 py-1">
                        <input
                          data-testid={`model-maxTokens-${i}`}
                          type="number"
                          value={modelConfigs[id]?.maxTokens ?? DEFAULT_MAX_TOKENS}
                          onChange={e => setModelConfigs(prev => ({
                            ...prev,
                            [id]: { ...prev[id], maxTokens: Number(e.target.value) || 0 },
                          }))}
                          className="w-24 px-1 py-0.5 rounded-sm border border-hairline bg-surface text-primary outline-none"
                        />
                      </td>
                      <td className="px-2 py-1">
                        <input
                          data-testid={`model-vision-${i}`}
                          type="checkbox"
                          checked={modelConfigs[id]?.supportsVision ?? false}
                          onChange={e => setModelConfigs(prev => ({
                            ...prev,
                            [id]: { ...prev[id], supportsVision: e.target.checked },
                          }))}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {/* 测试连接结果 */}
        {testStatus.state === "testing" && <span className="text-xs text-secondary">测试中…</span>}
        {testStatus.state === "ok" && <span className="text-xs" style={{ color: "var(--success)" }}>✓ 连接成功</span>}
        {testStatus.state === "fail" && <span className="text-xs" style={{ color: "var(--danger)" }}>✗ 失败：{testStatus.error}</span>}
      </div>
      <div className="flex justify-between items-center p-3 border-t border-hairline">
        <button
          onClick={handleTest}
          disabled={!baseUrl || !apiKey}
          className="px-3 py-1.5 rounded-sm text-sm border border-hairline text-secondary hover:text-primary disabled:opacity-50"
        >测试连接</button>
        <div className="flex gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-sm text-sm bg-surface-hover text-secondary border border-hairline hover:text-primary">取消</button>
          <button
            onClick={handleSave}
            disabled={!valid}
            data-testid="provider-save-btn"
            className="px-3 py-1.5 rounded-sm text-sm border-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ background: "var(--brand)", color: "var(--on-brand)" }}
          >保存</button>
        </div>
      </div>
    </Modal>
  );
}
