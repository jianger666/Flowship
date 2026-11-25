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
  clearSuccessMessage,
  reloadedTabsOf,
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

  it("确认框文案写明副作用：已打开的网页会重新加载（未保存的内容丢失）、无痕标签不受影响", () => {
    // 不停下页面的话页面里的内存 token 会把登录态写回；停下就意味着页面会重新加载——要在用户点之前就让他知道
    expect(CLEAR_BROWSING_DATA_CONFIRM.description).toContain("已打开的网页会重新加载");
    expect(CLEAR_BROWSING_DATA_CONFIRM.description).toContain("未保存");
    expect(CLEAR_BROWSING_DATA_CONFIRM.description).toContain("无痕标签页不受影响");
  });

  it("onSuccess 收到 clear 的返回值（主进程给的 { reloadedTabs }），用来出提示", async () => {
    const { deps, onSuccess } = makeDeps({ clear: vi.fn(async () => ({ reloadedTabs: 2 })) });
    await runClearBrowsingData(deps);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith({ reloadedTabs: 2 });
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

describe("clearSuccessMessage / reloadedTabsOf：重新加载了页面就说一声", () => {
  it("有标签被重新加载 → 提示里带数量（否则用户会奇怪页面为什么自己刷新了）", () => {
    expect(clearSuccessMessage({ reloadedTabs: 3 })).toBe("已清除浏览器登录数据，已重新加载 3 个标签页");
    expect(reloadedTabsOf({ reloadedTabs: 1 })).toBe(1);
  });

  it("0 个 / 老壳返回 undefined / 形状不对 → 只说已清除，绝不因为返回值形状把「成功」变成报错", () => {
    const plain = "已清除浏览器登录数据";
    for (const r of [{ reloadedTabs: 0 }, undefined, null, {}, "x", 5, { reloadedTabs: "2" }, { reloadedTabs: -1 }, { reloadedTabs: 1.5 }, { reloadedTabs: Number.NaN }]) {
      expect(clearSuccessMessage(r), JSON.stringify(r)).toBe(plain);
      expect(reloadedTabsOf(r)).toBe(0);
    }
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

  it("两处成功提示都走 clearSuccessMessage（带重新加载的标签数）；设置页把主进程的结果交回去而不是丢弃", () => {
    const card = strip(read("src/components/settings/browser-card.tsx"));
    const panel = strip(read("src/components/browser/browser-panel.tsx"));
    const ok = /onSuccess:\s*\(result\)\s*=>\s*toast\.success\(clearSuccessMessage\(result\)\)/;
    expect(card).toMatch(ok);
    expect(panel).toMatch(ok);
    expect(card).toMatch(/return await api\.clearBrowsingData\(\)/);
    // 不再各写各的固定文案
    expect(card).not.toContain("已清除内置浏览器的登录数据");
    expect(panel).not.toMatch(/toast\.success\("已清除/);
  });
});
