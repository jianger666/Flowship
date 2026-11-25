/**
 * 地址栏记忆的交互流程（src/components/browser/history-flow.ts）：联想何时出现、「清除浏览历史」确认 → 执行的顺序。
 * 纯逻辑：弹确认框 / 清除请求 / toast 都用 mock 注入。
 */
import { describe, expect, it, vi } from "vitest";

import {
  addressSuggestionsOf,
  CLEAR_HISTORY_CONFIRM,
  clearHistorySuccessMessage,
  historyErrorText,
  removeSuggestionLabel,
  runClearHistory,
  suggestionLabel,
} from "@/components/browser/history-flow";

import { bm } from "./helpers/bookmarks-fake-fetch";
import { hist } from "./helpers/history-fake-fetch";

const NOW = 2_000_000;

describe("addressSuggestionsOf：联想只在用户敲了字之后出", () => {
  const base = { editing: true, typed: true, query: "exa", history: [hist(1)], bookmarks: [], now: NOW };

  it("聚焦编辑 + 敲过字 → 按查询词给联想", () => {
    const out = addressSuggestionsOf(base);
    expect(out.map((s) => s.url)).toEqual(["https://example.com/p1"]);
    expect(out[0]).toMatchObject({ title: "title 1", historyId: "h-1", bookmarked: false });
  });

  it("聚焦了但还没敲字（地址栏里是当前页地址、已被全选）：不弹——否则每点一下地址栏就有个下拉盖住页面", () => {
    expect(addressSuggestionsOf({ ...base, typed: false })).toEqual([]);
  });

  it("没在编辑（失焦后 / 外部改了地址）：不弹，哪怕 typed 还是真", () => {
    expect(addressSuggestionsOf({ ...base, editing: false })).toEqual([]);
  });

  it("敲的是空白 / 把字删光了：没有联想（不把全部历史摊出来）", () => {
    expect(addressSuggestionsOf({ ...base, query: "" })).toEqual([]);
    expect(addressSuggestionsOf({ ...base, query: "   " })).toEqual([]);
  });

  it("没有匹配 → 空数组（下拉不开）", () => {
    expect(addressSuggestionsOf({ ...base, query: "zzzz-no-such" })).toEqual([]);
  });

  it("收藏也参与联想：只在收藏里的网址 historyId 为 null（没有 × 可点），既在历史又在收藏的合并成一条", () => {
    const out = addressSuggestionsOf({
      ...base,
      query: "example",
      history: [hist(1)],
      bookmarks: [bm(1, { url: "https://example.com/p1", title: "收藏标题" }), bm(2, { url: "https://example.com/only-bookmark", title: "只在收藏" })],
    });
    const byUrl = new Map(out.map((s) => [s.url, s]));
    expect(byUrl.get("https://example.com/p1")).toMatchObject({ historyId: "h-1", bookmarked: true });
    expect(byUrl.get("https://example.com/only-bookmark")).toMatchObject({ historyId: null, bookmarked: true });
    expect(out).toHaveLength(2);
  });

  it("不改入参", () => {
    const history = [hist(1), hist(2)];
    const before = JSON.stringify(history);
    addressSuggestionsOf({ ...base, history });
    expect(JSON.stringify(history)).toBe(before);
  });
});

describe("联想行的文字", () => {
  it("标题优先；标题为空 / 全空白时退回地址（不留空行）", () => {
    expect(suggestionLabel({ title: "示例", url: "https://example.com/" })).toBe("示例");
    expect(suggestionLabel({ title: "", url: "https://example.com/" })).toBe("https://example.com/");
    expect(suggestionLabel({ title: "   ", url: "https://example.com/" })).toBe("https://example.com/");
  });

  it("「×」的无障碍名称引用了这一行是谁", () => {
    expect(removeSuggestionLabel({ title: "示例", url: "https://example.com/" })).toBe("从联想中删除「示例」");
    expect(removeSuggestionLabel({ title: "", url: "https://example.com/" })).toBe("从联想中删除「https://example.com/」");
  });
});

describe("clearHistorySuccessMessage", () => {
  it("清掉几条就说几条", () => {
    expect(clearHistorySuccessMessage(1)).toBe("已清除浏览历史（1 条）");
    expect(clearHistorySuccessMessage(37)).toBe("已清除浏览历史（37 条）");
  });

  it("本来就是空的也要有交代（不然用户以为没点上）；脏数据（负数 / 小数 / NaN）不显示成怪数字", () => {
    for (const n of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(clearHistorySuccessMessage(n), String(n)).toBe("没有需要清除的浏览历史");
    }
  });
});

describe("CLEAR_HISTORY_CONFIRM：确认框文案", () => {
  it("是破坏性确认；说清只清联想记忆、不动收藏 / 登录状态 / 已打开的页面", () => {
    expect(CLEAR_HISTORY_CONFIRM.destructive).toBe(true);
    expect(CLEAR_HISTORY_CONFIRM.title).toContain("浏览历史");
    expect(CLEAR_HISTORY_CONFIRM.description).toContain("地址栏联想");
    expect(CLEAR_HISTORY_CONFIRM.description).toMatch(/不影响收藏夹/);
    expect(CLEAR_HISTORY_CONFIRM.description).toMatch(/登录状态/);
    expect(CLEAR_HISTORY_CONFIRM.confirmLabel.length).toBeGreaterThan(0);
  });
});

describe("runClearHistory：先确认、确认了才清", () => {
  const make = (over: Partial<Parameters<typeof runClearHistory>[0]> = {}) => {
    const deps = {
      confirm: vi.fn(async () => true),
      clear: vi.fn(async () => 3),
      onSuccess: vi.fn(),
      onError: vi.fn(),
      ...over,
    };
    return deps;
  };

  it("确认 → 清除 → onSuccess(清掉的条数)", async () => {
    const deps = make();
    await expect(runClearHistory(deps)).resolves.toBe("cleared");
    expect(deps.confirm).toHaveBeenCalledTimes(1);
    expect(deps.confirm).toHaveBeenCalledWith(CLEAR_HISTORY_CONFIRM);
    expect(deps.clear).toHaveBeenCalledTimes(1);
    expect(deps.onSuccess).toHaveBeenCalledWith(3);
    expect(deps.onError).not.toHaveBeenCalled();
  });

  it("取消 → 一次 clear 都不调、不提示任何东西", async () => {
    const deps = make({ confirm: vi.fn(async () => false) });
    await expect(runClearHistory(deps)).resolves.toBe("cancelled");
    expect(deps.clear).not.toHaveBeenCalled();
    expect(deps.onSuccess).not.toHaveBeenCalled();
    expect(deps.onError).not.toHaveBeenCalled();
  });

  it("本来就是空的：clear 返回 0 照样走 onSuccess（由消息函数说「没有需要清除的」）", async () => {
    const deps = make({ clear: vi.fn(async () => 0) });
    await expect(runClearHistory(deps)).resolves.toBe("cleared");
    expect(deps.onSuccess).toHaveBeenCalledWith(0);
  });

  it("清除失败（reject）→ onError(原因)，不调 onSuccess，也不向上抛（调用方是点击处理器）", async () => {
    const deps = make({ clear: vi.fn(async () => Promise.reject(new Error("磁盘不可写"))) });
    await expect(runClearHistory(deps)).resolves.toBe("failed");
    expect(deps.onError).toHaveBeenCalledWith("磁盘不可写");
    expect(deps.onSuccess).not.toHaveBeenCalled();
  });

  it("clear 同步抛错也一样落到 onError", async () => {
    const deps = make({
      clear: vi.fn(() => {
        throw new Error("sync boom");
      }),
    });
    await expect(runClearHistory(deps)).resolves.toBe("failed");
    expect(deps.onError).toHaveBeenCalledWith("sync boom");
  });

  it("清除已经成功、只是成功提示自己出了岔子：不会被误报成「清除失败」（onError 不被调）", async () => {
    const deps = make({
      onSuccess: vi.fn(() => {
        throw new Error("toast 炸了");
      }),
    });
    await expect(runClearHistory(deps)).rejects.toThrow("toast 炸了");
    expect(deps.clear).toHaveBeenCalledTimes(1);
    expect(deps.onError).not.toHaveBeenCalled();
  });

  it("确认框先于清除：清除发生时确认必然已经 resolve", async () => {
    const order: string[] = [];
    const deps = make({
      confirm: vi.fn(async () => {
        order.push("confirm");
        return true;
      }),
      clear: vi.fn(async () => {
        order.push("clear");
        return 1;
      }),
    });
    await runClearHistory(deps);
    expect(order).toEqual(["confirm", "clear"]);
  });
});

describe("historyErrorText", () => {
  it("Error 取 message（去首尾空白）；空 message / 非 Error 兜底成通用文案（不把 [object Object] 透给用户）", () => {
    expect(historyErrorText(new Error("  读取失败  "))).toBe("读取失败");
    expect(historyErrorText(new Error(""))).toBe("操作失败，请稍后重试");
    expect(historyErrorText("字符串")).toBe("操作失败，请稍后重试");
    expect(historyErrorText({ message: "x" })).toBe("操作失败，请稍后重试");
    expect(historyErrorText(undefined)).toBe("操作失败，请稍后重试");
  });
});
