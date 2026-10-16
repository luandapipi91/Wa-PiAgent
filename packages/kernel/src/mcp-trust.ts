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

/**
 * 同进程内按 trust.json 路径串行化「读-改-写」。
 *
 * 队列挂在模块上、按路径分桶，而不是挂在实例上：端点每次请求都 `new McpTrustStore(...)`，
 * 实例级队列串不住并发请求——两个请求会读到同一份基底，后写者覆盖前写者的键
 * （并且互踩同一个临时文件：先完成者的 rename 会把临时文件移走，后者的 rename 抛 ENOENT）。
 */
const writeQueues = new Map<string, Promise<void>>();

function serializeByPath<T>(path: string, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(path) ?? Promise.resolve();
  // 前一个任务失败不能阻断后一个（第二个参数是同一个 task，兼作拒绝处理）；队列里只存已咽掉异常的版本
  const next = previous.then(task, task);
  const settled: Promise<void> = next.then(
    () => undefined,
    () => undefined,
  );
  writeQueues.set(path, settled);
  void settled.then(() => {
    if (writeQueues.get(path) === settled) writeQueues.delete(path);
  });
  return next;
}

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
    // 串行化后再读-改-写：并发 set()（含不同实例）必须依次进行，否则后写者会覆盖前者的键
    await serializeByPath(this.path, async () => {
      const data = await this.read();
      data[key] = decision;
      await this.write(data);
    });
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

  /** 读-改-写 + rename；同进程内由 serializeByPath 保证同一文件不并发写 */
  private async write(data: TrustData): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await rename(tmp, this.path);
  }
}
