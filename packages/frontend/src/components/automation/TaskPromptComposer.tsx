import { useState, useRef, useCallback, useEffect } from "react";
import { useChannelsStore } from "../../store/channels";

interface Props {
	value: string;
	onChange: (value: string) => void;
}

/**
 * 任务指令输入框：支持 @ 关联 IM 渠道（$ 插入技能为提示，暂未实现下拉）。
 *
 * @ 触发逻辑：用户按下 @ 键时弹出已连接的 IM 渠道列表，选中后把光标前最近一个
 * @ 替换为 @botId（如 @bot_aaa），与后端 @bot_ 解析约定一致。
 */
export function TaskPromptComposer({ value, onChange }: Props) {
	const [showChannelPicker, setShowChannelPicker] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const { bots } = useChannelsStore();

	// Escape 关闭 / 点击外部关闭渠道选择器
	const closePicker = useCallback(() => setShowChannelPicker(false), []);

	useEffect(() => {
		if (!showChannelPicker) return;
		const handleClickOutside = (e: MouseEvent) => {
			if (
				containerRef.current &&
				!containerRef.current.contains(e.target as Node)
			) {
				setShowChannelPicker(false);
			}
		};
		document.addEventListener("mousedown", handleClickOutside);
		return () =>
			document.removeEventListener("mousedown", handleClickOutside);
	}, [showChannelPicker]);

	const handleKeyUp = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
			// 按下 @ 即触发渠道选择器（粘贴 @bot_xxx 不会触发 keyup，避免误弹）
			if (e.key === "@") {
				setShowChannelPicker(true);
			}
		},
		[],
	);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
			if (e.key === "Escape" && showChannelPicker) {
				e.preventDefault();
				closePicker();
			}
		},
		[showChannelPicker, closePicker],
	);

	const handleSelectChannel = useCallback(
		(botId: string) => {
			const textarea = textareaRef.current;
			const cursorPos = textarea?.selectionStart ?? value.length;
			const before = value.slice(0, cursorPos);
			const after = value.slice(cursorPos);
			// 替换光标前最近一个 @ 为 @botId（若无则直接插入）
			const atIdx = before.lastIndexOf("@");
			const head = atIdx >= 0 ? before.slice(0, atIdx) : before;
			const newValue = `${head}@${botId} ${after}`;
			onChange(newValue);
			setShowChannelPicker(false);
			requestAnimationFrame(() => textarea?.focus());
		},
		[value, onChange],
	);

	const connectedBots = bots.filter((b) => b.status === "connected");

	return (
		<div className="relative" ref={containerRef}>
			<textarea
				ref={textareaRef}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				onKeyUp={handleKeyUp}
				onKeyDown={handleKeyDown}
				placeholder="让智能体帮你做什么...（$ 插入技能，@ 关联 IM 渠道）"
				className="w-full rounded-lg p-2.5 text-xs resize-none outline-none border"
				style={{
					background: "var(--surface-hover)",
					borderColor: "var(--hairline)",
					color: "var(--text-primary)",
					minHeight: "70px",
				}}
				data-testid="task-prompt-input"
			/>
			{/* 提示行 */}
			<div
				className="flex gap-3 mt-1 text-[9px]"
				style={{ color: "var(--text-tertiary)" }}
			>
				<span>
					<strong style={{ color: "#c084fc" }}>$</strong> 插入技能
				</span>
				<span>
					<strong style={{ color: "#4ade80" }}>@</strong> 关联 IM 渠道
				</span>
			</div>
			{/* IM 渠道选择器 */}
			{showChannelPicker && (
				<div
					className="absolute z-50 rounded-md border shadow-lg py-1 max-h-48 overflow-y-auto"
					style={{
						background: "var(--surface)",
						borderColor: "var(--hairline)",
					}}
					data-testid="channel-picker"
				>
					{connectedBots.map((bot) => (
						<div
							key={bot.id}
							onClick={() => handleSelectChannel(bot.id)}
							className="px-3 py-1.5 text-xs cursor-pointer hover:bg-white/5 flex items-center gap-1"
							style={{ color: "var(--text-primary)" }}
						>
							<span>📨</span>
							<span>{bot.name}</span>
						</div>
					))}
					{connectedBots.length === 0 && (
						<div
							className="px-3 py-2 text-[10px]"
							style={{ color: "var(--text-tertiary)" }}
						>
							暂无已连接的 IM 渠道
						</div>
					)}
				</div>
			)}
		</div>
	);
}
