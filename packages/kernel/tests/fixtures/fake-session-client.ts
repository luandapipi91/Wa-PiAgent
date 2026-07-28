// fake-session-client.ts — AgentManager 测试用的假 pi rpc client。
//
// 与 RpcClient 同形（仅实现 AgentManager 用到的方法），由测试驱动：
// - prompted/steered/models/thinkingLevels/aborts 记录所有调用，供断言
// - emit() 手动注入事件（agent_start / turn_end / agent_settled / message_end ...）
// - autoSettle=true 时 prompt 后自动发 agent_start + agent_settled（默认空闲回路）
// - simulateCrash() 模拟进程意外退出（走 onExit 回调）

import type { RpcClientOpts, RpcEvent } from "../../src/rpc-client";

export class FakeSessionClient {
  readonly opts: RpcClientOpts;
  started = false;
  alive = true;
  autoSettle = true;

  prompted: string[] = [];
  steered: string[] = [];
  followUps: string[] = [];
  aborts = 0;
  models: Array<{ provider: string; modelId: string }> = [];
  thinkingLevels: string[] = [];
  messagesToReturn: any[] = [];
  availableModels: Array<{ id: string; provider: string }> = [];
  /** get_commands 返回的命令清单（默认空） */
  commandsToReturn: Array<{ name: string; description?: string; source: string }> = [];
  /** 下一次 prompt 抛该错误（注入失败路径），用后自动清除 */
  nextPromptError: Error | null = null;
  /** start 时抛该错误（注入启动失败路径） */
  startError: Error | null = null;
  /** getMessages 时抛该错误 */
  getMessagesError: Error | null = null;
  /** prompt 时同步注入的事件（在自动 settle 之前，按序发出） */
  onPromptEvents: RpcEvent[] = [];

  constructor(opts: RpcClientOpts) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    if (this.startError) throw this.startError;
    this.started = true;
  }

  isAlive(): boolean {
    return this.alive;
  }

  async command(cmd: Record<string, any>): Promise<any> {
    switch (cmd.type) {
      case "get_messages":
        return { messages: this.messagesToReturn };
      case "get_available_models":
        return { models: this.availableModels };
      case "get_commands":
        return { commands: this.commandsToReturn };
      case "get_last_assistant_text":
        return { text: this.messagesToReturn.at(-1)?.content?.[0]?.text ?? null };
      default:
        throw new Error(`FakeSessionClient 未实现的命令: ${cmd.type}`);
    }
  }

  async getMessages(): Promise<any[]> {
    if (this.getMessagesError) throw this.getMessagesError;
    return this.messagesToReturn;
  }

  async getCommands(): Promise<{ commands: any[] }> {
    return { commands: this.commandsToReturn };
  }

  async prompt(text: string): Promise<void> {
    if (this.nextPromptError) {
      const err = this.nextPromptError;
      this.nextPromptError = null;
      throw err;
    }
    this.prompted.push(text);
    for (const e of this.onPromptEvents) this.emit(e);
    this.onPromptEvents = [];
    if (this.autoSettle) {
      this.emit({ type: "agent_start" });
      this.emit({ type: "agent_settled" });
    }
  }

  async steer(text: string): Promise<void> {
    this.steered.push(text);
  }

  async followUp(text: string): Promise<void> {
    this.followUps.push(text);
  }

  async abort(): Promise<void> {
    this.aborts++;
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    this.models.push({ provider, modelId });
  }

  async setThinkingLevel(level: string): Promise<void> {
    this.thinkingLevels.push(level);
  }

  async dispose(): Promise<void> {
    this.alive = false;
  }

  /** 手动注入事件（驱动 AgentManager 的 busy/队列状态机） */
  emit(e: RpcEvent): void {
    this.opts.onEvent(e);
  }

  /** 模拟进程意外退出（AgentManager 应标记崩溃并合成错误事件） */
  simulateCrash(code = 1): void {
    this.alive = false;
    this.opts.onExit?.(code, null);
  }
}

/**
 * 生成 createClientFn 工厂：每次 AgentManager spawn 记录一个 FakeSessionClient 到数组。
 * 用法：const fakes: FakeSessionClient[] = []; new AgentManager({ ..., createClientFn: fakeClientFactory(fakes) })
 */
export function fakeClientFactory(fakes: FakeSessionClient[]) {
  return (opts: RpcClientOpts) => {
    const fake = new FakeSessionClient(opts);
    fakes.push(fake);
    // AgentManager 类型要求 RpcClient，按同形结构桥接
    return fake as unknown as import("../../src/rpc-client").RpcClient;
  };
}
