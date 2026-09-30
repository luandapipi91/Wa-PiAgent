// McpFile：MCP 配置文件的**唯一写入者**。
//
// 盘上两种作用域：
//   - 全局：<WA_PI_DIR>/mcp.json
//   - 项目：<project.cwd>/.pi/mcp.json（由 projectPathFor 回调解析，规格 F11）
//
// 三条铁律：
//   1. 保留未知字段 —— schema 之外的键（其他工具/用户写的）在 server 条目上原样保留，
//      整体替换条目是历史 bug（F15）。
//   2. 已知 schema 键是**替换语义** —— payload 里缺席（含显式 undefined）即从条目删除该键：
//      否则用户清空 toolExposure / env / headers 后保存，盘上旧键仍在，永远删不掉（控制者裁决的缺口②）。
//   3. 校验失败不写盘 —— validateMcpServer 报错则直接返回，文件保持原样。
//
// 契约（{@link McpFile.save}）：**调用方必须传完整配置**——它代表该 server 的目标状态，
// 缺席的已知键会被删除。只传改动字段的「补丁式」调用会把其他已知键一并删掉。
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type McpFieldError,
  type McpServerConfig,
  validateMcpServer,
} from "@wa-pi/shared";
import { KernelError } from "./kernel-error.ts";

/** 盘上文件形状：server 条目保留任意未知字段 */
type RawServer = Record<string, unknown> & { name?: string };
interface RawFile {
  mcpServers: Record<string, RawServer>;
  autoEnableCodemode?: boolean;
  [key: string]: unknown;
}

/**
 * 已知 schema 键（= `McpServerConfig` 除 `name`，`name` 由 map 的键表达、不写进条目）。
 *
 * 用 `Record<KnownServerKey, true>` 而非数组：多键/少键都会在编译期报错，
 * `@wa-pi/shared` 的 schema 一变这里就必须跟上（否则新字段会被当成「未知键」永久保留、删不掉）。
 */
type KnownServerKey = Exclude<keyof McpServerConfig, "name">;
const KNOWN_SERVER_KEYS: Record<KnownServerKey, true> = {
  type: true,
  command: true,
  args: true,
  env: true,
  cwd: true,
  url: true,
  headers: true,
  timeout: true,
  enabled: true,
  exposure: true,
  toolExposure: true,
};

/** 既不是 schema 键也不是 name（name 不落条目）→ 是「未知键」，换语义下也不得动它 */
function isUnknownKey(key: string): boolean {
  return key !== "name" && !Object.hasOwn(KNOWN_SERVER_KEYS, key);
}

/**
 * 同进程内按目标文件路径串行化「读-改-写」。
 *
 * 队列挂在模块上、按路径分桶，而不是挂在实例上：REST 写端点（`routes/mcp.ts`）每次请求都
 * 可能走 `new McpFile(...)`，且调用方（测试/迁移/其它工具）本就会自建实例——实例级队列
 * 串不住并发写。不串行化时两个并发写会读到同一份基底（后写者覆盖前写者的改动，即丢更新），
 * 并且互踩同一个临时文件：先完成者的 `rename` 已把 `<path>.<pid>.tmp` 移走，后者的 `rename`
 * 抛 ENOENT。做法与 `mcp-trust.ts` 的 `serializeByPath` 一致（任务 4 在那边裁决修掉的同一
 * 类 bug，任务 8 把 REST 写接口接到本模块后该路径即变为可达）。
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

export interface McpFileOpts {
  /** <WA_PI_DIR>/mcp.json */
  globalPath: string;
  /** 由 projectId 解析出 <project.cwd>/.pi/mcp.json */
  projectPathFor: (projectId: string) => Promise<string>;
}

export class McpFile {
  constructor(private opts: McpFileOpts) {}

  async list(projectId?: string): Promise<McpServerConfig[]> {
    const path = await this.resolvePath(projectId);
    const cfg = await this.read(path);
    return Object.entries(cfg.mcpServers).map(
      ([name, v]) => ({ name, ...v }) as McpServerConfig,
    );
  }

  async getAutoEnableCodemode(projectId?: string): Promise<boolean> {
    const cfg = await this.read(await this.resolvePath(projectId));
    return cfg.autoEnableCodemode !== false;
  }

  /**
   * 保存（新增或替换条目）。
   *
   * 语义：
   *   - **未知键**（schema 之外的键）原样保留，payload 里带来的未知键也照写（F15 的核心保护）；
   *   - **已知 schema 键**替换：payload 里有值（含 `undefined` 以外的任何值）即写入，
   *     缺席或显式 `undefined` 即从条目删除 —— 显式 `undefined` 与缺席同义，
   *     这是「清空即删除」的唯一途径（见文件头铁律 2）。
   *
   * **契约：调用方必须传完整配置**（该 server 的目标状态），缺席的已知键会被删除；
   * 只传改动字段的补丁式调用会连带删掉其他已知键。
   *
   * 校验失败不写盘，返回字段级错误。
   */
  async save(
    input: McpServerConfig,
    projectId?: string,
    originalName?: string,
  ): Promise<{ ok: true } | { ok: false; errors: McpFieldError[] }> {
    const errors = validateMcpServer(input);
    if (errors.length > 0) return { ok: false, errors };

    const path = await this.resolvePath(projectId);
    // 读-改-写整体串行化：并发 save（含不同实例、不同 server）必须依次读同一份基底再写，
    // 否则后写者会覆盖前写者的改动（前端是 fire-and-forget，连点保存/删除即可触发）
    return await serializeByPath(path, async () => {
      const cfg = await this.read(path);
      const { name, ...rest } = input;
      const previous =
        cfg.mcpServers[name] ??
        (originalName ? cfg.mcpServers[originalName] : undefined) ??
        {};
      const payload = rest as Record<string, unknown>;
      // 以旧条目为基底：保留未知键（F15）；已知键在下面的循环里被逐个「写入或删除」
      const entry: RawServer = {};
      for (const [key, value] of Object.entries(previous)) {
        if (isUnknownKey(key)) entry[key] = value;
      }
      for (const [key, value] of Object.entries(payload)) {
        if (value !== undefined && isUnknownKey(key)) entry[key] = value;
      }
      // 已知键：payload 缺席（含显式 undefined）即删除 —— 用户才能清空 toolExposure / env / headers
      for (const key of Object.keys(KNOWN_SERVER_KEYS) as KnownServerKey[]) {
        const value = payload[key];
        if (value !== undefined) entry[key] = value;
      }
      cfg.mcpServers[name] = entry;
      if (originalName && originalName !== name)
        delete cfg.mcpServers[originalName];
      await this.write(path, cfg);
      return { ok: true } as const;
    });
  }

  async delete(serverName: string, projectId?: string): Promise<void> {
    const path = await this.resolvePath(projectId);
    // 与 save 对称：delete 也是读-改-写，必须与并发写串行化（否则会复活刚被删掉的 server）
    await serializeByPath(path, async () => {
      const cfg = await this.read(path);
      if (!cfg.mcpServers[serverName]) {
        throw new KernelError("mcp.serverNotFound", { name: serverName });
      }
      delete cfg.mcpServers[serverName];
      await this.write(path, cfg);
    });
  }

  /** 供测试与迁移使用 */
  async readPath(path: string): Promise<RawFile> {
    return this.read(path);
  }

  private async resolvePath(projectId?: string): Promise<string> {
    return projectId ? await this.opts.projectPathFor(projectId) : this.opts.globalPath;
  }

  private async read(path: string): Promise<RawFile> {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      // 形状守卫：不是对象（字面 null / 数组 / 字符串…）一律按解析失败报错，
      // 不能泄漏原生 TypeError（那会绕过 KernelError 错误码契约）。
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new KernelError(
          "mcp.configParseFailed",
          undefined,
          `根不是对象: ${path}`,
        );
      }
      const raw = (parsed as RawFile).mcpServers;
      // 值域不是 map（如 "abc" / 0）视为配置损坏：报错而非静默清空，
      // 否则 list() 会谎报「没有服务器」，save() 更会把新服务器写丢。
      if (raw !== undefined && raw !== null && typeof raw !== "object") {
        throw new KernelError(
          "mcp.configParseFailed",
          undefined,
          `mcpServers 不是对象: ${path}`,
        );
      }
      // 数组是「手工清空列表」的自然写法：无法表达具名服务器，视为空 map。
      const mcpServers =
        raw && !Array.isArray(raw) ? (raw as Record<string, RawServer>) : {};
      return { ...(parsed as RawFile), mcpServers };
    } catch (e: unknown) {
      if ((e as { code?: string }).code === "ENOENT") return { mcpServers: {} };
      if (e instanceof KernelError) throw e;
      throw new KernelError(
        "mcp.configParseFailed",
        undefined,
        `解析 ${path} 失败: ${String(e)}`,
      );
    }
  }

  /**
   * 原子替换：先写临时文件再 rename，避免半写。
   * 同一路径不并发：save / delete 的读-改-写由 {@link serializeByPath} 串行化，
   * 故 `${path}.${process.pid}.tmp` 这个 pid 级临时名不会被两个写者互相搬走（ENOENT）。
   */
  private async write(path: string, cfg: RawFile): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(cfg, null, 2), "utf8");
    await rename(tmp, path);
  }
}

/** 项目 id → <cwd>/.pi/mcp.json（规格 F11） */
export function projectMcpPath(projectCwd: string): string {
  return join(projectCwd, ".pi", "mcp.json");
}

export function hasProjectMcpFile(projectCwd: string): boolean {
  return existsSync(projectMcpPath(projectCwd));
}
