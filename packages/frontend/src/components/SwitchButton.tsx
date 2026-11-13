/**
 * 内联 Toggle Switch（与插件/技能管理风格一致）。
 *
 * 从 AgentConfig 提出为共享组件：智能体 MCP 分组开关与 MCP 管理页内置条目的
 * 启停开关共用同一视觉语言（38×22 胶囊、data-on 暴露开关态供测试断言）。
 */
export function SwitchButton({
	on,
	onClick,
	testId,
	className,
}: {
	on: boolean;
	onClick: () => void;
	testId: string;
	/** 追加到根元素的定位/布局类（例如卡片头部右侧的 ml-auto） */
	className?: string;
}) {
	return (
		<div
			onClick={(e) => {
				e.stopPropagation();
				onClick();
			}}
			className={`relative shrink-0 cursor-pointer${className ? ` ${className}` : ""}`}
			style={{
				width: 38,
				height: 22,
				borderRadius: 9999,
				background: on ? "var(--brand)" : "var(--hairline-strong)",
				transition: "background 0.2s",
			}}
			data-testid={testId}
			data-on={on ? "true" : "false"}
			role="switch"
			aria-checked={on}
		>
			<span
				className="absolute top-0.5 rounded-full bg-white transition-all"
				style={{
					width: 18,
					height: 18,
					left: on ? undefined : 2,
					right: on ? 2 : undefined,
					boxShadow: "0 1px 2px rgba(0,0,0,.1)",
				}}
			/>
		</div>
	);
}
