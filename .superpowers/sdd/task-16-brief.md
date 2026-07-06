### Task 16: NewSessionButton 组件（① 新建会话区）

**Files:**
- Create: `packages/frontend/src/components/NewSessionButton.tsx`
- Test: `packages/frontend/tests/NewSessionButton.test.tsx`

**Interfaces:**
- Consumes: `useProjectsStore`（切到 new-session 态）
- Produces: 点击触发 `onNewSession`（由 App 改 currentView）

- [ ] **Step 1: 实现 + 测试**

`packages/frontend/src/components/NewSessionButton.tsx`:
```typescript
interface Props { onNewSession: () => void; }

export function NewSessionButton({ onNewSession }: Props) {
  return (
    <button
      onClick={onNewSession}
      className="w-full px-3 py-2 mb-2 text-left rounded border border-dashed border-surface2 text-subtext hover:border-blue hover:text-text text-sm"
      data-testid="new-session-btn"
    >
      ➕ 新建会话
    </button>
  );
}
```

`packages/frontend/tests/NewSessionButton.test.tsx`:
```typescript
import { test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NewSessionButton } from "../src/components/NewSessionButton";

test("点击触发 onNewSession", () => {
  const fn = vi.fn();
  render(<NewSessionButton onNewSession={fn} />);
  fireEvent.click(screen.getByTestId("new-session-btn"));
  expect(fn).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: 跑测试 + 提交**

```bash
bun run test
git add packages/frontend/src/components/NewSessionButton.tsx packages/frontend/tests/NewSessionButton.test.tsx
git commit -m "feat(frontend): NewSessionButton 组件（① 新建会话区）"
```

---

