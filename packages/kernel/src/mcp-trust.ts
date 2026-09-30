import { realpathSync } from "node:fs";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** F13：pi 用 realpathSync(cwd) 作为 trust.json 的键，逐字符比较，写错即静默失效 */
export async function trustKeyFor(cwd: string): Promise<string> {
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
}

type TrustData = Record<string, boolean>;

export class McpTrustStore {
  constructor(private readonly path: string) {}

  async get(cwd: string): Promise<boolean | null> {
    const key = await trustKeyFor(cwd);
    const data = await this.read();
    let current = key;
    for (;;) {
      const value = data[current];
      if (value === true || value === false) return value;
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }

  async set(cwd: string, decision: boolean): Promise<void> {
    const key = await trustKeyFor(cwd);
    const data = await this.read();
    data[key] = decision;
    await this.write(data);
  }

  private async read(): Promise<TrustData> {
    if (!existsSync(this.path)) return {};
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
      return parsed as TrustData;
    } catch {
      return {};
    }
  }

  /** 读-改-写 + rename；不与其他进程并发写同一时刻 */
  private async write(data: TrustData): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await rename(tmp, this.path);
  }
}
