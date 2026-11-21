import { create } from "zustand";
import type { AttachmentDraft, ThinkingLevel } from "@wa-pi/shared";
import {
	isModelAvailable,
	normalizeThinkingLevel,
	type ModelProvider,
} from "@wa-pi/shared";
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
// store 初始内存态是空模型表（thinkingByModel: {}），而 loadDefaults 是异步的——若在其完成前
// 触发 setDefaults/setSessionPrefs（如用户改 model、附件 auto-select），会拿这张空表
// 当"当前 defaults"写回 localStorage，覆盖用户上次存的模型档位记录。这是"重启后思考强度被重置"的根因。
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
/** gap 期「换模型且档位是推断值」的会话：loadSession 合并时须按新模型重算档位，
 *  不得把持久层里属于旧模型的 thinking 沿用到新模型（见 setSessionModel 注释）。 */
const gapWrites_inferredModel = new Set<string>();

/** 测试专用：重置会话级 hydration 状态 */
export function _resetSessionHydration(): void {
	loadedSessions.clear();
	gapWrites.clear();
	gapWrites_inferredModel.clear();
}

export interface SessionPrefs {
	model: string | null;
	// thinking 可选：undefined 表示用户未在此会话显式设置过，组件读取时用 resolveThinking()
	// 先按模型记录、再按会话值、最后回退 "default"
	thinking?: ThinkingLevel;
	attachments: AttachmentDraft[];
	text?: string; // 未发送的输入框草稿；缺省/空串 = 无草稿
}

/** 全局默认偏好：模型 + 按模型存思考档（key = "providerSlug/modelId"） */
export interface DefaultsState {
	model: string | null;
	thinkingByModel: Record<string, ThinkingLevel>;
}

/**
 * 切换模型时该模型应落到的档位：有记录用记录，否则 default。
 * 刻意不回退会话旧值——否则「切到一个从没设过的模型」会沿用上一个模型的档位，
 * 违反「按模型保存」的语义。
 */
export function thinkingForModel(
	model: string | null,
	thinkingByModel: Record<string, ThinkingLevel> | undefined,
): ThinkingLevel {
	if (!model) return "default";
	return thinkingByModel?.[model] ?? "default";
}

/**
 * 渲染时选择器显示什么：模型记录 → 会话值 → default。
 * 回退会话值是给「老数据 + 首次进入不切模型」留的兼容路径：
 * 升级后模型表为空，但老会话的 IndexedDB 里可能还存着自己的 thinking。
 */
export function resolveThinking(
	model: string | null,
	sessionThinking: ThinkingLevel | undefined,
	thinkingByModel: Record<string, ThinkingLevel> | undefined,
): ThinkingLevel {
	const byModel = model ? thinkingByModel?.[model] : undefined;
	return byModel ?? sessionThinking ?? "default";
}

interface ComposerPrefsState {
	defaults: DefaultsState;
	bySession: Record<string, SessionPrefs>;
	/** 会话 prefs 是否已从持久层加载完（Composer 据此门控 ModelSelector auto-select） */
	loadedBySession: Record<string, boolean>;
	newSessionIds: Record<string, string>;
	loadDefaults: () => Promise<void>;
	loadSession: (sessionId: string) => Promise<void>;
	setSessionPrefs: (
		sessionId: string,
		prefs: Partial<SessionPrefs>,
		opts?: {
			syncDefaults?: boolean;
			/** prefs.thinking 是「按模型推断出来的值」而非用户显式选择：
			 *  gap 期不得把它当显式字段记进 gapWrites（否则会压过持久层里该会话的真实值）。 */
			inferredThinking?: boolean;
		},
	) => void;
	/** 程序化初始化会话模型（IM 接入会话进入时同步机器人模型用）：
	 * 仅当该会话在持久层尚无显式模型记录时写入（不覆盖用户手动选择），
	 * 且不回写全局 defaults（区别于用户手动 setSessionPrefs）。 */
	initSessionModel: (sessionId: string, model: string | null) => Promise<void>;
	removeSessionPrefs: (sessionId: string) => void;
	setDefaults: (
		prefs: Partial<{
			model: string | null;
			thinkingByModel: Record<string, ThinkingLevel>;
		}>,
	) => void;
	/** 切换会话模型：同时把该会话的思考档重算为「新模型的记录」（无记录即 default）。
	 * 这是「按模型保存思考强度」的核心入口——所有切模型路径都应走它。 */
	setSessionModel: (sessionId: string, model: string | null) => void;
	setNewSessionId: (key: string, id: string) => void;
	clearNewSessionId: (key: string) => void;
	/** 清除指向已不存在模型的悬空引用（provider 保存/删除后调用） */
	clearStaleModels: (providers: ModelProvider[]) => void;
}

export const useComposerPrefsStore = create<ComposerPrefsState>((set, get) => ({
	defaults: { model: null, thinkingByModel: {} },
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
			// thinkingByModel 同理：持久层优先，并用内存里已写的记录补上（用户刚改的不能丢）。
			next.defaults = {
				model: defs.model ?? s.defaults.model,
				thinkingByModel: {
					...defs.thinkingByModel,
					...s.defaults.thinkingByModel,
				},
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
			const inferredModelInGap = gapWrites_inferredModel.delete(sessionId);
			loadedSessions.add(sessionId);
			// 异步 gap 期间 setSessionPrefs 可能已设置值（如 auto-select），不要整体覆盖；
			// 改为按字段合并：gap 内显式修改的字段胜出，未触碰的字段以持久层为准恢复
			const existing = s.bySession[sessionId];
			if (existing) {
				const mergedModel =
					gap?.model === undefined ? (stored?.model ?? existing.model) : gap.model;
				// gap 期换了模型但没带档位（推断值被 inferredThinking 挡在 gap 外）：
				// 此时 stored.thinking 属于「旧模型」，不能沿用到新模型上——按新模型记录重算。
				const modelChangedInGap =
					inferredModelInGap && gap?.model !== undefined;
				const merged: SessionPrefs = {
					model: mergedModel,
					thinking: modelChangedInGap
						? thinkingForModel(mergedModel, defaults.thinkingByModel)
						: (gap?.thinking ??
							(stored?.thinking === undefined
								? undefined
								: normalizeThinkingLevel(stored.thinking)) ??
							existing.thinking),
					attachments:
						gap?.attachments ?? stored?.attachments ?? existing.attachments,
					text: gap?.text ?? stored?.text ?? existing.text,
				};
				// gap 写入被守卫拦下未落盘，这里把合并结果统一持久化。
				// 会话记录的 thinking 字段是结构性必填（ThinkingLevel），会话未显式设置时
				// 落一个占位值即可——真正的显示值由 resolveThinking() 按模型记录算出。
				void dbSetSessionPrefs({
					sessionId,
					model: merged.model,
					thinking:
						merged.thinking ??
						thinkingForModel(merged.model, defaults.thinkingByModel),
					attachments: merged.attachments,
					text: merged.text,
					updatedAt: Date.now(),
				});
				// 保留已有 prefs 的同时，若 defaults 加载延迟则一并更新
				const next: Partial<ComposerPrefsState> = {
					...loaded,
					bySession: { ...s.bySession, [sessionId]: merged },
				};
				// 字段级合并（与 loadDefaults 同口径）：只补 model，thinkingByModel 走合并，
				// 避免用 T0 快照整块冲掉内存里用户刚写入的模型记录。
				if (s.defaults.model == null && defaults.model != null)
					next.defaults = {
						model: defaults.model,
						thinkingByModel: {
							...defaults.thinkingByModel,
							...s.defaults.thinkingByModel,
						},
					};
				return next as ComposerPrefsState;
			}
			const fresh: SessionPrefs = {
				model: stored?.model ?? s.defaults.model ?? defaults.model,
				// thinking 仅在用户显式设置过时才有值，否则保持 undefined
				// 组件读取时用 resolveThinking() 先按模型记录、再按会话值、最后回退 default
				...(stored?.thinking === undefined
					? {}
					: { thinking: normalizeThinkingLevel(stored.thinking) }),
				attachments: stored?.attachments ?? [],
				...(stored?.text === undefined ? {} : { text: stored.text }),
			};
			const next: Partial<ComposerPrefsState> = {
				...loaded,
				bySession: { ...s.bySession, [sessionId]: fresh },
			};
			// 不用 T0 快照（开读时刻）无条件覆盖内存 defaults：getSessionPrefs 的 IDB 读取窗口内
			// 用户可能已改模型，整体覆盖会把它回滚——「切了模型再切回来，会话模型就变了」的根因。
			// 与 existing 分支同一守卫：仅内存 defaults 尚未加载（null，冷启动）时从持久层填充。
			// 字段级合并（与 loadDefaults 同口径）：只补 model，thinkingByModel 走合并，
			// 避免用 T0 快照整块冲掉内存里用户刚写入的模型记录。
			if (s.defaults.model == null && defaults.model != null)
				next.defaults = {
					model: defaults.model,
					thinkingByModel: {
						...defaults.thinkingByModel,
						...s.defaults.thinkingByModel,
					},
				};
			return next as ComposerPrefsState;
		});
		defaultsHydrated = true; // loadSession 内部也读了 defaults，同样标记 hydrate 完成
	},

	setSessionPrefs: (sessionId, prefs, opts) => {
		set((s) => {
			const current = s.bySession[sessionId] ?? {
				model: s.defaults.model,
				// 未显式设置时不下发 thinking（保持 undefined），显示值由 resolveThinking 计算
				attachments: [],
			};
			const next = { ...current, ...prefs };
			if (loadedSessions.has(sessionId)) {
				void dbSetSessionPrefs({
					sessionId,
					...next,
					// 会话记录 thinking 是结构性必填；未显式设置时按当前模型的记录算（通常是 default）
					thinking:
						next.thinking ??
						thinkingForModel(next.model, s.defaults.thinkingByModel),
					updatedAt: Date.now(),
				});
			} else {
				// 会话尚未完成首次 loadSession：只更新内存并记录显式修改的字段，不写 IDB——
				// 防止用初始值（attachments:[] 等）覆写已存记录，由 loadSession 合并后统一持久化。
				// inferredThinking：切模型时算出的档位不是用户选择，不能进 gap（否则会压过
				// 持久层里该会话的真实 thinking，把「推断」固化成「用户意图」）。
				const gap = { ...gapWrites.get(sessionId), ...prefs };
				if (opts?.inferredThinking) {
					delete gap.thinking;
					// 标记「本次换模型的档位是推断出来的」：loadSession 合并时要按新模型重算，
					// 而不是把持久层里属于旧模型的 thinking 沿用到新模型上。
					gapWrites_inferredModel.add(sessionId);
				}
				gapWrites.set(sessionId, gap);
			}
			// 仅把用户本次显式修改的字段（prefs 参数）同步到全局 defaults，
			// 而非用整个 session prefs 覆盖——否则切到老会话改 model 时，
			// 会把老会话的 thinking 误写进 defaults，污染其他会话。
			// 程序化写入（syncDefaults:false，如 IM 会话同步机器人模型）不回写全局。
			const newDefaults: DefaultsState = { ...s.defaults };
			if (opts?.syncDefaults !== false) {
				if (prefs.model !== undefined) newDefaults.model = prefs.model;
				if (prefs.thinking !== undefined) {
					// 记到「本次操作后的模型」名下：同时给了 model 就用新模型，
					// 否则用会话当前模型。当前模型为 null 时无归属，只记会话不记模型表。
					const targetModel =
						prefs.model !== undefined ? prefs.model : current.model;
					if (targetModel) {
						newDefaults.thinkingByModel = {
							...newDefaults.thinkingByModel,
							[targetModel]: prefs.thinking,
						};
					}
				}
			}
			// hydration guard：未从持久层加载 defaults 前，内存态是空的模型表，
			// 此时写回会用空表覆盖用户上次存的模型记录（重启后思考强度被重置的根因）
			if (defaultsHydrated) void setDefaults(newDefaults);
			return {
				bySession: { ...s.bySession, [sessionId]: next },
				defaults: newDefaults,
			};
		});
	},

	setSessionModel: (sessionId, model) => {
		// 切模型 = 换一套档位：按目标模型的记录取值，无记录即 default。
		// 刻意不回退会话旧值（见 thinkingForModel 注释）。
		//
		// 关键：这里推断出的档位**只写会话，不写 thinkingByModel**——
		// 它不是用户的选择，而是「该模型当前是什么档」的查询结果。若把它当成用户选择写进
		// 模型表，auto-select（ModelSelector 自动选第一个模型）就会替所有模型创建 default
		// 记录，进而在 loadDefaults 合并时用内存值盖掉持久层里的真实记录
		// （实测：持久层 high 被 auto-select 的 default 覆盖）。
		// 因此走 setSessionPrefs 时用 syncDefaults:false，再单独把 model 同步给 defaults。
		get().setSessionPrefs(
			sessionId,
			{
				model,
				thinking: thinkingForModel(model, get().defaults.thinkingByModel),
			},
			{ syncDefaults: false, inferredThinking: true },
		);
		set((s) => {
			if (s.defaults.model === model) return s;
			const next: DefaultsState = { ...s.defaults, model };
			if (defaultsHydrated) void setDefaults(next);
			return { defaults: next };
		});
	},

	initSessionModel: async (sessionId, model) => {
		if (!model) return;
		// 已有显式模型记录（用户改过/已同步过）不覆盖：保持「会话记住自己的模型」语义
		const stored = await getSessionPrefs(sessionId);
		if (stored?.model) return;
		// 与 setSessionModel 同口径：换模型必须重算会话的思考档。
		// 否则 IM 会话同步成机器人模型后，会话仍带着旧模型时期留下的 thinking，
		// resolveThinking 在「新模型无记录」时会把这个旧值显示出来——
		// 恰好违反「切到没设置过的模型应显示默认」这条核心语义。
		// 区别仅在 syncDefaults：程序化写入不得污染全局默认模型。
		get().setSessionPrefs(
			sessionId,
			{
				model,
				thinking: thinkingForModel(model, get().defaults.thinkingByModel),
			},
			{ syncDefaults: false, inferredThinking: true },
		);
	},

	removeSessionPrefs: (sessionId) => {
		// 清理 hydration 守卫的会话级跟踪，避免同一 id 复用时旧状态残留
		loadedSessions.delete(sessionId);
		gapWrites.delete(sessionId);
		gapWrites_inferredModel.delete(sessionId);
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
			// thinkingByModel 是对象：必须浅合并而不能整块覆盖，
			// 否则只改一个模型的记录会把其他模型的记录全冲掉。
			const next: DefaultsState = {
				...s.defaults,
				...prefs,
				thinkingByModel: prefs.thinkingByModel
					? { ...s.defaults.thinkingByModel, ...prefs.thinkingByModel }
					: s.defaults.thinkingByModel,
			};
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
				if (prefs.model != null && !isModelAvailable(prefs.model, providers)) {
					bySessionChanged = true;
					nextBySession[sid] = { ...prefs, model: null };
					if (loadedSessions.has(sid)) {
						void dbSetSessionPrefs({
							sessionId: sid,
							model: null,
							// 模型已失效：会话记录落一个占位值，显示值由 resolveThinking 算（模型为 null → default）
							thinking: prefs.thinking ?? "default",
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
				s.defaults.model != null && !isModelAvailable(s.defaults.model, providers);
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
