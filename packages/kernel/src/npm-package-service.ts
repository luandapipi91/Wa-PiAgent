// packages/kernel/src/npm-package-service.ts
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

export interface NpmPackageServiceOpts {
  /** 包管理器命令，默认 ["bun"]，从 settings.json.npmCommand 读取 */
  npmCommand?: string[];
}

export class NpmPackageService {
  private npmCommand: string[];

  constructor(
    private runtimeDir: string,
    opts: NpmPackageServiceOpts = {},
  ) {
    this.npmCommand = opts.npmCommand ?? ["bun"];
    // 确保 runtimeDir 及其 package.json 始终存在，否则 bun add/remove 的 cwd
    // 和 package.json 缺失会导致 "No package.json, so nothing to remove"。
    if (!existsSync(this.runtimeDir)) mkdirSync(this.runtimeDir, { recursive: true });
    const pkgJson = join(this.runtimeDir, "package.json");
    if (!existsSync(pkgJson)) {
      writeFileSync(pkgJson, JSON.stringify({ name: "wa-pi-runtime", private: true, type: "module" }, null, 2) + "\n");
    }
  }

  /**
   * 把命令名解析为绝对路径（否则 Bun.spawn 在 PATH 不含该命令的环境会失败）。
   * bun → process.execPath（始终指向运行内核的那个 bun 二进制，dev/打包后均适用）；
   * 其他命令 → Bun.which 搜 PATH，搜不到返回原值让 spawn 报清晰错误。
   */
  private resolveCommand(cmd: string): string {
    if (cmd === "bun") return process.execPath;
    return Bun.which(cmd) ?? cmd;
  }

  /** 执行包管理器子进程，返回 exitCode + stderr；onProgress 按行转发 stdout/stderr */
  private async spawn(args: string[], onProgress?: (line: string) => void): Promise<{ exitCode: number; stderr: string }> {
    const [cmd, ...rest] = [...this.npmCommand, ...args];
    const resolvedCmd = this.resolveCommand(cmd);
    const proc = Bun.spawn([resolvedCmd, ...rest], {
      cwd: this.runtimeDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // 并发排空 stdout/stderr 防止管道阻塞；按行回推进度
    const [stderr] = await Promise.all([
      drainLines(proc.stderr, onProgress),
      drainLines(proc.stdout, onProgress),
    ]);
    const exitCode = await proc.exited;
    return { exitCode, stderr };
  }

  /** 安装 npm 包 */
  async install(name: string, version?: string, onProgress?: (line: string) => void): Promise<{ version: string }> {
    const pkg = version ? `${name}@${version}` : name;
    const { exitCode, stderr } = await this.spawn(["add", pkg], onProgress);
    if (exitCode !== 0) {
      throw new Error(`安装失败: ${stderr || `exit code ${exitCode}`}`);
    }
    const actualVersion = this.getInstalledVersion(name);
    if (!actualVersion) throw new Error(`安装后未找到包: ${name}`);
    return { version: actualVersion };
  }

  /** 卸载 npm 包。若包不在 node_modules 中则静默跳过（仅清理 settings.json 条目即可）。 */
  async uninstall(name: string): Promise<void> {
    if (!existsSync(join(this.runtimeDir, "node_modules", name))) return;
    const { exitCode, stderr } = await this.spawn(["remove", name]);
    if (exitCode !== 0) {
      throw new Error(`卸载失败: ${stderr || `exit code ${exitCode}`}`);
    }
  }

  /** 升级 npm 包到最新版。
   *  用 `add <name>`（不带版本号）而非 `update <name>`：bun 默认把精确版本写入
   *  package.json（save-exact），而 `update` 只在现有 semver 范围内重新解析——
   *  精确版本范围内只有自身一个版本，导致 exit 0 但版本不变（升级静默失败）。
   *  `add` 会强制解析到最新版并写入，与 install 行为一致。 */
  async upgrade(name: string, onProgress?: (line: string) => void): Promise<{ version: string }> {
    const { exitCode, stderr } = await this.spawn(["add", name], onProgress);
    if (exitCode !== 0) {
      throw new Error(`升级失败: ${stderr || `exit code ${exitCode}`}`);
    }
    const actualVersion = this.getInstalledVersion(name);
    if (!actualVersion) throw new Error(`升级后未找到包: ${name}`);
    return { version: actualVersion };
  }

  /** 查询 npm registry 最新版本 */
  async getLatestVersion(name: string): Promise<string | undefined> {
    try {
      const { exitCode, stderr } = await this.spawn(["pm", "ls", name]);
      if (exitCode !== 0) return undefined;
      // 用 npm view 查最新版本（bun pm ls 不提供此信息）
      // 此命令只读，使用 npm 而非 bun 因为 bun 无等效命令
      const npmCmd = Bun.which("npm") ?? "npm";
      const view = Bun.spawn([npmCmd, "view", name, "version"], {
        cwd: this.runtimeDir,
        stdio: ["pipe", "pipe", "pipe"],
      });
      // 加超时：离线/慢网络时 5s 后 kill，避免 list() 阻塞 Settings 面板
      const VERSION_TIMEOUT_MS = 5000;
      const timer = setTimeout(() => {
        try { view.kill(); } catch {}
      }, VERSION_TIMEOUT_MS);
      try {
        const viewExit = await view.exited;
        if (viewExit !== 0) return undefined;
        return (await new Response(view.stdout).text()).trim() || undefined;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return undefined;
    }
  }

  /** 读取 node_modules 中已安装包的版本 */
  getInstalledVersion(name: string): string | undefined {
    try {
      const pkgJson = join(this.runtimeDir, "node_modules", name, "package.json");
      if (!existsSync(pkgJson)) return undefined;
      const pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
      return pkg.version;
    } catch {
      return undefined;
    }
  }

  /** 读取 node_modules 中已安装包的 description */
  getDescription(name: string): string | undefined {
    try {
      const pkgJson = join(this.runtimeDir, "node_modules", name, "package.json");
      if (!existsSync(pkgJson)) return undefined;
      const pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
      return pkg.description;
    } catch {
      return undefined;
    }
  }
}

/**
 * 排空可读字节流，按行调用 onProgress；返回流的完整文本（用于 stderr 错误信息）。
 * 跨 chunk 边界正确处理：未以换行结尾的尾部缓冲会在下个 chunk 继续拼接。
 * 空白行被跳过（包管理器输出常有空行，避免噪声进度）。
 */
export async function drainLines(
  stream: ReadableStream<Uint8Array> | null,
  onProgress?: (line: string) => void,
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let full = "";
  let buf = "";

  const flushCompleteLines = () => {
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (onProgress && line.trim()) onProgress(line);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunkText = decoder.decode(value, { stream: true });
    full += chunkText;
    if (onProgress) {
      buf += chunkText;
      flushCompleteLines();
    }
  }

  // 刷新 decoder 末尾残余字节
  const tail = decoder.decode();
  if (tail) full += tail;
  if (onProgress) {
    buf += tail;
    flushCompleteLines();
    // 末行无换行结尾也回推一次
    if (buf.trim()) onProgress(buf.replace(/\r$/, ""));
  }

  return full;
}
