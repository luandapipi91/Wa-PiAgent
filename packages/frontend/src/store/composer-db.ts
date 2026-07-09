import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { AttachmentDraft } from "@hiagent/shared";

const DB_NAME = "hiagent-composer";
const DB_VERSION = 1;

interface ComposerSessionRecord {
  sessionId: string;
  model: string | null;
  thinking: "disabled" | "high";
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
    value: { model: string | null; thinking: "disabled" | "high" };
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

export async function getDefaults(): Promise<{ model: string | null; thinking: "disabled" | "high" }> {
  try {
    return (await (await getDb()).get("defaults", DEFAULTS_KEY)) ?? { model: null, thinking: "disabled" };
  } catch {
    return { model: null, thinking: "disabled" };
  }
}

export async function setDefaults(prefs: { model: string | null; thinking: "disabled" | "high" }): Promise<void> {
  try {
    await (await getDb()).put("defaults", prefs, DEFAULTS_KEY);
  } catch {}
}
