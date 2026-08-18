/**
 * SSE 事件总线（阶段二·去 WS 化）
 *
 * 替代 WS broadcast：所有 kernel→前端的推送（sdk:event、进度帧、状态变更等）
 * 通过一条全局 SSE 流（GET /api/events）广播给所有已连接客户端。
 * 客户端以「写函数」抽象注册，便于测试；生产环境由 /api/events 端点注入
 * ReadableStream 的 enqueue 写函数。
 */
export type SseWrite = (chunk: string) => void;

export class SseBus {
  private clients = new Set<SseWrite>();

  add(write: SseWrite): void {
    this.clients.add(write);
  }

  remove(write: SseWrite): void {
    this.clients.delete(write);
  }

  get size(): number {
    return this.clients.size;
  }

  /**
   * 广播一帧：data: <JSON>\n\n。
   * 不使用 event: 字段 —— 命名事件会被 EventSource 路由到 addEventListener(type)，
   * 而前端只用 onmessage（仅接收无名事件）。事件类型已内嵌在 JSON 的 type 字段中，
   * 前端 dispatch() 根据 data.type 分发。
   *
   * 序列化与写失败的客户端移除（连接已死 / 帧无法序列化）。
   *
   * 安全保证：data 含 BigInt（部分 provider token usage）或循环引用（工具结果）时
   * JSON.stringify 会同步抛 TypeError。本方法绝不向上抛——否则异常会沿 pi stdout
   * data 回调 → onEvent → broadcast 一路无兜底冒泡，被 Bun 视为未捕获异常杀死
   * kernel 进程（历史 bug：发消息回复部分内容后 SSE 断开，日志 退出 code=null）。
   */
  broadcast(_type: string, data: unknown): void {
    // 先尝试直接序列化；失败再用 BigInt-safe replacer 重试；仍失败则丢弃该帧。
    // 用 try 包裹整个序列化，确保任何序列化异常都不冒泡。
    let frame: string;
    try {
      frame = `data: ${JSON.stringify(data)}\n\n`;
    } catch {
      try {
        // BigInt → 字符串（token usage 数值精度对前端展示无影响）
        frame = `data: ${JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v))}\n\n`;
      } catch {
        // 循环引用等彻底无法序列化的 payload：记 warn 丢帧，绝不杀进程
        console.warn(`[sse-bus] 丢弃无法序列化的 ${_type} 帧`);
        return;
      }
    }
    for (const write of [...this.clients]) {
      try {
        write(frame);
      } catch {
        this.clients.delete(write);
      }
    }
  }

  /**
   * 心跳帧：防代理/空闲断连，前端看门狗靠它判定存活。
   * 必须发真实 data 帧而非 ": ping" 注释帧——浏览器 EventSource 对注释帧
   * 不触发 onmessage，注释心跳前端完全不可观测，假活检测无从实现。
   */
  heartbeat(): void {
    this.broadcast("heartbeat", { type: "heartbeat", ts: Date.now() });
  }
}
