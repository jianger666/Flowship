/**
 * 清除浏览器登录数据的确认流程（R2-14 ⑤）
 *
 * 设置页的 `browser-card.tsx` 以前自制「点一次变『确认清除』、5 秒内再点才真清」的两步确认，
 * 违反 ui-conventions「不可逆操作 → `useDialog().confirm({ destructive: true })`」。
 * 现在面板菜单与设置页共用 `runClearBrowsingData`：先确认、取消绝不碰数据、失败走 onError 不向上抛。
 * 流程函数的依赖全部注入，这里用假的 confirm / clear 直接测行为；组件接线用源码契约守。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  CLEAR_BROWSING_DATA_CONFIRM,
  runClearBrowsingData,
  type ClearDataDeps,
} from "@/components/browser/clear-data-flow";

const makeDeps = (over: Partial<ClearDataDeps> = {}) => {
  const order: string[] = [];
  const confirm = vi.fn(async () => {
    order.push("confirm");
    return true;
  });
  const clear = vi.fn(async () => {
    order.push("clear");
  });
  const onSuccess = vi.fn(() => {
    order.push("success");
  });
  const onError = vi.fn((message: string) => {
    order.push(`error:${message}`);
  });
  const deps: ClearDataDeps = { confirm, clear, onSuccess, onError, ...over };
  return { deps, order, confirm, clear, onSuccess, onError };
};

describe("runClearBrowsingData", () => {
  it("确认框按 destructive 弹，文案写明范围（所有网站 / 所有任务共用）", () => {
    expect(CLEAR_BROWSING_DATA_CONFIRM.destructive).toBe(true);
    expect(CLEAR_BROWSING_DATA_CONFIRM.confirmLabel).toBe("清除");
    expect(CLEAR_BROWSING_DATA_CONFIRM.description).toContain("所有网站");
    expect(CLEAR_BROWSING_DATA_CONFIRM.description).toContain("所有任务共用");
  });

  it("用户确认 → 先 confirm、再 clear、最后 onSuccess（顺序钉死）", async () => {
    const { deps, order, confirm, onError } = makeDeps();
    await expect(runClearBrowsingData(deps)).resolves.toBe("cleared");
    expect(order).toEqual(["confirm", "clear", "success"]);
    expect(confirm).toHaveBeenCalledWith(CLEAR_BROWSING_DATA_CONFIRM);
    expect(onError).not.toHaveBeenCalled();
  });

  it("用户取消 → 一次 clear 都不调、不提示成功也不报错", async () => {
    const { deps, clear, onSuccess, onError } = makeDeps({ confirm: vi.fn(async () => false) });
    await expect(runClearBrowsingData(deps)).resolves.toBe("cancelled");
    expect(clear).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("clear 异步失败 → onError 带上错误信息、不向上抛、不提示成功", async () => {
    const { deps, onSuccess, onError } = makeDeps({
      clear: vi.fn(async () => {
        throw new Error("磁盘忙");
      }),
    });
    await expect(runClearBrowsingData(deps)).resolves.toBe("failed");
    expect(onError).toHaveBeenCalledWith("磁盘忙");
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("clear 同步抛错 / 抛的不是 Error 也落到 onError", async () => {
    const sync = makeDeps({
      clear: () => {
        throw new TypeError("bridge 不可用");
      },
    });
    await expect(runClearBrowsingData(sync.deps)).resolves.toBe("failed");
    expect(sync.onError).toHaveBeenCalledWith("bridge 不可用");

    const str = makeDeps({ clear: () => Promise.reject("纯字符串") });
    await expect(runClearBrowsingData(str.deps)).resolves.toBe("failed");
    expect(str.onError).toHaveBeenCalledWith("纯字符串");
  });

  it("clear 返回 undefined（面板在没有 bridge 时 `window.__browser?.clear…()` 的形态）也能走完", async () => {
    const { deps, onSuccess } = makeDeps({ clear: () => undefined });
    await expect(runClearBrowsingData(deps)).resolves.toBe("cleared");
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("confirm 还没 resolve 之前不会提前 clear（确认是真的在等用户）", async () => {
    let answer: (v: boolean) => void = () => {};
    const { deps, clear } = makeDeps({
      confirm: () =>
        new Promise<boolean>((r) => {
          answer = r;
        }),
    });
    const p = runClearBrowsingData(deps);
    await Promise.resolve();
    await Promise.resolve();
    expect(clear).not.toHaveBeenCalled();
    answer(true);
    await expect(p).resolves.toBe("cleared");
    expect(clear).toHaveBeenCalledTimes(1);
  });
});

describe("接线（源码契约）", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("设置页卡片：useDialog().confirm → runClearBrowsingData；没有自制的两步确认", () => {
    const card = strip(read("src/components/settings/browser-card.tsx"));
    expect(card).toContain('from "@/hooks/use-dialog"');
    expect(card).toMatch(/const \{ confirm \} = useDialog\(\)/);
    expect(card).toMatch(/runClearBrowsingData\(\{\s*confirm,/);
    expect(card).not.toMatch(/CONFIRM_WINDOW_MS|确认清除|confirming|setTimeout/);
    // 按钮不再随「二次确认」变红
    expect(card).not.toContain('"destructive"');
  });

  it("面板菜单：同一条流程（不再各写一份 confirm 文案）", () => {
    const panel = strip(read("src/components/browser/browser-panel.tsx"));
    expect(panel).toMatch(/runClearBrowsingData\(\{\s*confirm,/);
    expect(panel).not.toContain("清除浏览器登录数据？");
  });
});
