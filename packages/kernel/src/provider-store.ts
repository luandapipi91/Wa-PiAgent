import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { PROVIDERS_FILE } from "@wa-pi/shared";
import type { ModelProvider } from "@wa-pi/shared";

interface ProvidersFile {
  providers: ModelProvider[];
}

/**
 * 供应商持久化：读写 ~/.wa-pi/providers.json（结构 { providers: [...] }）。
 * 沿用 ConfigStore 的 JSON 文件读写模式：文件不存在视为空。
 */
export class ProviderStore {
  constructor(private file: string = PROVIDERS_FILE) {}

  /** 读取全部供应商；文件不存在返回空数组 */
  async load(): Promise<ModelProvider[]> {
    try {
      const raw = await readFile(this.file, "utf8");
      const data = JSON.parse(raw) as ProvidersFile;
      return data.providers ?? [];
    } catch {
      return [];
    }
  }

  /** 新增或更新（按 provider.id upsert，自动规范化 baseUrl 尾部斜杠） */
  async save(provider: ModelProvider): Promise<void> {
    // 规范化 baseUrl：去掉尾部斜杠，避免双斜杠导致请求失败
    const normalized = { ...provider, baseUrl: provider.baseUrl.replace(/\/+$/, "") };
    const list = await this.load();
    const idx = list.findIndex(p => p.id === normalized.id);
    if (idx >= 0) list[idx] = normalized;
    else list.push(normalized);
    await this.persist(list);
  }

  /** 按 id 删除；不存在则无操作 */
  async delete(id: string): Promise<void> {
    const list = await this.load();
    await this.persist(list.filter(p => p.id !== id));
  }

  /** 写盘 */
  private async persist(providers: ModelProvider[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const data: ProvidersFile = { providers };
    await writeFile(this.file, JSON.stringify(data, null, 2), "utf8");
  }
}
