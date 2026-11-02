/**
 * 代际守卫（lib/cancel-slot 的 createGenerationGuard）的行为测试 + 三处接线：
 *  - useMcpHealth：布尔 aliveRef 在「关面板→快速重开」时会让旧探测的 finally 把新探测的 spinner 提前清掉、
 *    旧结果也会并进新一代的 health；改代际后旧代整体作废。
 *  - RequirementGroupDialog：关闭后重开，旧请求成功不能把新开的对话框关掉（toast / onTaskUpdate 照常），
 *    但要刷新绑定卡；同一实例切任务（open 不翻转）同样算「换了一代」。
 *
 * 并发场景用的是**生产代码真实调用的纯函数**（`runGuardedTask` 被 use-mcp-health 的 probe 调用、`resolveLanding`
 * 被 requirement-group-dialog 的落地处理调用），不是手写模拟；接线是否真调用它们由底部的源码契约断言。
 * 唯一没法在 node 环境下行为化的是「React effect 随 open / taskId 变化而 next() / invalidate()」，
 * 那一段只有源码契约（没有 jsdom / 渲染器）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  createGenerationGuard,
  resolveFailureLanding,
  resolveLanding,
  runGuardedTask,
} from "@/lib/cancel-slot";

describe("createGenerationGuard", () => {
  it("初始无存活代：current = 0，任何代号（含 0）都不算当前", () => {
    const g = createGenerationGuard();
    expect(g.current()).toBe(0);
    expect(g.isCurrent(0)).toBe(false);
    expect(g.isCurrent(1)).toBe(false);
  });

  it("next 开新代：返回递增代号并成为当前；旧代号立刻失效", () => {
    const g = createGenerationGuard();
    const a = g.next();
    expect(a).toBeGreaterThan(0);
    expect(g.isCurrent(a)).toBe(true);
    const b = g.next();
    expect(b).toBeGreaterThan(a);
    expect(g.isCurrent(a)).toBe(false);
    expect(g.isCurrent(b)).toBe(true);
    expect(g.current()).toBe(b);
  });

  it("invalidate（关闭 / 卸载）：当前代失效、current 归 0；之后 next 的代号不会撞回旧代号", () => {
    const g = createGenerationGuard();
    const a = g.next();
    g.invalidate();
    expect(g.isCurrent(a)).toBe(false);
    expect(g.current()).toBe(0);
    const b = g.next();
    expect(b).not.toBe(a);
    expect(g.isCurrent(a)).toBe(false);
  });
});

/** 可手动 resolve / reject 的 promise（控制「请求何时落地」） */
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("runGuardedTask（use-mcp-health 的 probe 真实调用）", () => {
  const makeHandlers = () => {
    const log: string[] = [];
    return {
      log,
      handlers: {
        onStart: () => log.push("start"),
        onResult: (v: string) => log.push(`result:${v}`),
        onError: (e: unknown) => log.push(`error:${String(e)}`),
        onSettled: () => log.push("settled"),
      },
    };
  };

  it("同一代内成功：start → result → settled", async () => {
    const g = createGenerationGuard();
    g.next();
    const { log, handlers } = makeHandlers();
    await runGuardedTask(g, async () => "ok", handlers);
    expect(log).toEqual(["start", "result:ok", "settled"]);
  });

  it("同一代内失败：start → error → settled", async () => {
    const g = createGenerationGuard();
    g.next();
    const { log, handlers } = makeHandlers();
    await runGuardedTask(g, async () => Promise.reject("boom"), handlers);
    expect(log).toEqual(["start", "error:boom", "settled"]);
  });

  it("没有存活代（面板没开 / 已卸载）：task 都不启动", async () => {
    const g = createGenerationGuard();
    const { log, handlers } = makeHandlers();
    let started = false;
    await runGuardedTask(g, async () => { started = true; return "x"; }, handlers);
    expect(started).toBe(false);
    expect(log).toEqual([]);
  });

  it("探测 A 在途 → 关闭 → 重开探测 B：A 迟到（成功）时 result / settled 都被丢弃，不动 B 的状态", async () => {
    const g = createGenerationGuard();
    g.next();
    const a = deferred<string>();
    const A = makeHandlers();
    const pa = runGuardedTask(g, () => a.promise, A.handlers);
    g.invalidate();
    g.next();
    const b = deferred<string>();
    const B = makeHandlers();
    const pb = runGuardedTask(g, () => b.promise, B.handlers);

    a.resolve("A");
    await pa;
    expect(A.log).toEqual(["start"]); // 旧代：不 result、不 settled（不会把 B 的 spinner 提前清掉）
    expect(B.log).toEqual(["start"]);

    b.resolve("B");
    await pb;
    expect(B.log).toEqual(["start", "result:B", "settled"]);
  });

  it("旧一代迟到的失败同样被丢弃（不把错误提示盖到新一代上）", async () => {
    const g = createGenerationGuard();
    g.next();
    const a = deferred<string>();
    const A = makeHandlers();
    const pa = runGuardedTask(g, () => a.promise, A.handlers);
    g.invalidate();
    g.next();
    a.reject("旧错误");
    await pa;
    expect(A.log).toEqual(["start"]);
  });

  it("关闭（invalidate）后落地：同样丢弃", async () => {
    const g = createGenerationGuard();
    g.next();
    const a = deferred<string>();
    const A = makeHandlers();
    const pa = runGuardedTask(g, () => a.promise, A.handlers);
    g.invalidate();
    a.resolve("late");
    await pa;
    expect(A.log).toEqual(["start"]);
  });
});

describe("resolveLanding（requirement-group-dialog 的落地处理真实调用）", () => {
  it("同一次打开里落地：close", () => {
    const g = createGenerationGuard();
    const gen = g.next();
    expect(resolveLanding(g, gen)).toBe("close");
  });

  it("关闭后重开才落地：不能关新开的框，但弹窗开着 → refresh（绑定卡要刷新）", () => {
    const g = createGenerationGuard();
    const gen = g.next();
    g.invalidate();
    g.next();
    expect(resolveLanding(g, gen)).toBe("refresh");
  });

  it("同一实例切任务（open 一直为 true、守卫被 next()）后旧任务请求落地：不关新任务的框，refresh", () => {
    const g = createGenerationGuard();
    const gen = g.next(); // 任务 A 打开
    g.next(); // 切到任务 B：effect 因 taskId 变化重跑
    expect(resolveLanding(g, gen)).toBe("refresh");
  });

  it("关着的时候落地：none（下次打开本来就会重新拉状态）", () => {
    const g = createGenerationGuard();
    const gen = g.next();
    g.invalidate();
    expect(resolveLanding(g, gen)).toBe("none");
  });

  it("没领到代号（gen = 0，弹窗没开时发起的）：none / refresh 都不是 close", () => {
    const g = createGenerationGuard();
    expect(resolveLanding(g, 0)).toBe("none");
    g.next();
    expect(resolveLanding(g, 0)).toBe("refresh");
  });
});

describe("resolveFailureLanding（requirement-group-dialog 的失败分支落地真实调用）", () => {
  it("同一次打开里失败：inline（用户正盯着这次请求的弹窗，照常写内联错误 / 引导）", () => {
    const g = createGenerationGuard();
    const gen = g.next();
    expect(resolveFailureLanding(g, gen)).toBe("inline");
  });

  it("同一实例切任务（open 一直为 true、守卫被 next()）后旧任务请求失败：toast，不写新任务的内联状态", () => {
    const g = createGenerationGuard();
    const gen = g.next(); // 任务 A 打开
    g.next(); // 切到任务 B
    expect(resolveFailureLanding(g, gen)).toBe("toast");
  });

  it("关闭后重开才失败：toast（旧一代的内联状态不属于新开的弹窗）", () => {
    const g = createGenerationGuard();
    const gen = g.next();
    g.invalidate();
    g.next();
    expect(resolveFailureLanding(g, gen)).toBe("toast");
  });

  it("关闭 / 卸载后失败：toast（用户发起的请求失败了仍要让他知道，不能静默吞掉）", () => {
    const g = createGenerationGuard();
    const gen = g.next();
    g.invalidate();
    expect(resolveFailureLanding(g, gen)).toBe("toast");
  });

  it("没领到代号（gen = 0）：不是 inline", () => {
    const g = createGenerationGuard();
    expect(resolveFailureLanding(g, 0)).toBe("toast");
    g.next();
    expect(resolveFailureLanding(g, 0)).toBe("toast");
  });

  it("与 resolveLanding 同口径：凡是成功路径判成「close」的代，失败路径一定是 inline，反之亦然", () => {
    const g = createGenerationGuard();
    const cases: number[] = [0, g.next(), g.next()]; // 无代号 / 已作废的旧代 / 当前代
    for (const gen of cases) {
      expect(resolveFailureLanding(g, gen) === "inline", `live gen=${g.current()} 查 ${gen}`).toBe(
        resolveLanding(g, gen) === "close",
      );
    }
    g.invalidate();
    for (const gen of cases) {
      expect(resolveFailureLanding(g, gen) === "inline", `invalidate 后查 ${gen}`).toBe(
        resolveLanding(g, gen) === "close",
      );
    }
  });

  it("复现：任务 A 的 needGroupRebuild 迟到落在任务 B 上——B 的 rebuild 引导保持空，A 的失败走 toast", async () => {
    // 用生产的 resolveFailureLanding 复刻组件 landFailure 的两分支（组件本身没有渲染器可跑，接线由契约测试盯）
    const g = createGenerationGuard();
    const state = { rebuild: null as string | null, autoError: null as string | null };
    const toasts: string[] = [];
    const landFailure = (gen: number, toastMessage: string | null, applyInline: () => void) => {
      if (resolveFailureLanding(g, gen) === "inline") applyInline();
      else if (toastMessage) toasts.push(toastMessage);
    };

    const genA = g.next(); // 任务 A 的弹窗
    const req = deferred<{ chatId: string }>();
    const runAutoA = (async () => {
      const r = await req.promise; // ensureRequirementGroup(A) 在途
      landFailure(genA, null, () => {
        state.rebuild = r.chatId;
      });
    })();
    g.next(); // 同一实例切到任务 B（open 不翻转）：B 开场清掉 rebuild
    state.rebuild = null;
    req.resolve({ chatId: "oc_A" }); // A 的请求迟到：要求重建
    await runAutoA;
    expect(state.rebuild).toBeNull(); // 修复前这里会是 "oc_A"，B 的主按钮会变成「重新建群并绑定」

    // 同理 A 的真错误：不写 B 的内联错误、改 toast
    const failA = (async () => {
      await Promise.resolve();
      landFailure(genA, "创建需求群失败：A 的网络错误", () => {
        state.autoError = "创建需求群失败：A 的网络错误";
      });
    })();
    await failA;
    expect(state.autoError).toBeNull();
    expect(toasts).toEqual(["创建需求群失败：A 的网络错误"]);
  });
});

describe("接线契约", () => {
  const read = (rel: string): string => readFileSync(path.join(process.cwd(), rel), "utf8");

  it("useMcpHealth：不再用布尔 aliveRef，改代际守卫；probe 经 runGuardedTask 落地；cleanup 里 invalidate", () => {
    const src = read("src/hooks/use-mcp-health.ts");
    expect(src).not.toContain("aliveRef");
    expect(src).toContain("createGenerationGuard");
    expect(src).toMatch(/guard\.invalidate\(\);/);
    expect(src).toMatch(/guard\.next\(\);/);
    // probe 的并发语义全部收在 runGuardedTask 里（上面的行为测试覆盖），hook 只传 guard + 各回调
    expect(src).toMatch(/await runGuardedTask\(guard,\s*\(\) => fetchMcpHealth\(servers\),/);
  });

  it("RequirementGroupDialog：四个成功路径都经 landSuccess（resolveLanding）落地，关弹窗只剩 close 分支一处", () => {
    const src = read("src/components/tasks/requirement-group-dialog.tsx");
    expect(src).toContain("createGenerationGuard");
    expect(src).toContain("resolveLanding(sessionGuard, gen)");
    // 成功路径不再直接 onOpenChange(false)：全文件只剩落地处理里 close 分支那一处
    expect(src.match(/onOpenChange\(false\)/g)?.length).toBe(1);
    expect(src).toMatch(/action === "close"\) onOpenChange\(false\);/);
    expect(src.match(/landSuccess\(gen\)/g)?.length).toBe(4);
  });

  it("RequirementGroupDialog：守卫 effect 同时跟 open 与 taskId（同一实例切任务也换代）；旧一代落地走 refresh 刷新绑定卡", () => {
    const src = read("src/components/tasks/requirement-group-dialog.tsx");
    // 末尾带 cleanup：依赖变化后新 effect 体立刻重新 next()，只有卸载才真正落在「无存活代」
    expect(src).toMatch(
      /if \(open\) sessionGuard\.next\(\);\s*else sessionGuard\.invalidate\(\);\s*return \(\) => sessionGuard\.invalidate\(\);\s*\}, \[open, taskId, sessionGuard\]\);/,
    );
    // refresh 必须经 ref 取「最新的」loadStatus：闭包里的是发请求时旧任务的，会把旧任务状态刷进新任务的卡片
    expect(src).toMatch(/action === "refresh"\) void loadStatusRef\.current\(\);/);
    expect(src).toMatch(/loadStatusRef\.current = loadStatus;/);
  });
});
