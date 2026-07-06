// PLACEHOLDER — Task 25 将实现真正的 SessionView（消息流 + canvas 切换）。
// 此占位仅为让 App.tsx（Task 21）三态路由的 session 分支可编译/通过测试；
// 当 Task 25 落地时整体替换本文件。
interface Props {
  sessionId: string;
  onSwitchToCanvas: () => void;
}

export function SessionView({ sessionId }: Props) {
  return (
    <div className="flex-1 flex flex-col" data-testid="session-view">
      <p className="p-4 text-subtext">会话视图（占位）· sessionId={sessionId}</p>
    </div>
  );
}
