// knowledge.ts — 知识库列表全局状态（任务 B2）
//
// 数据来源：
//   · REST：GET /api/knowledge（回包为 kernel callApi 完整事件 { type: "knowledge:list", kbs }）
//   · SSE：knowledge:progress（kernel 索引管线逐帧广播，按 kbId 过滤）
// kernel 的 knowledge 域没有 mcp:changed 类的清单广播 → 写操作成功后就地更新本地状态。
import { create } from "zustand";
import type { KbDoctorReport, KbInfo, KbProgressEvent } from "@wa-pi/shared";
import { api } from "../api-client";
import { formatApiError } from "../util/kernel-error";
import { useToastStore } from "./toast";
import { onEventType } from "../events";

/** rerank 开关与模型状态（与 GET /api/knowledge/rerank 回包一致） */
export interface RerankState {
  enabled: boolean;
  status: "idle" | "downloading" | "ready" | "failed";
  model: string;
  progress?: number;
  error?: string;
}

interface KnowledgeState {
  kbs: KbInfo[];
  loading: boolean;
  /**
   * 清单是否成功加载过（B5 审查修复）：false = 未知态（未拉取/拉取中/失败）。
   * 消费方（AgentConfig 保存链路）据此区分「清单已知为空」与「清单未知」——
   * 未知态不得把绑定过滤成空（那会静默清空既有绑定）。
   */
  loaded: boolean;
  /**
   * 最近一次清单拉取的错误文案（null = 无错误，B-hardening S9）。
   * 失败 ≠ 空清单：页面据此区分「拉取失败（未知态）」与「已知为空」，
   * 否则 kernel 未启动时会误报「暂无知识库」（用户会去重复登记）。
   */
  error: string | null;
  /**
   * 各库最新索引进度（按 kbId 键控）。列表回包自带的 kb.progress 也会 seed 进来
   * （刷新页面后 SSE 事件流尚未推帧时，徽章仍有进度可渲染）；索引到终态（ready/error）清除。
   */
  progress: Record<string, KbProgressEvent>;
  /** 拉取知识库清单（KnowledgePage mount 时调用） */
  listKbs(): void;
  /** 删除登记库（kernel 会级联清理 job 行/每库 db/悬挂绑定）；失败弹 toast */
  deleteKb(id: string): Promise<void>;
  /** 更新自动更新开关（PUT autoWatch）；失败弹 toast，成功就地改本地 */
  setAutoWatch(id: string, on: boolean): Promise<void>;
  /** 取消进行中的索引（POST cancel）；失败弹 toast，成功 refetch 对齐 kernel 快照 */
  cancelIndex(id: string): Promise<void>;
  /** 重建索引（POST :id/index）；已有进行中任务的 400 也弹 toast，成功 refetch 清单切「索引中」 */
  reindex(id: string): Promise<void>;
  /** rerank 开关与模型状态（设置页展示用） */
  rerank: RerankState;
  /** 写 rerank 状态（load/save/retry 共用） */
  setRerank(next: RerankState): void;
  /** 拉取 rerank 状态 */
  loadRerank(): void;
  /** 保存 rerank 开关（开启即触发后台下载模型） */
  setRerankEnabled(enabled: boolean): Promise<void>;
  /** 重试下载 */
  retryRerank(): Promise<void>;
  /** 全库体检报告（诊断弹窗） */
  doctor: KbDoctorReport | null;
  /** 体检请求进行中（重新诊断的可见反馈：按钮禁用 + 内容置灰） */
  doctorLoading: boolean;
  /** 最近一次体检完成时间（毫秒）；每次重新诊断都会刷新，用来证明「确实跑过一轮」 */
  doctorUpdatedAt: number | null;
  /** 拉取体检报告 */
  loadDoctor(): Promise<void>;
  /** 处理 knowledge:progress：维护 progress map 并同步对应库的 status/progress */
  applyProgress(e: KbProgressEvent): void;
}

/**
 * 清单请求序号（模块级，B-hardening S10）：每次 listKbs 自增并把自己那一号记下来，
 * 回包时序号已过期就直接丢弃——并发拉取（挂载拉取 + SSE 终态补拉 + 重试）时，
 * 晚到的旧回包不得把新回包的状态（库已删/索引已完成/计数已更新）覆盖回去。
 * 写操作（删除/改开关）成功落地时会 bump 本号，作废在途回包。
 */
let listSeq = 0;

/**
 * 最近一次成功落地（写入 kbs）的请求号；0 = 从未有过可用清单。
 * 两个用途：
 *   1. 过期成功回包：已有清单时才丢弃（S10）；一份都没有时，任何成功回包都比空状态有用
 *      （否则「先发的成功回包被丢弃 + 后发的失败」会让界面误报「加载失败」，实际数据刚到手）。
 *   2. 写操作落地时同步抬高（与 listSeq 对齐），保证早于本次写入的在途回包一律作废。
 */
let appliedSeq = 0;

/**
 * 终态帧触发的清单刷新（模块级节流）：fileCount/chunkCount/failedCount/lastIndexedAt
 * 只存在于清单回包，SSE 终态帧只带 status——不补拉的话卡片会长期停在创建时的 0 文件/0 块，
 * 失败文件徽章也永不出现（失败清单入口等于不存在）。同一轮多个终态帧合并成一次。
 */
let terminalRefreshTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleListRefresh(): void {
  if (terminalRefreshTimer) return;
  terminalRefreshTimer = setTimeout(() => {
    terminalRefreshTimer = null;
    useKnowledgeStore.getState().listKbs();
  }, 0);
}

export const useKnowledgeStore = create<KnowledgeState>((set) => ({
  kbs: [],
  rerank: { enabled: false, status: "idle", model: "" },
  doctor: null,
  doctorLoading: false,
  doctorUpdatedAt: null,
  loading: false,
  loaded: false,
  error: null,
  progress: {},

  listKbs: () => {
    // 先领号再发请求：只有最新一号的回包有权写状态
    const seq = ++listSeq;
    set({ loading: true });
    api
      .get("/api/knowledge")
      .then((data: any) => {
        // 已有清单时，过期回包丢弃（不让旧数据覆盖新数据）；
        // 尚无任何清单时不丢——一份可用数据总比空状态强（否则会误报加载失败）
        if (seq !== listSeq && appliedSeq !== 0) return;
        appliedSeq = seq;
        // kernel 回包是 { type, kbs }；容忍裸数组与空对象（测试 mock 返回 {} 时落空列表）
        const kbs: KbInfo[] = Array.isArray(data) ? data : (data?.kbs ?? []);
        // 回包自带的进行中进度 seed 进 map，徽章刷新前就有进度可显示
        const progress: Record<string, KbProgressEvent> = {};
        for (const kb of kbs) {
          if (kb.progress) {
            progress[kb.id] = {
              type: "knowledge:progress",
              kbId: kb.id,
              phase: kb.progress.phase,
              filesTotal: kb.progress.filesTotal,
              filesDone: kb.progress.filesDone,
              chunksDone: kb.progress.chunksDone,
              chunksTotal: kb.progress.chunksTotal ?? 0,
              status: kb.status,
            };
          }
        }
        set({ kbs, progress, loading: false, loaded: true, error: null });
      })
      .catch((e) => {
        if (seq !== listSeq) return; // 过期回包的失败不得改写最新状态
        // 失败不改写 loaded（保持原值）：从未成功过 = 未知态，页面整页「加载失败 + 重试」；
        // 已成功过 = 列表继续展示，error 只驱动列表上方的刷新失败弱提示（静默比误报更糟）
        set({ loading: false, error: formatApiError(e) });
      });
  },

  deleteKb: async (id) => {
    try {
      await api.del(`/api/knowledge/${encodeURIComponent(id)}`);
    } catch (e) {
      // 删除失败不能静默（登记还在，界面刷新后仍在）
      useToastStore.getState().add(formatApiError(e), "error");
      return;
    }
    // kernel 无 knowledge 域 changed 广播：删除成功就地移除（含进度残留）；
    // 同时作废在途清单回包（否则刚删的库会被旧回包加回来）
    listSeq += 1;
    appliedSeq = listSeq;
    set((s) => {
      const progress = { ...s.progress };
      delete progress[id];
      return { kbs: s.kbs.filter((k) => k.id !== id), progress, loading: false };
    });
  },

  setAutoWatch: async (id, on) => {
    try {
      await api.put(`/api/knowledge/${encodeURIComponent(id)}`, { autoWatch: on });
    } catch (e) {
      useToastStore.getState().add(formatApiError(e), "error");
      return;
    }
    // PUT 成功即事实，就地改本地（kernel 无清单广播）；同理作废在途回包
    listSeq += 1;
    appliedSeq = listSeq;
    set((s) => ({
      kbs: s.kbs.map((k) => (k.id === id ? { ...k, autoWatch: on } : k)),
      loading: false,
    }));
  },

  cancelIndex: async (id) => {
    try {
      await api.post(`/api/knowledge/${encodeURIComponent(id)}/cancel`);
    } catch (e) {
      // 取消失败不能静默（索引仍在跑，用户以为已停）
      useToastStore.getState().add(formatApiError(e), "error");
      return;
    }
    // kernel 即时返回当前快照，收尾恢复（恢复原状态/删 job 行）异步完成；终态经 SSE
    // 推帧为主，此处 refetch 兜底对齐快照（与 App.tsx 断连重连清单兜底同思路）
    useKnowledgeStore.getState().listKbs();
  },

  reindex: async (id) => {
    try {
      await api.post(`/api/knowledge/${encodeURIComponent(id)}/index`);
    } catch (e) {
      // 失败不能静默：含 kernel 防护的「已有进行中的索引任务」（重复索引 400），toast 提示即可
      useToastStore.getState().add(formatApiError(e), "error");
      return;
    }
    // POST 成功即已开任务；进度主走 SSE 推帧，此处 refetch 让状态立即切「索引中」
    useKnowledgeStore.getState().listKbs();
  },

  setRerank: (next) => set({ rerank: next }),

  loadRerank: () => {
    api
      .get("/api/knowledge/rerank")
      .then((data: any) => {
        useKnowledgeStore.getState().setRerank({
          enabled: data?.enabled === true,
          status: data?.status ?? "idle",
          model: data?.model ?? "",
          progress: typeof data?.progress === "number" ? data.progress : undefined,
          error: typeof data?.error === "string" ? data.error : undefined,
        });
      })
      .catch(() => {
        /* 状态拉取失败不打断页面 */
      });
  },

  setRerankEnabled: async (enabled) => {
    try {
      const data: any = await api.put("/api/knowledge/rerank", { enabled });
      useKnowledgeStore.getState().setRerank({
        enabled: data?.enabled === true,
        status: data?.status ?? "idle",
        model: data?.model ?? "",
        progress: typeof data?.progress === "number" ? data.progress : undefined,
        error: typeof data?.error === "string" ? data.error : undefined,
      });
    } catch (e) {
      useToastStore.getState().add(formatApiError(e), "error");
    }
  },

  retryRerank: async () => {
    try {
      const data: any = await api.post("/api/knowledge/rerank/retry");
      useKnowledgeStore.getState().setRerank({
        enabled: data?.enabled === true,
        status: data?.status ?? "idle",
        model: data?.model ?? "",
        progress: typeof data?.progress === "number" ? data.progress : undefined,
        error: typeof data?.error === "string" ? data.error : undefined,
      });
    } catch (e) {
      useToastStore.getState().add(formatApiError(e), "error");
    }
  },

  loadDoctor: async () => {
    set({ doctorLoading: true });
    try {
      const data: any = await api.get("/api/knowledge/doctor");
      set({ doctor: data?.report ?? null, doctorUpdatedAt: Date.now() });
    } catch (e) {
      useToastStore.getState().add(formatApiError(e), "error");
    } finally {
      // 成功失败都要复位，否则按钮会永久停在「诊断中」
      set({ doctorLoading: false });
    }
  },

  applyProgress: (e) => {
    const terminal = e.status === "ready" || e.status === "error";
    if (terminal) scheduleListRefresh(); // 计数/失败数只能从清单回包刷新
    set((s) => {
      const progress = { ...s.progress };
      if (terminal) delete progress[e.kbId];
      else progress[e.kbId] = e;
      return {
        progress,
        kbs: s.kbs.map((k) =>
          k.id === e.kbId
            ? {
                ...k,
                status: e.status,
                progress: terminal
                  ? undefined
                  : {
                      phase: e.phase,
                      filesTotal: e.filesTotal,
                      filesDone: e.filesDone,
                      chunksDone: e.chunksDone,
                      chunksTotal: e.chunksTotal ?? 0,
                    },
              }
            : k,
        ),
      };
    });
  },
}));

// 模块加载即订阅（onEventType 内部幂等建立 SSE 连接，照 share-progress.ts 模式；
// events.ts 的 typed handler map 原生支持新增事件类型，无需改它本体）
onEventType("knowledge:progress", (e) => {
  if ((e as KbProgressEvent).type !== "knowledge:progress") return;
  useKnowledgeStore.getState().applyProgress(e as KbProgressEvent);
});
