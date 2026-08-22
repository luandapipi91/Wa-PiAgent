import { create } from "zustand";
import type { AttachmentDraft, ThinkingLevel } from "@wa-pi/shared";
import { isModelAvailable, type ModelProvider } from "@wa-pi/shared";
import {
	getDefaults,
	getNewSessionIds,
	getSessionPrefs,
	setDefaults,
	setNewSessionIds,
	setSessionPrefs as dbSetSessionPrefs,
	deleteSessionPrefs,
} from "./composer-db";

// Hydration guard：标记 defaults 是否已从持久层加载。
// store 初始内存态 thinking="disabled"，而 loadDefaults 是异步的——若在其完成前
// 触发 setDefaults/setSessionPrefs（如用户改 model、附件 auto-select），会拿初始 disabled
// 当"当前 defaults"写回 localStorage，覆盖用户上次存的 high/max。这是"重启后思考强度变 disabled"的根因。
// 守卫：未 hydrate 前持久化函数只更新内存、不写回；hydrate 后恢复正常持久化。
let defaultsHydrated = false;

/** 测试专用：重置 hydration 标志（模拟软件重启后尚未 loadDefaults 的状态） */
export function _resetDefaultsHydration(): void {
	defaultsHydrated = false;
}

// 每个 session 的 loadSession 完成状态跟踪（hydration guard 的会话级版本）：
// loadSession 是异步的，且 React 子组件 effect 先于父组件执行——ModelSelector 的
// auto-select 甚至早于 loadSession 被调用。此时 setSessionPrefs 若直写 IDB，会用
// attachments:[] 等初始值覆写已存记录；随后 loadSession 的 existing 守卫整体跳过恢复
// → 附件/thinking 永久丢失（reload 后片段附件消失的根因）。
// 守卫：会话完成首次 loadSession 前，写入只更新内存并记录显式字段，不写 IDB；
// loadSession 完成时按字段合并（显式字段胜出、其余以持久层为准）后统一持久化。
// 前提是每个会话路径都先走 loadSession——Composer 与 NewSessionPane 挂载时均会调用。
const loadedSessions = new Set<string>();
const gapWrites = new Map<string, Partial<SessionPrefs>>();

/** 测试专用：重置会话级 hydration 状态 */
export function _resetSessionHydration(): void {
	loadedSessions.clear();
	gapWrites.clear();
}

export interface SessionPrefs {
	model: string | null;
	// thinking 可选：undefined 表示用户未在此会话显式设置过，组件读取时回退到 defaults.thinking
	thinking?: ThinkingLevel;
	attachments: AttachmentDraft[];
	text?: string; // 未发送的输入框草稿；缺省/空串 = 无草稿
}

interface ComposerPrefsState {
	defaults: { model: string | null; thinking: ThinkingLevel };
	bySession: Record<string, SessionPrefs>;
	/** 会话 prefs 是否已从持久层加载完（Composer 据此门控 ModelSelector auto-select） */
	loadedBySession: Record<string, boolean>;
	newSessionIds: Record<string, string>;
	loadDefaults: () => Promise<void>;
	loadSession: (sessionId: string) => Promise<void>;
	setSessionPrefs: (sessionId: string, prefs: Partial<SessionPrefs>) => void;
	removeSessionPrefs: (sessionId: string) => void;
	setDefaults: (
		prefs: Partial<{ model: string | null; thinking: ThinkingLevel }>,
	) => void;
	setNewSessionId: (key: string, id: string) => void;
	clearNewSessionId: (key: string) => void;
	/** 清除指向已不存在模型的悬空引用（provider 保存/删除后调用） */
	clearStaleModels: (providers: ModelProvider[]) => void;
}

export const useComposerPrefsStore = create<ComposerPrefsState>((set) => ({
	defaults: { model: null, thinking: "disabled" },
	bySession: {},
	loadedBySession: {},
	newSessionIds: {},

	loadDefaults: async () => {
		const [defs, ids] = await Promise.all([getDefaults(), getNewSessionIds()]);
		set((s) => {
			const next: Partial<ComposerPrefsState> = {};
			// localStorage 是 model 的权威来源（用户上次显式选择并持久化）；
			// 仅当持久层无值（用户从未选过）时，才用内存值兜底——
			// 这通常发生在 NewSessionPane 挂载早期、ModelSelector 因 value=null 触发 auto-select
			// 把内存 model 设成"第一个模型"时：此时若 localStorage 有真实值必须优先恢复，
			// 否则会被 auto-select 抢先污染（重启后模型被重置为第一个的根因）。
			next.defaults = {
				model: defs.model ?? s.defaults.model,
				thinking: defs.thinking,
			};
			const changed =
				Object.keys(ids).length !== Object.keys(s.newSessionIds).length ||
				Object.entries(ids).some(([k, v]) => s.newSessionIds[k] !== v);
			if (changed) next.newSessionIds = ids;
			return next as ComposerPrefsState;
		});
		defaultsHydrated = true; // 已从持久层恢复 defaults，后续写入可安全持久化
	},

	loadSession: async (sessionId) => {
		const defaults = await getDefaults();
		const stored = await getSessionPrefs(sessionId);
		set((s) => {
			// 加载完成标记：无论走哪个分支都要置位（Composer 门控 auto-select 的依据）
			const loaded = {
				loadedBySession: { ...s.loadedBySession, [sessionId]: true },
			};
			const gap = gapWrites.get(sessionId);
			gapWrites.delete(sessionId);
			loadedSessions.add(sessionId);
			// 异步 gap 期间 setSessionPrefs 可能已设置值（如 auto-select），不要整体覆盖；
			// 改为按字段合并：gap 内显式修改的字段胜出，未触碰的字段以持久层为准恢复
			const existing = s.bySession[sessionId];
			if (existing) {
				const merged: SessionPrefs = {
					model:
						gap?.model !== undefined
							? gap.model
							: (stored?.model ?? existing.model),
					thinking: gap?.thinking ?? stored?.thinking ?? existing.thinking,
					attachments:
						gap?.attachments ?? stored?.attachments ?? existing.attachments,
					text: gap?.text ?? stored?.text ?? existing.text,
				};
				// gap 写入被守卫拦下未落盘，这里把合并结果统一持久化
				void dbSetSessionPrefs({
					sessionId,
					model: merged.model,
					thinking: merged.thinking ?? defaults.thinking,
					attachments: merged.attachments,
					text: merged.text,
					updatedAt: Date.now(),
				});
				// 保留已有 prefs 的同时，若 defaults 加载延迟则一并更新
				const next: Partial<ComposerPrefsState> = {
					...loaded,
					bySession: { ...s.bySession, [sessionId]: merged },
				};
				if (s.defaults.model == null && defaults.model != null)
					next.defaults = defaults;
				return next as ComposerPrefsState;
			}
			const fresh: SessionPrefs = {
				model: stored?.model ?? s.defaults.model ?? defaults.model,
				// thinking 仅在用户显式设置过时才有值，否则保持 undefined
				// 组件读取时回退到 defaults.thinking（而非硬编码 disabled）
				...(stored?.thinking !== undefined
					? { thinking: stored.thinking }
					: {}),
				attachments: stored?.attachments ?? [],
				...(stored?.text !== undefined ? { text: stored.text } : {}),
			};
			const next: Partial<ComposerPrefsState> = {
				...loaded,
				bySession: { ...s.bySession, [sessionId]: fresh },
			};
			// 不用 T0 快照（开读时刻）无条件覆盖内存 defaults：getSessionPrefs 的 IDB 读取窗口内
			// 用户可能已改模型，整体覆盖会把它回滚——「切了模型再切回来，会话模型就变了」的根因。
			// 与 existing 分支同一守卫：仅内存 defaults 尚未加载（null，冷启动）时从持久层填充。
			if (s.defaults.model == null && defaults.model != null)
				next.defaults = defaults;
			return next as ComposerPrefsState;
		});
		defaultsHydrated = true; // loadSession 内部也读了 defaults，同样标记 hydrate 完成
	},

	setSessionPrefs: (sessionId, prefs) => {
		set((s) => {
			const current = s.bySession[sessionId] ?? {
				model: s.defaults.model,
				thinking: s.defaults.thinking,
				attachments: [],
			};
			const next = { ...current, ...prefs };
			if (!loadedSessions.has(sessionId)) {
				// 会话尚未完成首次 loadSession：只更新内存并记录显式修改的字段，不写 IDB——
				// 防止用初始值（attachments:[] 等）覆写已存记录，由 loadSession 合并后统一持久化
				gapWrites.set(sessionId, { ...gapWrites.get(sessionId), ...prefs });
			} else {
				void dbSetSessionPrefs({
					sessionId,
					...next,
					thinking: next.thinking ?? s.defaults.thinking,
					updatedAt: Date.now(),
				});
			}
			// 仅把用户本次显式修改的字段（prefs 参数）同步到全局 defaults，
			// 而非用整个 session prefs 覆盖——否则切到老会话改 model 时，
			// 会把老会话的 thinking（可能为 disabled）误写进 defaults，污染新会话默认值。
			const newDefaults = { ...s.defaults };
			if (prefs.model !== undefined) newDefaults.model = prefs.model;
			if (prefs.thinking !== undefined) newDefaults.thinking = prefs.thinking;
			// hydration guard：未从持久层加载 defaults 前，s.defaults.thinking 还是初始 disabled，
			// 此时写回会用 disabled 覆盖用户上次存的高强度档位（重启后思考强度被重置的根因）
			if (defaultsHydrated) void setDefaults(newDefaults);
			return {
				bySession: { ...s.bySession, [sessionId]: next },
				defaults: newDefaults,
			};
		});
	},

	removeSessionPrefs: (sessionId) => {
		// 清理 hydration 守卫的会话级跟踪，避免同一 id 复用时旧状态残留
		loadedSessions.delete(sessionId);
		gapWrites.delete(sessionId);
		void deleteSessionPrefs(sessionId);
		set((s) => {
			const bySession = { ...s.bySession };
			delete bySession[sessionId];
			const loadedBySession = { ...s.loadedBySession };
			delete loadedBySession[sessionId];
			return { bySession, loadedBySession };
		});
	},

	setDefaults: (prefs) => {
		set((s) => {
			const next = { ...s.defaults, ...prefs };
			if (defaultsHydrated) void setDefaults(next);
			return { defaults: next };
		});
	},

	setNewSessionId: (key, id) => {
		set((s) => {
			if (s.newSessionIds[key] === id) return s;
			const next = { ...s.newSessionIds, [key]: id };
			// hydration guard：未从持久层加载 defaults 前，s.newSessionIds 还是初始 {}，
			// 此时直写会用 NewSessionPane 挂载生成的随机 id 覆盖 localStorage 里上次持久化的映射
			// （冷启动竞态：setNewSessionId 先于 loadDefaults 完成 → 刷新后旧草稿会话 id 永久丢失）。
			// 未 hydrate 时只更新内存，由 loadDefaults 读回持久化映射后纠正；
			// hydrate 后（loadDefaults 完成、读到持久化旧映射）正常落盘。
			if (defaultsHydrated) void setNewSessionIds(next);
			return { newSessionIds: next };
		});
	},
	clearNewSessionId: (key) => {
		set((s) => {
			if (!(key in s.newSessionIds)) return s;
			const next = { ...s.newSessionIds };
			delete next[key];
			// 与 setNewSessionId 一致的 hydration guard：未 hydrate 前不落盘，避免覆盖持久化映射
			if (defaultsHydrated) void setNewSessionIds(next);
			return { newSessionIds: next };
		});
	},

	// 清除悬空模型引用：provider 保存/删除（尤其改 model id）后，composer-prefs 里存的是
	// "slug/旧id" 字符串快照，而 providers 已变成 "slug/新id"——isModelAvailable 变 false，
	// 发送按钮静默置灰（或 ModelSelector 无法重钉）。此处把失效的会话级 + 默认模型引用清为 null，
	// 让用户看到「未选择模型」占位并主动重选，而非一头雾水地卡在置灰。
	clearStaleModels: (providers) => {
		set((s) => {
			const nextBySession: Record<string, SessionPrefs> = {};
			let bySessionChanged = false;
			for (const [sid, prefs] of Object.entries(s.bySession)) {
				if (
					prefs.model != null &&
					!isModelAvailable(prefs.model, providers)
				) {
					bySessionChanged = true;
					nextBySession[sid] = { ...prefs, model: null };
					if (loadedSessions.has(sid)) {
						void dbSetSessionPrefs({
							sessionId: sid,
							model: null,
							thinking: prefs.thinking ?? s.defaults.thinking,
							attachments: prefs.attachments,
							text: prefs.text,
							updatedAt: Date.now(),
						});
					}
				} else {
					nextBySession[sid] = prefs;
				}
			}
			const defaultsChanged =
				s.defaults.model != null &&
				!isModelAvailable(s.defaults.model, providers);
			const nextDefaults = defaultsChanged
				? { ...s.defaults, model: null }
				: s.defaults;
			if (defaultsChanged && defaultsHydrated) void setDefaults(nextDefaults);
			return {
				bySession: bySessionChanged ? nextBySession : s.bySession,
				defaults: nextDefaults,
			};
		});
	},
}));
