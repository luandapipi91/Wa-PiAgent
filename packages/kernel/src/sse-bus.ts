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
   * 写失败的客户端移除（连接已死）。
   */
  broadcast(_type: string, data: unknown): void {
    const frame = `data: ${JSON.stringify(data)}\n\n`;
    for (const write of [...this.clients]) {
      try {
        write(frame);
      } catch {
        this.clients.delete(write);
      }
    }
  }

  /** 心跳注释帧：防代理/空闲断连，前端可感知存活 */
  heartbeat(): void {
    for (const write of [...this.clients]) {
      try {
        write(": ping\n\n");
      } catch {
        this.clients.delete(write);
      }
    }
  }
}
