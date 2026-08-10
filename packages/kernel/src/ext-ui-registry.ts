// ext-ui-registry.ts — pi 扩展 dialog 子协议（select/confirm/input/editor）的
// pending 注册表（进程级单例）。语义对齐 ask-registry：
// pi handler 在等 extension_ui_response → 本表阻塞；前端应答路由调 respond()；
// abort / teardown / 进程退出调 cancelAllForSession() 兜底（防扩展永久阻塞）。
// 不设超时：pi 侧请求带 timeout 时会自动 resolve（官方行为）。
import type { RpcUiRequest, UiResponseFields } from "./rpc-client";

interface Entry {
  sessionId: string;
  resolve: (f: UiResponseFields) => void;
  done: boolean;
}

export class ExtUiRegistry {
  private byId = new Map<string, Entry>();

  register(sessionId: string, req: RpcUiRequest): Promise<UiResponseFields> {
    const entry: Entry = { sessionId, resolve: () => {}, done: false };
    const promise = new Promise<UiResponseFields>((resolve) => {
      entry.resolve = (f) => {
        if (entry.done) return;
        entry.done = true;
        this.byId.delete(req.id);
        resolve(f);
      };
    });
    this.byId.set(req.id, entry);
    return promise;
  }

  respond(requestId: string, fields: UiResponseFields): boolean {
    const entry = this.byId.get(requestId);
    if (!entry) return false;
    entry.resolve(fields);
    return true;
  }

  cancelAllForSession(sessionId: string): void {
    for (const e of [...this.byId.values()]) {
      if (e.sessionId === sessionId) e.resolve({ cancelled: true });
    }
  }

  /** 该 session 是否有 pending 的扩展 dialog（回合看门狗误判防护：等用户应答是正常的长无事件状态） */
  hasPendingForSession(sessionId: string): boolean {
    for (const e of this.byId.values()) {
      if (e.sessionId === sessionId && !e.done) return true;
    }
    return false;
  }

  /** 测试用：清空全部状态 */
  reset(): void { this.byId.clear(); }
}

export const extUiRegistry = new ExtUiRegistry();
