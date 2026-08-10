import i18n from "../i18n";
import {
	appendRecording,
	finalizeRecording,
	discardRecording,
} from "../fs-client";

const TIMESLICE_MS = 2000;

export function formatDuration(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	const pad = (n: number) => String(n).padStart(2, "0");
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** 暂停感知的时长累积器（纯逻辑，可单测）。所有 now 由调用方传入，便于测试。 */
export class ElapsedTracker {
	private accumulated = 0;
	private resumedAt = 0;
	private running = false;
	start(now: number): void {
		this.accumulated = 0;
		this.resumedAt = now;
		this.running = true;
	}
	pause(now: number): void {
		if (!this.running) return;
		this.accumulated += now - this.resumedAt;
		this.running = false;
	}
	resume(now: number): void {
		if (this.running) return;
		this.resumedAt = now;
		this.running = true;
	}
	elapsed(now: number): number {
		return this.accumulated + (this.running ? now - this.resumedAt : 0);
	}
}

export interface StartArgs {
	source: "mic" | "system";
	projectId: string;
	sessionId: string;
	ownerLabel: string;
	onTick: (elapsedMs: number) => void;
}
export interface RecordingResult {
	path: string;
	size: number;
	durationMs: number;
}

export interface RecordingEngine {
	start(args: StartArgs): Promise<void>;
	pause(): void;
	resume(): void;
	stop(): Promise<RecordingResult>;
}

/**
 * 把 getUserMedia / getDisplayMedia 的浏览器原始错误映射为业务可读文案。
 * 无权限时浏览器抛 DOMException（NotAllowedError 等），直接展示 message 是英文原文
 * （如 "Permission denied"），用户无法理解。此处按 DOMException.name 分类映射。
 * 非 DOMException（意外错误）保留原 message，由调用方兜底。
 */
export function toRecordingErrorMessage(err: unknown): string {
	const e = err as { name?: string; message?: string } | null;
	switch (e?.name) {
		case "NotAllowedError":
			return i18n.t("store.recordingPermissionDenied");
		case "NotFoundError":
			return i18n.t("store.recordingDeviceNotFound");
		case "NotReadableError":
		case "AbortError":
			return i18n.t("store.recordingDeviceBusy");
		default:
			return i18n.t("store.recordingDeviceGeneric", {
				detail: e?.message ?? String(err),
			});
	}
}

function blobToBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const r = new FileReader();
		r.onloadend = () => {
			const s = String(r.result);
			resolve(s.includes(",") ? s.split(",")[1] : s);
		};
		r.onerror = () => reject(new Error("录音分片读取失败"));
		r.readAsDataURL(blob);
	});
}

function pickAudioMimeType(): string {
	return typeof MediaRecorder !== "undefined" &&
		MediaRecorder.isTypeSupported("audio/webm")
		? "audio/webm"
		: "";
}

class RecordingManager implements RecordingEngine {
	private recorder: MediaRecorder | null = null;
	private stream: MediaStream | null = null;
	private tracker = new ElapsedTracker();
	private recId = "";
	private projectId = "";
	private sessionId = "";
	private onTick: ((ms: number) => void) | null = null;
	private tickTimer: ReturnType<typeof setInterval> | null = null;
	private stopResolve: ((r: RecordingResult) => void) | null = null;
	private stopReject: ((e: Error) => void) | null = null;
	private failed = false;

	async start(args: StartArgs): Promise<void> {
		if (this.recorder) throw new Error(i18n.t("store.recordingBusy"));
		this.projectId = args.projectId;
		this.sessionId = args.sessionId;
		this.recId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		this.onTick = args.onTick;
		this.failed = false;

		let stream: MediaStream;
		try {
			stream =
				args.source === "mic"
					? await navigator.mediaDevices.getUserMedia({ audio: true })
					: await navigator.mediaDevices.getDisplayMedia({
							video: true,
							audio: true,
						});
		} catch (err) {
			// 无权限/无设备/被占用：浏览器抛 DOMException，原始 message 是英文，用户无法理解。
			// 按 DOMException.name 映射为业务文案后再上抛（RecordButton 直接展示 message）。
			throw new Error(toRecordingErrorMessage(err));
		}
		this.stream = stream;

		const audioTracks = stream.getAudioTracks();
		if (audioTracks.length === 0) {
			this.releaseTracks();
			throw new Error(i18n.t("store.recordingNoAudioTrack"));
		}
		for (const t of stream.getVideoTracks()) t.stop(); // 系统 audio：丢弃 video

		const recorder = new MediaRecorder(
			new MediaStream(audioTracks),
			pickAudioMimeType() ? { mimeType: pickAudioMimeType() } : undefined,
		);
		this.recorder = recorder;

		recorder.ondataavailable = async (e) => {
			if (!e.data || e.data.size === 0 || this.failed) return;
			try {
				await appendRecording(
					this.projectId,
					this.recId,
					await blobToBase64(e.data),
					this.sessionId,
				);
			} catch (err) {
				this.fail(err as Error);
			}
		};
		recorder.onstop = async () => {
			if (this.failed) {
				this.stopReject?.(new Error("录音已失败"));
				this.cleanup();
				return;
			}
			const durationMs = this.tracker.elapsed(Date.now());
			try {
				const { path } = await finalizeRecording(
					this.projectId,
					this.recId,
					`recording-${this.recId}.webm`,
					this.sessionId,
				);
				this.stopResolve?.({ path, size: 0, durationMs });
			} catch (err) {
				this.stopReject?.(err as Error);
			} finally {
				this.cleanup();
			}
		};
		recorder.onerror = () => this.fail(new Error("录音出错"));

		this.tracker.start(Date.now());
		recorder.start(TIMESLICE_MS);
		this.tickTimer = setInterval(
			() => this.onTick?.(this.tracker.elapsed(Date.now())),
			250,
		);
	}

	pause(): void {
		if (!this.recorder || this.recorder.state !== "recording") return;
		this.recorder.pause();
		this.tracker.pause(Date.now());
	}
	resume(): void {
		if (!this.recorder || this.recorder.state !== "paused") return;
		this.recorder.resume();
		this.tracker.resume(Date.now());
	}
	stop(): Promise<RecordingResult> {
		return new Promise((resolve, reject) => {
			if (!this.recorder) {
				reject(new Error("没有进行中的录音"));
				return;
			}
			this.stopResolve = resolve;
			this.stopReject = reject;
			this.tracker.pause(Date.now()); // 冻结计时，等待 onstop
			if (this.tickTimer) {
				clearInterval(this.tickTimer);
				this.tickTimer = null;
			}
			this.recorder.stop();
		});
	}

	private fail(_err: Error): void {
		if (this.failed) return;
		this.failed = true;
		// 清理失败 best-effort：discard 失败不阻断自洁流程（残留分片由 kernel 侧清扫兜底），仅记录日志
		try {
			void discardRecording(this.projectId, this.recId, this.sessionId);
		} catch (e) {
			console.warn("[recording] discard 失败（可忽略）", e);
		}
		this.onTick = null;
		if (this.tickTimer) {
			clearInterval(this.tickTimer);
			this.tickTimer = null;
		}
		// 自洁：失败后立即停 recorder，触发 onstop → cleanup() 释放 tracks，
		// 不依赖外部 stop()（append 失败时 store 无从感知）。guard 防 onerror 路径已自动 stop 的二次调用。
		// stop() 抛错可忽略：state 已异常，cleanup 仍会执行，仅记录日志。
		try {
			if (this.recorder && this.recorder.state !== "inactive")
				this.recorder.stop();
		} catch (e) {
			console.warn("[recording] 自洁 stop 失败（可忽略）", e);
		}
	}

	private releaseTracks(): void {
		this.stream?.getTracks().forEach((t) => t.stop());
	}
	private cleanup(): void {
		this.releaseTracks();
		if (this.tickTimer) {
			clearInterval(this.tickTimer);
			this.tickTimer = null;
		}
		this.recorder = null;
		this.stream = null;
		this.stopResolve = null;
		this.stopReject = null;
	}
}

// 模块级单例 + 测试注入钩子（镜像 fs-client._setFsTransport 模式）
let engine: RecordingEngine = new RecordingManager();
export function getRecordingManager(): RecordingEngine {
	return engine;
}
export function _setRecordingManager(e: RecordingEngine | null): void {
	engine = e ?? new RecordingManager();
}
