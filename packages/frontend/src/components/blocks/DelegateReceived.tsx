interface Props { details: unknown; }

export function DelegateReceived({ details }: Props) {
  const d = details as { from?: { name?: string }; bodyText?: string } | undefined;
  return (
    <div className="rounded-lg p-2 my-1" style={{ background: "rgba(137,180,250,0.08)", border: "1px solid rgba(137,180,250,0.3)" }} data-testid="delegate-received">
      <div className="text-xs" style={{ color: "#89b4fa" }}>📨 来自 {d?.from?.name ?? "未知"}</div>
      <div className="text-sm mt-1">{d?.bodyText ?? ""}</div>
    </div>
  );
}
