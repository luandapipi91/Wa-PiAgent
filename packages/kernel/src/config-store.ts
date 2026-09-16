import {
  readdir,
  readFile,
  writeFile,
  mkdir,
  unlink,
  rename,
} from "node:fs/promises";
import { join } from "node:path";
import { PI_AGENTS_DIR, ALL_AGENT_NAMES } from "@wa-pi/shared";
import type { AgentConfig, AgentName } from "@wa-pi/shared";
import {
  parseAgentMd,
  stringifyAgentMd,
  validateAgentConfig,
  makeDefaultAgentConfig,
} from "./agent-md";
import { makeSeedAgentConfig } from "./default-agent-seeds";
import { KernelError } from "./kernel-error";

export class ConfigStore {
  constructor(private agentsDir: string = PI_AGENTS_DIR) {}

  async listAgents(): Promise<AgentConfig[]> {
    try {
      const files = await readdir(this.agentsDir);
      const mds = files.filter((f) => f.endsWith(".md"));
      const configs: AgentConfig[] = [];
      for (const f of mds) {
        const content = await readFile(join(this.agentsDir, f), "utf8");
        try {
          const cfg = parseAgentMd(content);
          if (cfg.displayName) configs.push(cfg); // 跳过 displayName 为空的条目（如内置 agent .md 用 name 字段）
        } catch {
          /* 跳过损坏文件 */
        }
      }
      return configs;
    } catch {
      return []; // 目录不存在视为空
    }
  }

  async getAgent(displayName: AgentName): Promise<AgentConfig | null> {
    try {
      const content = await readFile(
        join(this.agentsDir, `${displayName}.md`),
        "utf8",
      );
      return parseAgentMd(content);
    } catch {
      return null;
    }
  }

  async saveAgent(config: AgentConfig): Promise<string[]> {
    const errs = validateAgentConfig(config);
    if (errs.length > 0) return errs;
    await mkdir(this.agentsDir, { recursive: true });
    await writeFile(
      join(this.agentsDir, `${config.displayName}.md`),
      stringifyAgentMd(config),
      "utf8",
    );
    return [];
  }

  /** displayName 清洗为可用文件名；冲突时追加 -2/-3 后缀 */
  private async uniqueName(base: string): Promise<string> {
    const existing = new Set(
      (await this.listAgents()).map((a) => a.displayName),
    );
    if (!existing.has(base)) return base;
    for (let i = 2; ; i++) {
      const candidate = `${base}-${i}`;
      if (!existing.has(candidate)) return candidate;
    }
  }

  async createAgent(displayName: string): Promise<AgentConfig> {
    const trimmed = displayName.trim();
    if (!trimmed || /[/\\:*?"<>|]/.test(trimmed))
      throw new KernelError("agent.invalidDisplayName", { name: displayName });
    const unique = await this.uniqueName(trimmed);
    const config = makeDefaultAgentConfig(unique);
    await this.saveAgent(config);
    return config;
  }

  async deleteAgent(displayName: string): Promise<void> {
    if (!(await this.getAgent(displayName)))
      throw new KernelError("agent.notFound", { name: displayName });
    await unlink(join(this.agentsDir, `${displayName}.md`));
  }

  /** 重命名：删旧文件写新文件；返回校验错误（空数组 = 成功） */
  async renameAgent(
    oldDisplayName: string,
    config: AgentConfig,
  ): Promise<string[]> {
    const errs = validateAgentConfig(config);
    if (errs.length > 0) return errs;
    if (
      config.displayName !== oldDisplayName &&
      (await this.getAgent(config.displayName))
    ) {
      return [`名称已被占用: ${config.displayName}`];
    }
    if (config.displayName !== oldDisplayName)
      await unlink(join(this.agentsDir, `${oldDisplayName}.md`));
    await this.saveAgent(config);
    return [];
  }

  /**
   * 幂等 seed 内置默认 agent：逐角色检查，缺失才写入。
   * - 全新安装：写入全部内置角色
   * - 存量环境：只补齐缺失的新角色，绝不覆盖已存在的同名 .md（保护用户已修改的角色，
   *   包括解析失败的损坏文件——直接探测文件存在性而不是解析结果）
   * - 环境变量 WA_PI_SKIP_AGENT_SEED=1 时整体跳过（E2E 等需要最小化预置环境的场景）
   */
  async seedDefaults(): Promise<void> {
    if (process.env.WA_PI_SKIP_AGENT_SEED === "1") return;
    for (const displayName of ALL_AGENT_NAMES) {
      try {
        await readFile(join(this.agentsDir, `${displayName}.md`), "utf8");
        continue; // 文件已存在，跳过
      } catch {
        /* 文件不存在，写入 seed */
      }
      await this.saveAgent(makeSeedAgentConfig(displayName));
    }
  }

  /**
   * 一次性迁移：把旧版本（含 name 字段、文件名用内部 name）的 agent 数据迁到 displayName 作 id。
   * - 旧 .md 文件名 = 内部 name（如 dev），frontmatter 含 name + displayName 两个字段
   * - 迁移后：文件名 = displayName（如 技术实现），frontmatter 只保留 displayName
   * - 返回 oldName → displayName 映射，调用方据此时同步 projects.json 的 primaryAgent
   * 幂等：已是新格式的文件（文件名 = displayName、无 name 字段）不受影响。
   */
  async migrateNameToDisplayName(): Promise<Map<string, string>> {
    const mapping = new Map<string, string>();
    let files: string[];
    try {
      files = await readdir(this.agentsDir);
    } catch {
      return mapping;
    }
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const oldPath = join(this.agentsDir, f);
      let content: string;
      try {
        content = await readFile(oldPath, "utf8");
      } catch {
        continue;
      }
      // 检测是否为旧格式：frontmatter 含 name 字段
      const hasNameField = /^---\n[\s\S]*?\nname:\s*.+/m.test(content);
      const oldStem = f.slice(0, -3); // 去掉 .md
      if (!hasNameField && oldStem !== "") {
        // 已是新格式或无法判断；尝试核对文件名是否等于 displayName
        try {
          const cfg = parseAgentMd(content);
          if (cfg.displayName === oldStem) continue; // 文件名已 = displayName，无需迁移
        } catch {
          continue;
        }
      }
      // 解析出 displayName，把文件重命名为 displayName.md 并重写（去掉 name 行）
      try {
        const cfg = parseAgentMd(content);
        const newName = cfg.displayName;
        // 防护：displayName 为空（如内置 subagent 只有 name 字段无 displayName），跳过不迁移
        if (!newName) continue;
        if (newName !== oldStem) {
          mapping.set(oldStem, newName);
        } else if (newName === oldStem) {
          // 文件名已对，只需确认 frontmatter 无残留 name 字段
          const cleaned = content.replace(/^name:.*\n/m, "");
          if (cleaned !== content) await writeFile(oldPath, cleaned, "utf8");
          continue;
        }
        // 重写（stringifyAgentMd 已不含 name 字段）+ 重命名文件
        const newPath = join(this.agentsDir, `${newName}.md`);
        await writeFile(newPath, stringifyAgentMd(cfg), "utf8");
        if (newPath !== oldPath) await unlink(oldPath).catch(() => {});
      } catch {
        /* 跳过损坏文件 */
      }
    }
    return mapping;
  }
}
