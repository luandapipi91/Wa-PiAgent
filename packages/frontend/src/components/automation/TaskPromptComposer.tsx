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
import { useSkillsStore } from "../../store/skills";
import type { ContactEntity } from "@wa-pi/shared";
import { ComposerTextarea } from "../ui/ComposerTextarea";
import { QuickInvokeMenu, type MenuItem } from "../ui/QuickInvokeMenu";
import { imPushToken, toPromptHtml } from "./prompt-tokens";

interface Props {
	value: string;
	onChange: (value: string) => void;
}

/**
 * 任务指令输入框（contenteditable chip 版，复用聊天 ComposerTextarea 的 chip 机制）：
 * - @ 联系人：chip 显示人名，存储形态 @im-push-to(bot,ct)（执行时 kernel 解析注入 im_push_to）
 * - $ 技能：chip 显示技能名，存储形态 $[技能名]（执行时 kernel expandSkillTokens 任意位置展开）
 * - 联系人已删除：chip 灰化显示 id，不报错（存储 token 原样保留）
 *
 * 双弹窗触发为派生状态（value 末尾触发符），插入走「末尾替换」模式
 * （对齐聊天 ComposerInput.handleSelect：替换末尾触发符为 token + 空格，
 * fallback 直接追加）；插入后 ComposerTextarea 的同步 effect 自动聚焦末尾。
 */
export function TaskPromptComposer({ value, onChange }: Props) {
	const [dismissedContact, setDismissedContact] = useState(false);
	const [dismissedSkill, setDismissedSkill] = useState(false);
	const [skillIdx, setSkillIdx] = useState(0);
	const containerRef = useRef<HTMLDivElement>(null);
	const contactPopRef = useRef<HTMLDivElement>(null);
	const skillPopRef = useRef<HTMLDivElement>(null);
	const { bots } = useChannelsStore();
	const { contacts, loadContacts } = useContactsStore();
	const skills = useSkillsStore((s) => s.skills);
	const loadSkills = useSkillsStore((s) => s.load);

	const showContactPicker = /@$/.test(value) && !dismissedContact;
	const showSkillPicker = /[$¥]$/.test(value) && !dismissedSkill;
	// 技能弹窗列表（通用 QuickInvokeMenu）：与聊天输入框同源同渲染
	const skillItems: MenuItem[] = skills.map((s) => ({
		id: s.name,
		name: s.name,
		description: s.description,
		source: s.source,
	}));

	// value 变化重置 dismissed（触发符被删/继续输入后允许再次弹出）
	useEffect(() => {
		setDismissedContact(false);
		setDismissedSkill(false);
		setSkillIdx(0);
	}, [value]);

	// 打开时兜底拉取（联系人采集无广播；技能列表懒加载）
	useEffect(() => {
		if (showContactPicker) void loadContacts();
	}, [showContactPicker, loadContacts]);
	useEffect(() => {
		if (showSkillPicker && skills.length === 0) loadSkills();
	}, [showSkillPicker, skills.length, loadSkills]);

	// 弹窗定位：portal 挂 body（fixed）逃逸 Modal 内容区 overflow 裁剪，锚定容器矩形。
	// 底部空间不足向上翻，右溢出左移钳制；happy-dom 零尺寸（测试环境）不定位。
	const positionPop = useCallback((pop: HTMLDivElement | null) => {
		if (!pop || !containerRef.current) return;
		const pr = containerRef.current.getBoundingClientRect();
		if (pr.width === 0 && pr.height === 0) return;
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
	}, []);
	useLayoutEffect(() => {
		if (showContactPicker) positionPop(contactPopRef.current);
	}, [showContactPicker, positionPop]);
	useLayoutEffect(() => {
		if (showSkillPicker) positionPop(skillPopRef.current);
	}, [showSkillPicker, positionPop]);

	// 点击外部关闭（portal 面板挂 body，需判 container + 两个 pop 的 ref 内部）
	useEffect(() => {
		if (!showContactPicker && !showSkillPicker) return;
		const handleClickOutside = (e: MouseEvent) => {
			const t = e.target as Node;
			if (containerRef.current?.contains(t)) return;
			if (contactPopRef.current?.contains(t)) return;
			if (skillPopRef.current?.contains(t)) return;
			setDismissedContact(true);
			setDismissedSkill(true);
		};
		document.addEventListener("mousedown", handleClickOutside);
		return () => document.removeEventListener("mousedown", handleClickOutside);
	}, [showContactPicker, showSkillPicker]);

	// 滚动关闭弹窗（fixed 浮层不随容器位移脱锚）
	useEffect(() => {
		if (!showContactPicker && !showSkillPicker) return;
		const onScroll = (ev: Event) => {
			const t = ev.target as Node | null;
			if (t instanceof Node && contactPopRef.current?.contains(t)) return;
			if (t instanceof Node && skillPopRef.current?.contains(t)) return;
			setDismissedContact(true);
			setDismissedSkill(true);
		};
		window.addEventListener("scroll", onScroll, true);
		return () => window.removeEventListener("scroll", onScroll, true);
	}, [showContactPicker, showSkillPicker]);

	// 插入：替换 value 末尾触发符为 token + 空格（无触发符时直接追加兜底）
	const insertContact = useCallback(
		(c: ContactEntity) => {
			const token = imPushToken(c.channelId, c.id);
			const next = /@$/.test(value)
				? value.replace(/@$/, `${token} `)
				: `${value}${token} `;
			onChange(next);
			setDismissedContact(true);
		},
		[value, onChange],
	);

	const insertSkill = useCallback(
		(name: string) => {
			const token = `$[${name}]`;
			const next = /[$¥]$/.test(value)
				? value.replace(/[$¥]$/, `${token} `)
				: `${value}${token} `;
			onChange(next);
			setDismissedSkill(true);
		},
		[value, onChange],
	);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLDivElement>) => {
			if (e.key === "Escape") {
				if (showContactPicker || showSkillPicker) {
					e.preventDefault();
					setDismissedContact(true);
					setDismissedSkill(true);
				}
				return;
			}
			// 技能弹窗打开：↑↓ 导航、Enter 选中（与聊天 ComposerInput 一致的交互）
			if (showSkillPicker && skillItems.length > 0) {
				if (e.key === "ArrowDown") {
					e.preventDefault();
					setSkillIdx((i) => (i + 1) % skillItems.length);
					return;
				}
				if (e.key === "ArrowUp") {
					e.preventDefault();
					setSkillIdx(
						(i) => (i - 1 + skillItems.length) % skillItems.length,
					);
					return;
				}
				if (e.key === "Enter") {
					e.preventDefault();
					insertSkill(skillItems[skillIdx]?.name ?? "");
				}
			}
		},
		[
			showContactPicker,
			showSkillPicker,
			skillItems,
			skillIdx,
			insertSkill,
		],
	);

	// chip 元数据：查通讯录显人名；查无灰化显示 id（联系人已删除，不报错）
	const contactMeta = useCallback(
		(contactId: string) => {
			const c = contacts.find((x) => x.id === contactId);
			return c
				? { label: c.remark || c.userId || contactId, valid: true }
				: { label: contactId, valid: false };
		},
		[contacts],
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

	const popStyle = {
		left: -9999,
		top: -9999,
		background: "var(--surface)",
		boxShadow: "var(--shadow-md)",
	};
	const popClass =
		"fixed z-[1000] rounded-md border border-hairline overflow-hidden py-1 max-h-48 overflow-y-auto";

	return (
		<div className="relative" ref={containerRef}>
			<ComposerTextarea
				text={value}
				onTextChange={onChange}
				onKeyDown={handleKeyDown}
				onPaste={() => {}}
				toHtml={(t) => toPromptHtml(t, contactMeta)}
				testId="task-prompt-input"
				placeholder="让智能体帮你做什么...（$ 插入技能，@ 选择联系人）"
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
			{showContactPicker &&
				createPortal(
					<div
						ref={contactPopRef}
						style={popStyle}
						className={popClass}
						data-testid="contact-picker"
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
										onClick={() => insertContact(c)}
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
			{/* 技能选择器（portal 挂 body，定位/关闭与联系人选择器同款；
			    列表体复用聊天通用 QuickInvokeMenu，键盘 ↑↓/Enter 可导航选中） */}
			{showSkillPicker &&
				createPortal(
				<div
					ref={skillPopRef}
					style={popStyle}
					className={popClass}
					data-testid="skill-picker"
				>
					<QuickInvokeMenu
						type="skill"
						items={skillItems}
						highlightedIndex={skillIdx}
						onSelect={(it) => insertSkill(it.name)}
						onHover={setSkillIdx}
						emptyText="暂无技能"
						positionClassName="relative w-full"
					/>
				</div>,
				document.body,
			)}
		</div>
	);
}
