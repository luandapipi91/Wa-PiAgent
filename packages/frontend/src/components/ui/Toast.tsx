import { useToastStore } from "../../store/toast";

export function ToastContainer() {
  const { toasts, dismiss } = useToastStore();

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2" style={{ maxWidth: 360 }}>
      {toasts.map(t => (
        <div
          key={t.id}
          className="px-4 py-2.5 rounded-md shadow-lg text-sm cursor-pointer select-none"
          style={{
            background: t.type === "error" ? "var(--danger)" : "var(--brand)",
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
