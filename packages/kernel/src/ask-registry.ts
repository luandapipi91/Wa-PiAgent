// AskRegistry：ask_user_question 工具的阻塞/解决注册表（进程级单例）。
//
// 工具 execute 在此 await ask()，agent 回合阻塞；前端 agent:answer 经 ws-server
// 调 resolve()，agent:cancel-ask / abort / immediate / dispose 调 cancel()/cancelAll()。
// 不设硬超时——等用户回答或中断。所有 resolve/cancel 对未知/已解决 id 幂等。
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
}

export class AskRegistry {
	private bySession = new Map<string, Map<string, Entry>>();

	/** 注册一个 pending 提问并返回阻塞 promise。signal abort 时以 cancelled 解决。 */
	ask(
		sessionId: string,
		toolCallId: string,
		params: AskParams,
		signal: AbortSignal,
	): Promise<AskOutcome> {
		const entry: Entry = {
			params,
			resolve: () => {},
			onAbort: () => {},
			done: false,
		};
		const promise = new Promise<AskOutcome>((resolve) => {
			entry.resolve = (o) => {
				if (entry.done) return;
				entry.done = true;
				this.remove(sessionId, toolCallId);
				resolve(o);
			};
			entry.onAbort = () => entry.resolve({ cancelled: true });
		});
		// 先插入 entry 到 map，再检查 signal.aborted：否则预 aborted 时 resolve() 触发的
		// remove() 是 no-op（entry 尚未插入），会把一个 done:true 的 entry 永久留在 map 里。
		let inner = this.bySession.get(sessionId);
		if (!inner) {
			inner = new Map();
			this.bySession.set(sessionId, inner);
		}
		inner.set(toolCallId, entry);

		if (signal.aborted) entry.resolve({ cancelled: true });
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

	/** 该 session 当前真实 pending 的 toolCallId 列表（前端 double check 用）。 */
	pendingToolCallIds(sessionId: string): string[] {
		const inner = this.bySession.get(sessionId);
		return inner ? [...inner.keys()] : [];
	}

	/** 取消该 session 全部 pending（abort / immediate / dispose 用）。其它 session 不受影响。 */
	cancelAll(sessionId: string): void {
		const inner = this.bySession.get(sessionId);
		if (!inner) return;
		for (const entry of [...inner.values()]) entry.resolve({ cancelled: true });
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
