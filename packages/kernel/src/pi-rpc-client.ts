import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentConfig, RPCEvent } from "hiagent-shared";

interface PendingRequest { resolve: (data: any) => void; reject: (err: Error) => void; }

function findPiPath(): { cmd: string; args: string[] } {
  // Env var override
  if (process.env.PI_CLI_PATH) {
    return { cmd: process.execPath, args: [process.env.PI_CLI_PATH] };
  }
  // Try common nvm paths for pi cli.js
  const nvmBase = process.env.NVM_DIR ?? join(homedir(), ".nvm");
  const nvmVersions = join(nvmBase, "versions", "node");
  if (existsSync(nvmVersions)) {
    // Find the latest node version with pi installed
    const versions = readdirSync(nvmVersions).sort().reverse();
    for (const ver of versions) {
      const cliPath = join(nvmVersions, ver, "lib", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
      if (existsSync(cliPath)) {
        return { cmd: "node", args: [cliPath] };
      }
    }
  }
  // Fall back to pi in PATH
  return { cmd: "pi", args: [] };
}

export class PiRpcClient extends EventEmitter {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private pending = new Map<string, PendingRequest>();
  private nextId = 1;

  constructor(private config: AgentConfig, private cwd: string) { super(); }

  async start(): Promise<void> {
    const [provider, ...modelParts] = this.config.model.split("/");
    const args = [
      "--mode", "rpc",
      "--name", this.config.name,
      "--provider", provider || "deepseek",
      "--model", modelParts.join("/") || this.config.model,
      "--thinking", this.config.thinking,
    ];
    if (this.config.tools.length === 0) args.push("--no-tools");
    else args.push("--tools", this.config.tools.join(","));
    for (const s of this.config.skills) args.push("--skill", s);
    if (this.config.systemPrompt) args.push("--system-prompt", this.config.systemPrompt);

    const { cmd, args: piArgs } = findPiPath();
    const spawnArgs = [...piArgs, ...args];

    this.proc = spawn(cmd, spawnArgs, { stdio: ["pipe", "pipe", "pipe"], cwd: this.cwd, env: { ...process.env } });
    this.proc.stdout!.setEncoding("utf8");
    this.proc.stdout!.on("data", (chunk: string) => this.onStdout(chunk));
    this.proc.on("exit", (code, sig) => this.emit("exit", { code, sig }));
    await new Promise(r => setTimeout(r, 500)); // 等就绪
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try { this.handleEvent(JSON.parse(line) as RPCEvent); } catch {}
    }
  }

  private handleEvent(event: RPCEvent): void {
    if (event.type === "response" && "id" in event) {
      const req = this.pending.get(event.id);
      if (req) {
        this.pending.delete(event.id);
        event.success ? req.resolve(event) : req.reject(new Error(`RPC ${event.command} failed`));
      }
    }
    this.emit("event", event);
  }

  private send(command: Record<string, unknown>): Promise<any> {
    if (!this.proc?.stdin?.writable) return Promise.reject(new Error("Pi process not running"));
    const id = `r${this.nextId++}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc!.stdin!.write(JSON.stringify({ ...command, id }) + "\n");
    });
  }

  async prompt(message: string): Promise<void> { await this.send({ type: "prompt", message }); }
  async abort(): Promise<void> { await this.send({ type: "abort" }); }
  async getState(): Promise<any> { return this.send({ type: "get_state" }); }

  stop(): void {
    if (this.proc) {
      this.proc.kill("SIGTERM");
      setTimeout(() => this.proc?.kill("SIGKILL"), 1000);
      this.proc = null;
    }
  }
}
