// subagent-telemetry.ts — 子代理派发遥测：量化每次 delegate/fleet 派发省了多少父上下文。
//
// 仿 cocode src/telemetry/subagent-distillation.ts，适配 HiAgent：
// - 子代理 token 用量来自 pi rpc 的 get_session_stats（runSubagentAgent 在 dispose 前采集）
// - 返回值 token 数用 chars/4 估计（HiAgent 不引 tokenizer 依赖），是下界估计：
//   真实省下的还包括子代理中间工具结果，那些本可能内联进父会话。
//
// 用法：makeSpawnFn 的 onSpawnComplete 回调每次 spawn 结束调 record()；
// 会话销毁时读 records/summary 落盘（agent-manager._teardownSession）。
// 落盘位置：~/.hiagent/subagent-telemetry.jsonl（JSONL 格式，每行一条 SpawnTelemetryRecord，
// 末行为 SpawnSessionSummary 汇总行，type: "summary"）

/** 一次派发完成后的原始输入（由 makeSpawnFn 构造） */
export interface SpawnTelemetryInput {
	agent: string;
	task: string;
	isError: boolean;
	returnText: string;
	elapsedMs?: number;
	/** 子代理会话 token 用量（pi get_session_stats）；拿不到时为 undefined */
	childUsage?: {
		tokens: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			total: number;
		};
		costTotal: number;
	};
}

/** 一次派发的遥测记录（落盘 jsonl 的单行） */
export interface SpawnTelemetryRecord {
	type: "spawn";
	ts: string;
	agent: string;
	taskChars: number;
	isError: boolean;
	elapsedMs: number;
	/** 子代理 output token 数（无 usage 时为 0） */
	childOutputTokens: number;
	/** 子代理总 token 数（无 usage 时为 0） */
	childTotalTokens: number;
	costTotal: number;
	returnChars: number;
	/** 返回值 token 估计（chars/4，下界） */
	returnTokensEst: number;
	/** 估计省下的父上下文 token（childOutputTokens − returnTokensEst，下限 0） */
	savingsTokensEst: number;
	/** returnTokensEst / childOutputTokens；childOutputTokens 为 0 时为 1。越低蒸馏越狠 */
	compressionRatio: number;
	/** 返回值非空（衡量"这次派发有没有产出"） */
	hasOutput: boolean;
}

/** 会话级汇总（落盘 jsonl 的 summary 行） */
export interface SpawnSessionSummary {
	spawnCount: number;
	/** 非错误且返回非空的派发数 */
	usefulSpawnCount: number;
	successRate: number;
	totalChildOutputTokens: number;
	totalReturnTokensEst: number;
	totalSavingsTokensEst: number;
	/** 按 child output tokens 加权的总压缩率 */
	aggregateCompressionRatio: number;
	totalCost: number;
}

/** 返回值 token 估计：chars/4 上取整（经验值，英文偏多时偏高、中文偏多时偏准） */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export function computeSpawnTelemetry(
	input: SpawnTelemetryInput,
): SpawnTelemetryRecord {
	const childOutputTokens = input.childUsage?.tokens.output ?? 0;
	const childTotalTokens = input.childUsage?.tokens.total ?? 0;
	const returnTokensEst = estimateTokens(input.returnText);
	return {
		type: "spawn",
		ts: new Date().toISOString(),
		agent: input.agent,
		taskChars: input.task.length,
		isError: input.isError,
		elapsedMs: input.elapsedMs ?? 0,
		childOutputTokens,
		childTotalTokens,
		costTotal: input.childUsage?.costTotal ?? 0,
		returnChars: input.returnText.length,
		returnTokensEst,
		savingsTokensEst: Math.max(0, childOutputTokens - returnTokensEst),
		compressionRatio:
			childOutputTokens > 0 ? returnTokensEst / childOutputTokens : 1,
		hasOutput: input.returnText.trim().length > 0,
	};
}

export function summarizeSpawnTelemetry(
	records: readonly SpawnTelemetryRecord[],
): SpawnSessionSummary {
	const spawnCount = records.length;
	if (spawnCount === 0) {
		return {
			spawnCount: 0,
			usefulSpawnCount: 0,
			successRate: 0,
			totalChildOutputTokens: 0,
			totalReturnTokensEst: 0,
			totalSavingsTokensEst: 0,
			aggregateCompressionRatio: 1,
			totalCost: 0,
		};
	}
	let usefulSpawnCount = 0;
	let totalChildOutputTokens = 0;
	let totalReturnTokensEst = 0;
	let totalSavingsTokensEst = 0;
	let totalCost = 0;
	for (const r of records) {
		if (!r.isError && r.hasOutput) usefulSpawnCount++;
		totalChildOutputTokens += r.childOutputTokens;
		totalReturnTokensEst += r.returnTokensEst;
		totalSavingsTokensEst += r.savingsTokensEst;
		totalCost += r.costTotal;
	}
	return {
		spawnCount,
		usefulSpawnCount,
		successRate: usefulSpawnCount / spawnCount,
		totalChildOutputTokens,
		totalReturnTokensEst,
		totalSavingsTokensEst,
		aggregateCompressionRatio:
			totalChildOutputTokens > 0
				? totalReturnTokensEst / totalChildOutputTokens
				: 1,
		totalCost,
	};
}

/** 会话级收集器：会话创建时 new 一个，onSpawnComplete 调 record，销毁时读 summary/records 落盘 */
export class SubagentTelemetry {
	private readonly _records: SpawnTelemetryRecord[] = [];

	record(input: SpawnTelemetryInput): SpawnTelemetryRecord {
		const rec = computeSpawnTelemetry(input);
		this._records.push(rec);
		return rec;
	}

	get records(): readonly SpawnTelemetryRecord[] {
		return this._records;
	}

	get summary(): SpawnSessionSummary {
		return summarizeSpawnTelemetry(this._records);
	}
}
