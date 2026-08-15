import {
	useState,
	useRef,
	useCallback,
	useEffect,
	useLayoutEffect,
} from "react";
import { createPortal } from "react-dom";
import { useChannelsStore } from "../../store/channels";
import { useContactsStore } from "../../store/contacts";
import type { ContactEntity } from "@wa-pi/shared";
import { SkillSuggestTextarea } from "../ui/SkillSuggestTextarea";

interface Props {
	value: string;
	onChange: (value: string) => void;
}

/**
 * 任务指令输入框：@ 选择联系人 + $ 插入技能。
 *
 * $ 技能：复用公共组件 SkillSuggestTextarea（输入框本身 + 技能弹窗全内建：
 * portal 挂 body、fixed 定位、不透明背景、方向键导航、token 替换，与「机器
 * 设置」里的技能输入框同一套）。不再手搓技能弹窗。
 *
 * @ 联系人：SkillSuggestTextarea 不暴露键盘事件，但 keyup 会冒泡到本组件容器
 * div——容器上监听 keyup 检测 @ 弹出该 IM 渠道通讯录里的「人」（kind=person），
 * 按渠道分组展示，选中后把光标前最近一个 @ 替换为 @ct_xxx（联系人 id）。
 * 任务执行时 kernel 经 pushToContact 主动推送到该联系人（单聊 userid），
 * 而不是渠道本身——否则推送无法到达具体的人。弹窗 portal 挂 body（逃逸 Modal
 * 裁剪），锚定容器矩形；打开时主动 loadContacts()（新联系人采集无广播兜底）。
 */
export function TaskPromptComposer({ value, onChange }: Props) {
	const [dismissed, setDismissed] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);
	const channelPopRef = useRef<HTMLDivElement>(null);
	const { bots } = useChannelsStore();
	const { contacts, loadContacts } = useContactsStore();

	// @ 触发为派生状态：光标前（value 末尾）出现 @ 时显示联系人选择器，
	// dismissed 用于 Escape/外点/滚动主动收起；value 变化（@ 被删除/继续输入）时重置。
	const showChannelPicker = /@$/.test(value) && !dismissed;

	useEffect(() => {
		setDismissed(false);
	}, [value]);

	// 渠道弹窗定位：portal 挂 body（fixed）逃逸 Modal 内容区 overflow 裁剪，锚定容器矩形。
	// 底部空间不足向上翻，右溢出左移钳制；happy-dom 零尺寸（测试环境）不定位。
	useLayoutEffect(() => {
		if (!showChannelPicker || !channelPopRef.current || !containerRef.current)
			return;
		const pr = containerRef.current.getBoundingClientRect();
		if (pr.width === 0 && pr.height === 0) return;
		const pop = channelPopRef.current;
		pop.style.left = `${pr.left}px`;
		pop.style.top = `${pr.bottom + 4}px`;
		pop.style.minWidth = `${pr.width}px`;
		const r = pop.getBoundingClientRect();
		if (r.width === 0 && r.height === 0) return;
		if (pr.bottom + 4 + r.height > window.innerHeight - 8) {
			pop.style.top = `${Math.max(8, pr.top - r.height - 4)}px`;
		}
		if (pr.left + r.width > window.innerWidth - 8) {
			pop.style.left = `${Math.max(8, window.innerWidth - 8 - r.width)}px`;
		}
	});

	// @ 触发时主动拉取通讯录（新联系人采集无 contacts:changed 广播，打开时拉取兜底）
	useEffect(() => {
		if (showChannelPicker) void loadContacts();
	}, [showChannelPicker, loadContacts]);

	const closePicker = useCallback(() => setDismissed(true), []);

	// 点击外部关闭联系人选择器（portal 面板挂 body，需判 container + pop 的 ref 内部）
	useEffect(() => {
		if (!showChannelPicker) return;
		const handleClickOutside = (e: MouseEvent) => {
			const t = e.target as Node;
			if (containerRef.current?.contains(t)) return;
			if (channelPopRef.current?.contains(t)) return;
			setDismissed(true);
		};
		document.addEventListener("mousedown", handleClickOutside);
		return () => document.removeEventListener("mousedown", handleClickOutside);
	}, [showChannelPicker]);

	// 滚动关闭联系人面板（fixed 浮层不随容器位移脱锚；技能面板由 SkillSuggestTextarea 自行处理）
	useEffect(() => {
		if (!showChannelPicker) return;
		const onScroll = (ev: Event) => {
			const t = ev.target as Node | null;
			if (t instanceof Node && channelPopRef.current?.contains(t)) return;
			setDismissed(true);
		};
		window.addEventListener("scroll", onScroll, true);
		return () => window.removeEventListener("scroll", onScroll, true);
	}, [showChannelPicker]);

	// @ 触发：keyup 冒泡到容器 div（SkillSuggestTextarea 内建 $，不暴露键盘事件）。
	// 显示与否由派生状态决定（value 末尾 @），此处只负责清除 dismissed 让选择器重新出现
	const handleContainerKeyUp = useCallback(
		(e: React.KeyboardEvent<HTMLDivElement>) => {
			// 按下 @ 即触发联系人选择器（粘贴 @ct_xxx 不会触发 keyup，避免误弹）
			if (e.key === "@") setDismissed(false);
		},
		[],
	);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLDivElement>) => {
			if (e.key === "Escape" && showChannelPicker) {
				e.preventDefault();
				closePicker();
			}
		},
		[showChannelPicker, closePicker],
	);

	const handleSelectContact = useCallback(
		(contactId: string) => {
			const ta = containerRef.current?.querySelector("textarea");
			const cursorPos = ta?.selectionStart ?? value.length;
			const before = value.slice(0, cursorPos);
			const after = value.slice(cursorPos);
			// 替换光标前最近一个 @ 为 @ct_xxx（联系人 id，若无则直接插入）
			const atIdx = before.lastIndexOf("@");
			const head = atIdx >= 0 ? before.slice(0, atIdx) : before;
			const newValue = `${head}@${contactId} ${after}`;
			onChange(newValue);
			setDismissed(true);
			requestAnimationFrame(() => ta?.focus());
		},
		[value, onChange],
	);

	// 联系人按渠道分组（person 才可 @；渠道名经 bots 映射，找不到回退渠道 id）
	const channelNameOf = useCallback(
		(channelId: string): string =>
			bots.find((b) => b.id === channelId)?.name ?? channelId,
		[bots],
	);
	const personsByChannel = useCallback((): Array<{
		channelId: string;
		channelName: string;
		persons: ContactEntity[];
	}> => {
		const map = new Map<string, ContactEntity[]>();
		for (const c of contacts) {
			if (c.kind !== "person") continue;
			const list = map.get(c.channelId) ?? [];
			list.push(c);
			map.set(c.channelId, list);
		}
		return [...map.entries()].map(([channelId, persons]) => ({
			channelId,
			channelName: channelNameOf(channelId),
			persons,
		}));
	}, [contacts, channelNameOf]);
	const grouped = personsByChannel();
	const totalPersons = grouped.reduce((n, g) => n + g.persons.length, 0);

	return (
		<div
			className="relative"
			ref={containerRef}
			onKeyUp={handleContainerKeyUp}
			onKeyDown={handleKeyDown}
		>
			<SkillSuggestTextarea
				value={value}
				onChange={onChange}
				rows={3}
				placeholder="让智能体帮你做什么...（$ 插入技能，@ 选择联系人）"
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
					<strong style={{ color: "#4ade80" }}>@</strong> 选择联系人
				</span>
			</div>
			{/* 联系人选择器（portal 挂 body，逃逸 Modal 裁剪） */}
			{showChannelPicker &&
				createPortal(
					<div
						ref={channelPopRef}
						// 初始藏屏外，layout effect 按容器矩形定位；测试环境（零尺寸）不定位
						style={{
							left: -9999,
							top: -9999,
							background: "var(--surface)",
							boxShadow: "var(--shadow-md)",
						}}
						className="fixed z-[1000] rounded-md border border-hairline overflow-hidden py-1 max-h-48 overflow-y-auto"
						data-testid="channel-picker"
					>
						{totalPersons === 0 && (
							<div
								className="px-3 py-2 text-[10px]"
								style={{ color: "var(--text-tertiary)" }}
							>
								暂无联系人（先在 IM 里发起会话后自动收录）
							</div>
						)}
						{grouped.map((group) => (
							<div key={group.channelId}>
								<div
									className="px-3 py-1 text-[10px] font-medium"
									style={{ color: "var(--text-tertiary)" }}
								>
									📨 {group.channelName}
								</div>
								{group.persons.map((c) => (
									<div
										key={c.id}
										onClick={() => handleSelectContact(c.id)}
										className="px-3 py-1.5 text-xs cursor-pointer hover:bg-white/5 flex items-center gap-1"
										style={{ color: "var(--text-primary)" }}
										data-testid={`contact-item-${c.id}`}
									>
										<span>👤</span>
										<span>{c.remark || c.userId}</span>
									</div>
								))}
							</div>
						))}
					</div>,
					document.body,
				)}
		</div>
	);
}
