// AskRegistry：ask_user_question 工具的阻塞/解决注册表（进程级单例）。
//
// 工具 execute 在此 await ask()，agent 回合阻塞；前端 agent:answer 经 ws-server
// 调 resolve()，agent:cancel-ask / abort / immediate / dispose 调 cancel()/cancelAll()。
// 不设硬超时——等用户回答或中断。等待期间连接保活由 bridge 流式路径的 15s 心跳负责
// （ask 走 NDJSON 流式，见 bridge-registry STREAM_TOOLS）；客户端断连时经
// stream cancel → signal 链路以 cancelled 解决（防僵尸提问）。
// 所有 resolve/cancel 对未知/已解决 id 幂等。
import {
	replyToAnswers,
	type AskParams,
	type AskReply,
	type AskAnswer,
} from "@wa-pi/shared";

export interface AskOutcome {
	cancelled: boolean;
	answers?: AskAnswer[];
}

interface Entry {
	params: AskParams;
	resolve: (o: AskOutcome) => void;
	onAbort: () => void;
	done: boolean;
	/** 断开标记：bridge 连接断开（signal abort）时置 true，条目保留供重试复用 */
	disconnected: boolean;
}

export class AskRegistry {
	private bySession = new Map<string, Map<string, Entry>>();

	/**
	 * 注册一个 pending 提问并返回阻塞 promise。signal abort 时以 cancelled 解决。
	 * 断开（signal abort）时条目保留（disconnected 标记），供 bridge 偶发断开后重试复用；
	 * 只有用户回答（resolve）/取消（cancel）才真正移除条目。
	 */
	ask(
		sessionId: string,
		toolCallId: string,
		params: AskParams,
		signal: AbortSignal,
	): Promise<AskOutcome> {
		const existing = this.bySession.get(sessionId)?.get(toolCallId);
		let entry: Entry;
		if (existing?.disconnected) {
			// 复用断开条目：重试继续等同一个提问的用户回答，不重复弹卡片
			entry = existing;
			entry.disconnected = false;
			entry.done = false;
		} else {
			// 首次注册（existing 为 undefined；同 toolCallId 的 pending 重复调用正常不会发生）
			entry = {
				params,
				resolve: () => {},
				onAbort: () => {},
				done: false,
				disconnected: false,
			};
			let inner = this.bySession.get(sessionId);
			if (!inner) {
				inner = new Map();
				this.bySession.set(sessionId, inner);
			}
			inner.set(toolCallId, entry);
		}
		// 先插入 entry 到 map，再检查 signal.aborted：否则预 aborted 时 resolve() 触发的
		// remove() 是 no-op（entry 尚未插入），会把一个 done:true 的 entry 永久留在 map 里。
		const promise = new Promise<AskOutcome>((resolve) => {
			entry.resolve = (o) => {
				if (entry.done) return;
				entry.done = true;
				this.remove(sessionId, toolCallId);
				resolve(o);
			};
			entry.onAbort = () => {
				// 断开：标记 disconnected 并保留条目（供重试复用），不 remove
				if (entry.done) return;
				entry.done = true;
				entry.disconnected = true;
				resolve({ cancelled: true });
			};
		});

		if (signal.aborted) entry.onAbort();
		else signal.addEventListener("abort", entry.onAbort, { once: true });
		return promise;
	}

	/** 用户提交：翻译 AskReply → answers，以 cancelled=false 解决。命中返回 true，未知/已解决返回 false。 */
	resolve(sessionId: string, toolCallId: string, reply: AskReply): boolean {
		const entry = this.bySession.get(sessionId)?.get(toolCallId);
		if (!entry) return false;
		entry.resolve({
			cancelled: false,
			answers: replyToAnswers(entry.params, reply),
		});
		return true;
	}

	/** 取消单个提问。命中返回 true，未知/已解决返回 false。 */
	cancel(sessionId: string, toolCallId: string): boolean {
		const entry = this.bySession.get(sessionId)?.get(toolCallId);
		if (!entry) return false;
		entry.resolve({ cancelled: true });
		return true;
	}

	/** 该 session 当前真实 pending 的 toolCallId 列表（前端 double check 用）。断开保留的 disconnected 不算 pending。 */
	pendingToolCallIds(sessionId: string): string[] {
		const inner = this.bySession.get(sessionId);
		if (!inner) return [];
		return [...inner.entries()]
			.filter(([, entry]) => !entry.disconnected)
			.map(([id]) => id);
	}

	/** 取消该 session 全部 pending（abort / immediate / dispose 用）。其它 session 不受影响。 */
	cancelAll(sessionId: string): void {
		const inner = this.bySession.get(sessionId);
		if (!inner) return;
		for (const entry of [...inner.values()]) entry.resolve({ cancelled: true });
	}

	/** 清空该 session 全部 ask 条目（含断开保留的 disconnected）。一轮对话结束（agent_settled）用。 */
	clearSession(sessionId: string): void {
		const inner = this.bySession.get(sessionId);
		if (!inner) return;
		this.bySession.delete(sessionId);
		for (const entry of inner.values()) {
			entry.onAbort = () => {}; // 解除监听引用
			if (!entry.done) {
				entry.done = true;
				entry.resolve({ cancelled: true }); // 残留 pending 也一并解决，避免 runAskTool 永久阻塞
			}
		}
	}

	/** 测试用：清空全部状态。 */
	reset(): void {
		for (const inner of this.bySession.values()) {
			for (const e of inner.values()) e.onAbort = () => {}; // 解除监听引用
		}
		this.bySession.clear();
	}

	private remove(sessionId: string, toolCallId: string): void {
		const inner = this.bySession.get(sessionId);
		if (!inner) return;
		inner.delete(toolCallId);
		if (inner.size === 0) this.bySession.delete(sessionId);
	}
}

/** 进程级单例。ask-tool / ws-server / agent-manager 共用同一实例。 */
export const askRegistry = new AskRegistry();
