import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { AttachmentDraft, ThinkingLevel } from "@hiagent/shared";

const DB_NAME = "hiagent-composer";
const DB_VERSION = 1;

interface ComposerSessionRecord {
  sessionId: string;
  model: string | null;
  thinking: ThinkingLevel;
  attachments: AttachmentDraft[];
  updatedAt: number;
}

interface ComposerDB extends DBSchema {
  sessions: {
    key: string;
    value: ComposerSessionRecord;
  };
  defaults: {
    key: string;
    // keyless store；按 key 存不同形状（DEFAULTS_KEY / RECORDING_KEY）——联合类型兼容两种
    value: { model: string | null; thinking: ThinkingLevel } | RecordingPrefs;
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

const DEFAULTS_KEY = "composer-defaults";
type DefaultsPrefs = { model: string | null; thinking: ThinkingLevel };

export async function getDefaults(): Promise<DefaultsPrefs> {
  try {
    const stored = await (await getDb()).get("defaults", DEFAULTS_KEY);
    return (stored as DefaultsPrefs | undefined) ?? { model: null, thinking: "disabled" };
  } catch {
    return { model: null, thinking: "disabled" };
  }
}

export async function setDefaults(prefs: DefaultsPrefs): Promise<void> {
  try {
    await (await getDb()).put("defaults", prefs, DEFAULTS_KEY);
  } catch {}
}

const RECORDING_KEY = "recording-prefs";

export interface RecordingPrefs { lastSource: "mic" | "system"; }

export async function getRecordingPrefs(): Promise<RecordingPrefs | undefined> {
  try {
    const stored = await (await getDb()).get("defaults", RECORDING_KEY);
    return stored as RecordingPrefs | undefined;
  } catch {
    return undefined;
  }
}

export async function setRecordingPrefs(prefs: RecordingPrefs): Promise<void> {
  try {
    await (await getDb()).put("defaults", prefs, RECORDING_KEY);
  } catch {}
}
