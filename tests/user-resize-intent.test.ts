/**
 * R9a-03：只有用户在分隔条上真拖 / 按键后的 onLayoutChanged 才写回分栏比例
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  USER_RESIZE_GRACE_MS,
  createUserResizeIntent,
  isSeparatorTarget,
  shouldRecordResizePointerDown,
} from "@/lib/user-resize-intent";

describe("createUserResizeIntent", () => {
  it("没有任何用户操作（挂载 / 窗口缩放重算）→ 不算用户意图", () => {
    const intent = createUserResizeIntent();
    expect(intent.isActive(0)).toBe(false);
    expect(intent.isActive(10_000)).toBe(false);
  });

  it("指针按下期间一直活跃；松开后在宽限窗口内仍活跃（库在松开后才派发 onLayoutChanged），之后失效", () => {
    const intent = createUserResizeIntent();
    intent.pointerDown();
    expect(intent.isActive(5_000)).toBe(true); // 拖很久也算
    intent.pointerUp(5_000);
    expect(intent.isActive(5_000 + USER_RESIZE_GRACE_MS - 1)).toBe(true);
    expect(intent.isActive(5_000 + USER_RESIZE_GRACE_MS)).toBe(false);
  });

  it("键盘操作后一个宽限窗口内活跃", () => {
    const intent = createUserResizeIntent();
    intent.key(1_000);
    expect(intent.isActive(1_000 + USER_RESIZE_GRACE_MS - 1)).toBe(true);
    expect(intent.isActive(1_000 + USER_RESIZE_GRACE_MS)).toBe(false);
  });

  it("没按下过就收到 pointerup（页面别处的点击）不产生意图", () => {
    const intent = createUserResizeIntent();
    intent.pointerUp(1_000);
    expect(intent.isActive(1_001)).toBe(false);
  });
});

describe("isSeparatorTarget", () => {
  it("非 DOM 目标 / node 环境下返回 false，不抛", () => {
    expect(isSeparatorTarget(null)).toBe(false);
    expect(isSeparatorTarget({})).toBe(false);
  });
});

describe("Q8-01：shouldRecordResizePointerDown（真拖判据）", () => {
  const panelContent = { nodeType: 1 }; // 非 DOM Element：isSeparatorTarget 为 false（死带里 e.target 是相邻面板内容）

  it("外圈死带：库已接受并 preventDefault，但 e.target 是面板内容 → 仍算真拖（旧判据漏记，这次拖拽不持久化）", () => {
    expect(
      shouldRecordResizePointerDown({ button: 0, defaultPrevented: true, target: panelContent }),
    ).toBe(true);
  });

  it("右键 / 中键：不管库有没有 preventDefault 都不记（旧判据记成按下，右键菜单吞 pointerup 会卡住意图）", () => {
    expect(
      shouldRecordResizePointerDown({ button: 2, defaultPrevented: true, target: panelContent }),
    ).toBe(false);
    expect(
      shouldRecordResizePointerDown({ button: 1, defaultPrevented: false, target: panelContent }),
    ).toBe(false);
  });

  it("面板内容里的普通点击（库没接受、目标也不是分隔条）→ 不记，挂载 / 缩窗之外的误触不产生意图", () => {
    expect(
      shouldRecordResizePointerDown({ button: 0, defaultPrevented: false, target: panelContent }),
    ).toBe(false);
  });

  it("和意图状态机串起来：死带拖拽 → 松手后在宽限窗口内 isActive；右键按下 → 不会留下卡住的活跃态", () => {
    const intent = createUserResizeIntent();
    // 死带拖拽
    if (shouldRecordResizePointerDown({ button: 0, defaultPrevented: true, target: panelContent })) {
      intent.pointerDown();
    }
    intent.pointerUp(1_000);
    expect(intent.isActive(1_000 + USER_RESIZE_GRACE_MS - 1)).toBe(true);
    // 右键：没记按下 → 即使 pointerup 被吞，10 分钟后也不活跃
    const intent2 = createUserResizeIntent();
    if (shouldRecordResizePointerDown({ button: 2, defaultPrevented: true, target: panelContent })) {
      intent2.pointerDown();
    }
    expect(intent2.isActive(600_000)).toBe(false);
  });

  it("window blur 复位：按下后收到 blur（复用 pointerUp）→ 宽限后失效，不会一直卡活跃", () => {
    const intent = createUserResizeIntent();
    intent.pointerDown();
    intent.pointerUp(2_000); // 页面把 blur 接到同一个 onPointerEnd
    expect(intent.isActive(2_000 + USER_RESIZE_GRACE_MS)).toBe(false);
  });
});

describe("任务页接线（补充；行为见上方对 user-resize-intent 的断言）", () => {
  const page = readFileSync(path.join(process.cwd(), "src/app/tasks/[id]/page.tsx"), "utf8");
  it("onLayoutChanged 写回前过用户意图；pointerdown 走 shouldRecordResizePointerDown，blur 复位，键盘仍认分隔条", () => {
    expect(page).toMatch(/isValidArtifactPanelSize\(artifact\)\s*&&\s*userResizeIntentRef\.current\.isActive\(Date\.now\(\)\)/);
    expect(page).toContain("onPointerDownCapture");
    expect(page).toMatch(/shouldRecordResizePointerDown\(e\)\) userResizeIntentRef\.current\.pointerDown\(\)/);
    expect(page).not.toMatch(/isSeparatorTarget\(e\.target\)\) userResizeIntentRef\.current\.pointerDown/);
    expect(page).toContain('window.addEventListener("blur", onPointerEnd)');
    expect(page).toContain("onKeyDownCapture");
    expect(page).toMatch(/isSeparatorTarget\(e\.target\)\) userResizeIntentRef\.current\.key/);
  });
});
