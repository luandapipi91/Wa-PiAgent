import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { AttachmentDraft, ThinkingLevel } from "@wa-pi/shared";

const DB_NAME = "wa-pi-composer";
const DB_VERSION = 1;

interface ComposerSessionRecord {
  sessionId: string;
  model: string | null;
  thinking: ThinkingLevel;
  attachments: AttachmentDraft[];
  text?: string; // 未发送的输入框草稿；缺省/空串 = 无草稿
  updatedAt: number;
}

interface ComposerDB extends DBSchema {
  sessions: {
    key: string;
    value: ComposerSessionRecord;
  };
  defaults: {
    key: string;
    // keyless store；按 key 存不同形状（DEFAULTS_KEY / RECORDING_KEY / NEW_SESSION_IDS_KEY）
    value: { model: string | null; thinking: ThinkingLevel } | RecordingPrefs | Record<string, string>;
  };
}

let dbPromise: Promise<IDBPDatabase<ComposerDB>> | null = null;

function getDb(): Promise<IDBPDatabase<ComposerDB>> {
  if (!dbPromise) {
    dbPromise = openDB<ComposerDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        db.createObjectStore("sessions", { keyPath: "sessionId" });
        db.createObjectStore("defaults");
      },
    });
  }
  return dbPromise;
}

export async function getSessionPrefs(sessionId: string): Promise<ComposerSessionRecord | undefined> {
  try {
    return await (await getDb()).get("sessions", sessionId);
  } catch {
    return undefined;
  }
}

export async function setSessionPrefs(record: ComposerSessionRecord): Promise<void> {
  try {
    await (await getDb()).put("sessions", { ...record, updatedAt: Date.now() });
  } catch {}
}

export async function deleteSessionPrefs(sessionId: string): Promise<void> {
  try {
    await (await getDb()).delete("sessions", sessionId);
  } catch {}
}

// defaults / recording / newSessionIds 改用 localStorage 持久化：
// 这类小数据不依赖 IndexedDB 的异步初始化，在 Electron 打包态下更可靠
// （IndexedDB 在某些打包环境下 openDB 可能失败，导致 getDefaults 永远返回兜底默认值）。
// session 级 prefs（含 attachments 大数据）仍走 IndexedDB。
function lsGet<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}
function lsSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

const DEFAULTS_KEY = "wa-pi:composer-defaults";
type DefaultsPrefs = { model: string | null; thinking: ThinkingLevel };

export async function getDefaults(): Promise<DefaultsPrefs> {
  return lsGet<DefaultsPrefs>(DEFAULTS_KEY) ?? { model: null, thinking: "disabled" };
}

export async function setDefaults(prefs: DefaultsPrefs): Promise<void> {
  lsSet(DEFAULTS_KEY, prefs);
}

const RECORDING_KEY = "wa-pi:recording-prefs";

export interface RecordingPrefs { lastSource: "mic" | "system"; }

export async function getRecordingPrefs(): Promise<RecordingPrefs | undefined> {
  return lsGet<RecordingPrefs>(RECORDING_KEY);
}

export async function setRecordingPrefs(prefs: RecordingPrefs): Promise<void> {
  lsSet(RECORDING_KEY, prefs);
}

const NEW_SESSION_IDS_KEY = "wa-pi:new-session-ids";

export async function getNewSessionIds(): Promise<Record<string, string>> {
  return lsGet<Record<string, string>>(NEW_SESSION_IDS_KEY) ?? {};
}

export async function setNewSessionIds(ids: Record<string, string>): Promise<void> {
  lsSet(NEW_SESSION_IDS_KEY, ids);
}
