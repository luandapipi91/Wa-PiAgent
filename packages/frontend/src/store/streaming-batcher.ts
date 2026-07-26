/**
 * streaming 渲染 rAF 合帧器（阶段一·卡顿修复项 2）
 *
 * message_update 每个 token delta 都触发一次 zustand set → React 全量重渲染。
 * 本类把一帧（requestAnimationFrame）内的多次 streaming 更新合并为一次提交（取最新），
 * 渲染路径不变。终态事件（message_end 等）到达时应先 drop，避免挂起的旧 partial
 * 在终态落库后又复活到 streaming 上。
 */
export class StreamingBatcher<T = unknown> {
  private pending = new Map<string, T>();
  private rafHandle: unknown = null;

  constructor(
    private readonly commit: (sessionId: string, value: T) => void,
    private readonly scheduleFn: (fn: () => void) => unknown,
    private readonly cancelFn: (h: unknown) => void,
  ) {}

  update(sessionId: string, value: T): void {
    this.pending.set(sessionId, value);
    if (this.rafHandle == null) {
      this.rafHandle = this.scheduleFn(() => {
        this.rafHandle = null;
        this.flush();
      });
    }
  }

  /** 丢弃该 session 的挂起帧（终态消息以 message_end 为准） */
  drop(sessionId: string): void {
    this.pending.delete(sessionId);
  }

  /** 立即提交所有挂起帧 */
  flush(): void {
    if (this.rafHandle != null) {
      this.cancelFn(this.rafHandle);
      this.rafHandle = null;
    }
    const entries = [...this.pending];
    this.pending.clear();
    for (const [sid, v] of entries) this.commit(sid, v);
  }
}
