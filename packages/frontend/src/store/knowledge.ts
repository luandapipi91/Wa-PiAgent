// knowledge.ts — 知识库列表全局状态（任务 B2）
//
// 数据来源：
//   · REST：GET /api/knowledge（回包为 kernel callApi 完整事件 { type: "knowledge:list", kbs }）
//   · SSE：knowledge:progress（kernel 索引管线逐帧广播，按 kbId 过滤）
// kernel 的 knowledge 域没有 mcp:changed 类的清单广播 → 写操作成功后就地更新本地状态。
import { create } from "zustand";
import type { KbInfo, KbProgressEvent } from "@wa-pi/shared";
import { api } from "../api-client";
import { formatApiError } from "../util/kernel-error";
import { useToastStore } from "./toast";
import { onEventType } from "../events";

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
  /** 处理 knowledge:progress：维护 progress map 并同步对应库的 status/progress */
  applyProgress(e: KbProgressEvent): void;
}

export const useKnowledgeStore = create<KnowledgeState>((set) => ({
  kbs: [],
  loading: false,
  loaded: false,
  progress: {},

  listKbs: () => {
    set({ loading: true });
    api
      .get("/api/knowledge")
      .then((data: any) => {
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
              status: kb.status,
            };
          }
        }
        set({ kbs, progress, loading: false, loaded: true });
      })
      .catch(() => set({ loading: false }));
  },

  deleteKb: async (id) => {
    try {
      await api.del(`/api/knowledge/${encodeURIComponent(id)}`);
    } catch (e) {
      // 删除失败不能静默（登记还在，界面刷新后仍在）
      useToastStore.getState().add(formatApiError(e), "error");
      return;
    }
    // kernel 无 knowledge 域 changed 广播：删除成功就地移除（含进度残留）
    set((s) => {
      const progress = { ...s.progress };
      delete progress[id];
      return { kbs: s.kbs.filter((k) => k.id !== id), progress };
    });
  },

  setAutoWatch: async (id, on) => {
    try {
      await api.put(`/api/knowledge/${encodeURIComponent(id)}`, { autoWatch: on });
    } catch (e) {
      useToastStore.getState().add(formatApiError(e), "error");
      return;
    }
    // PUT 成功即事实，就地改本地（kernel 无清单广播）
    set((s) => ({
      kbs: s.kbs.map((k) => (k.id === id ? { ...k, autoWatch: on } : k)),
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

  applyProgress: (e) => {
    const terminal = e.status === "ready" || e.status === "error";
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
