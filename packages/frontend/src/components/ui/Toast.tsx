import { useToastStore } from "../../store/toast";

export function ToastContainer() {
  const { toasts, dismiss } = useToastStore();

  if (toasts.length === 0) return null;

  // 顶部水平居中、向下 10vh（toast 3 秒自动消失 + 点击即关）
  // z-[60]：高于 Modal 遮罩 z-50（Modal portal 到 body 末尾同层时后渲染在上），
  // 保证 toast 始终在弹窗阴影之上可见。
  return (
    <div className="fixed left-1/2 -translate-x-1/2 z-[60] flex flex-col items-center gap-2" style={{ top: "10vh", maxWidth: 360 }} data-testid="toast-container">
      {toasts.map(t => (
        <div
          key={t.id}
          className="px-4 py-2.5 rounded-md shadow-lg text-sm cursor-pointer select-none"
          style={{
            background: t.type === "error" ? "var(--danger)" : t.type === "success" ? "var(--success)" : "var(--brand)",
            color: "#fff",
            animation: "toast-in 0.25s ease-out",
          }}
          onClick={() => dismiss(t.id)}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
