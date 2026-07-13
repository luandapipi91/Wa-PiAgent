// packages/kernel/src/npm-package-service.ts
import { join } from "node:path";
import { existsSync } from "node:fs";

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
  }

  /** 执行包管理器子进程，返回 exitCode + stderr */
  private async spawn(args: string[]): Promise<{ exitCode: number; stderr: string }> {
    const [cmd, ...rest] = [...this.npmCommand, ...args];
    const proc = Bun.spawn([cmd, ...rest], {
      cwd: this.runtimeDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    return { exitCode, stderr };
  }

  /** 安装 npm 包 */
  async install(name: string, version?: string): Promise<{ version: string }> {
    const pkg = version ? `${name}@${version}` : name;
    const { exitCode, stderr } = await this.spawn(["add", pkg]);
    if (exitCode !== 0) {
      throw new Error(`安装失败: ${stderr || `exit code ${exitCode}`}`);
    }
    const actualVersion = this.getInstalledVersion(name);
    if (!actualVersion) throw new Error(`安装后未找到包: ${name}`);
    return { version: actualVersion };
  }

  /** 卸载 npm 包 */
  async uninstall(name: string): Promise<void> {
    const { exitCode, stderr } = await this.spawn(["remove", name]);
    if (exitCode !== 0) {
      throw new Error(`卸载失败: ${stderr || `exit code ${exitCode}`}`);
    }
  }

  /** 升级 npm 包到最新版 */
  async upgrade(name: string): Promise<{ version: string }> {
    const { exitCode, stderr } = await this.spawn(["update", name]);
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
      const view = Bun.spawn(["npm", "view", name, "version"], {
        cwd: this.runtimeDir,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const viewExit = await view.exited;
      if (viewExit !== 0) return undefined;
      return (await new Response(view.stdout).text()).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /** 读取 node_modules 中已安装包的版本 */
  getInstalledVersion(name: string): string | undefined {
    try {
      const pkgJson = join(this.runtimeDir, "node_modules", name, "package.json");
      if (!existsSync(pkgJson)) return undefined;
      const pkg = JSON.parse(require("node:fs").readFileSync(pkgJson, "utf8"));
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
      const pkg = JSON.parse(require("node:fs").readFileSync(pkgJson, "utf8"));
      return pkg.description;
    } catch {
      return undefined;
    }
  }
}
