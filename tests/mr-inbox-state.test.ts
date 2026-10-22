/**
 * 收件箱前端状态变换（S13-04 / S13-05 / S13-19）：
 * - 扫描期间的乐观操作重放到新结果上，已忽略 / 已合并的条目不复活
 * - 扫描失败保留上一次成功的数据（列表 / 角标 / 通知基线）
 * - 忽略后可撤销（快照幂等塞回）
 * - N9-01：force 刷新遇到在飞刷新时登记一次尾随 force（不再被丢弃），驱动函数脱离 React 单测
 * 另有对 use-mr-inbox.tsx / 面板接线的源码契约断言。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  applyInboxPatches,
  createInboxRefreshGate,
  finishInboxRefresh,
  nextDataOnScanFailure,
  removeInboxUrl,
  requestInboxRefresh,
  restoreInboxSnapshot,
  runCoalescedInboxRefresh,
  snapshotInboxUrl,
  type InboxGroupsShape,
  type InboxRefreshGate,
} from "@/lib/mr-inbox-state";

interface Mr {
  mrUrl: string;
  seenAtMs: number | null;
}
interface Bug {
  bugUrl: string;
  seenAtMs: number | null;
}
interface Data extends InboxGroupsShape {
  pendingMr: Mr[];
  myBugs: Bug[];
  pendingRegression: Bug[];
}

const mk = (over: Partial<Data> = {}): Data => ({
  status: "ok",
  pendingMr: [
    { mrUrl: "https://g/a/-/merge_requests/1", seenAtMs: null },
    { mrUrl: "https://g/a/-/merge_requests/2", seenAtMs: null },
  ],
  myBugs: [{ bugUrl: "https://m/bug/1", seenAtMs: null }],
  pendingRegression: [{ bugUrl: "https://m/bug/2", seenAtMs: null }],
  ...over,
});

describe("S13-04 扫描期间的乐观操作重放", () => {
  it("扫描响应里还带着刚忽略的条目：重放补丁后不复活", () => {
    // 扫描在忽略之前读的快照 → 响应里仍含 MR 1
    const fresh = mk();
    const ignoreMr1 = (d: Data) =>
      removeInboxUrl(d, "https://g/a/-/merge_requests/1");
    const out = applyInboxPatches(fresh, [ignoreMr1]);
    expect(out.pendingMr.map((m) => m.mrUrl)).toEqual([
      "https://g/a/-/merge_requests/2",
    ]);
  });

  it("多个补丁按发生顺序重放（忽略 bug + 标已读）", () => {
    const fresh = mk();
    const out = applyInboxPatches(fresh, [
      (d) => removeInboxUrl(d, "https://m/bug/1"),
      (d) => ({
        ...d,
        pendingRegression: d.pendingRegression.map((b) => ({
          ...b,
          seenAtMs: 123,
        })),
      }),
    ]);
    expect(out.myBugs).toEqual([]);
    expect(out.pendingRegression[0].seenAtMs).toBe(123);
  });

  it("补丁顺序敏感时严格按发生顺序重放（先忽略再撤销 ≠ 先撤销再忽略）", () => {
    const url = "https://g/a/-/merge_requests/1";
    const fresh = mk();
    const snap = snapshotInboxUrl(fresh, url);
    const ignore = (d: Data) => removeInboxUrl(d, url);
    const restore = (d: Data) => restoreInboxSnapshot(d, snap);
    // 忽略 → 撤销：条目在
    expect(
      applyInboxPatches(fresh, [ignore, restore]).pendingMr.map((m) => m.mrUrl),
    ).toContain(url);
    // 撤销 → 忽略：条目不在
    expect(
      applyInboxPatches(fresh, [restore, ignore]).pendingMr.map((m) => m.mrUrl),
    ).not.toContain(url);
  });

  it("没有补丁时原样返回", () => {
    const fresh = mk();
    expect(applyInboxPatches(fresh, [])).toBe(fresh);
  });
});

describe("S13-05 扫描失败保留上次成功数据", () => {
  const errorData = (message: string): Data => ({
    status: "error",
    pendingMr: [],
    myBugs: [],
    pendingRegression: [],
    message,
  });

  it("上次是 ok：原对象保留（列表 / 角标 / 通知基线不动）", () => {
    const prev = mk();
    expect(nextDataOnScanFailure(prev, "boom", errorData)).toBe(prev);
  });

  it("首拉就失败：落成 error 态 + 空列表", () => {
    const out = nextDataOnScanFailure<Data>(null, "boom", errorData);
    expect(out.status).toBe("error");
    expect(out.message).toBe("boom");
    expect(out.pendingMr).toEqual([]);
  });

  it("上次是降级态（未登录）：落成 error 态", () => {
    const prev = mk({ status: "not_authed", pendingMr: [] });
    expect(nextDataOnScanFailure(prev, "boom", errorData).status).toBe("error");
  });
});

describe("S13-19 忽略后撤销", () => {
  it("快照 → 移除 → 撤销：条目回来且不重复", () => {
    const url = "https://g/a/-/merge_requests/1";
    const data = mk();
    const snap = snapshotInboxUrl(data, url);
    expect(snap.pendingMr?.mrUrl).toBe(url);
    expect(snap.myBugs).toBeUndefined();

    const removed = removeInboxUrl(data, url);
    expect(removed.pendingMr).toHaveLength(1);

    const restored = restoreInboxSnapshot(removed, snap);
    expect(restored.pendingMr.map((m) => m.mrUrl)).toContain(url);
    // 幂等：重复撤销不会塞两份
    const twice = restoreInboxSnapshot(restored, snap);
    expect(twice.pendingMr).toHaveLength(2);
  });

  it("待回归 bug 同样可撤销：移除后确实没了、撤销后回来、重复撤销不重复", () => {
    const url = "https://m/bug/2";
    const data = mk();
    const snap = snapshotInboxUrl(data, url);
    expect(snap.pendingRegression?.bugUrl).toBe(url);
    const removed = removeInboxUrl(data, url);
    expect(removed.pendingRegression).toEqual([]);
    const restored = restoreInboxSnapshot(removed, snap);
    expect(restored.pendingRegression.map((b) => b.bugUrl)).toEqual([url]);
    expect(
      restoreInboxSnapshot(restored, snap).pendingRegression,
    ).toHaveLength(1);
  });

  it("我的 BUG 同样可撤销（快照 / 幂等）", () => {
    const url = "https://m/bug/1";
    const data = mk();
    const snap = snapshotInboxUrl(data, url);
    expect(snap.myBugs?.bugUrl).toBe(url);
    const removed = removeInboxUrl(data, url);
    expect(removed.myBugs).toEqual([]);
    const restored = restoreInboxSnapshot(removed, snap);
    expect(restored.myBugs.map((b) => b.bugUrl)).toEqual([url]);
    expect(restoreInboxSnapshot(restored, snap).myBugs).toHaveLength(1);
  });

  it("快照里没有条目（url 已不在数据里）：撤销是 no-op、不凭空造条目", () => {
    const data = mk();
    const snap = snapshotInboxUrl(data, "https://nope");
    expect(restoreInboxSnapshot(data, snap)).toEqual(data);
  });
});

describe("N9-01 刷新调度：force 遇到在飞刷新不能被丢弃", () => {
  describe("纯状态机", () => {
    it("空闲 → 任何请求都立刻开跑，并占用闸门（尾随登记清零）", () => {
      for (const force of [false, true]) {
        const r = requestInboxRefresh(createInboxRefreshGate(), force);
        expect(r.action).toBe("start");
        expect(r.gate).toEqual({ running: true, trailingForce: false });
      }
    });

    it("在飞 + 普通请求 → 并入在飞那次（闸门原样不变）", () => {
      const gate: InboxRefreshGate = { running: true, trailingForce: false };
      const r = requestInboxRefresh(gate, false);
      expect(r.action).toBe("skipped");
      expect(r.gate).toBe(gate);
    });

    it("在飞 + force → 登记尾随（不是丢弃）；重复登记仍只有一个标记", () => {
      const first = requestInboxRefresh({ running: true, trailingForce: false }, true);
      expect(first.action).toBe("queued");
      expect(first.gate).toEqual({ running: true, trailingForce: true });
      const again = requestInboxRefresh(first.gate, true);
      expect(again.action).toBe("queued");
      expect(again.gate).toEqual({ running: true, trailingForce: true });
    });

    it("结束：有尾随 → 保持 running 并要求再跑一次；没有 → 释放闸门", () => {
      expect(finishInboxRefresh({ running: true, trailingForce: true })).toEqual({
        runTrailing: true,
        gate: { running: true, trailingForce: false },
      });
      expect(finishInboxRefresh({ running: true, trailingForce: false })).toEqual({
        runTrailing: false,
        gate: { running: false, trailingForce: false },
      });
    });
  });

  describe("驱动 runCoalescedInboxRefresh（假 scanOnce，手动控制每轮何时结束）", () => {
    /** 可手动放行的假扫描：记录每轮的 force、并发峰值 */
    const harness = () => {
      const gateRef = { current: createInboxRefreshGate() };
      const calls: boolean[] = [];
      const pending: Array<() => void> = [];
      let inFlight = 0;
      let maxInFlight = 0;
      const events: string[] = [];
      const scanOnce = (force: boolean): Promise<void> => {
        calls.push(force);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<void>((resolve) => {
          pending.push(() => {
            inFlight -= 1;
            resolve();
          });
        });
      };
      const run = (force: boolean) =>
        runCoalescedInboxRefresh({
          gateRef,
          force,
          scanOnce,
          onStart: () => events.push("start"),
          onSettled: () => events.push("settled"),
        });
      /** 放行最早一个在飞的扫描，并让出事件循环让驱动推进到下一轮 */
      const finishOne = async () => {
        pending.shift()!();
        await new Promise((r) => setImmediate(r));
      };
      return { gateRef, calls, run, finishOne, events, stats: () => ({ maxInFlight }) };
    };

    it("核心：在飞时的 force 不被丢弃——在飞那次结束后立刻再 force 扫一遍", async () => {
      const h = harness();
      const first = h.run(false); // 轮询刷新在飞（操作之前发起的旧扫描）
      expect(h.calls).toEqual([false]);

      await h.run(true); // 撤销忽略后的 force：登记尾随、立刻返回
      expect(h.calls).toEqual([false]); // 此刻还不会并发开第二个

      await h.finishOne(); // 在飞的旧扫描结束
      expect(h.calls).toEqual([false, true]); // 尾随的 force 紧接着跑
      await h.finishOne();
      await first;
      expect(h.gateRef.current).toEqual(createInboxRefreshGate());
    });

    it("多次 force 合并成一次尾随（不会排长队）", async () => {
      const h = harness();
      const first = h.run(false);
      await h.run(true);
      await h.run(true);
      await h.run(true);
      await h.finishOne();
      expect(h.calls).toEqual([false, true]);
      await h.finishOne();
      await first;
      expect(h.calls).toEqual([false, true]); // 三次 force 只多跑了一轮
    });

    it("在飞期间的普通刷新并入在飞那次，不追加扫描", async () => {
      const h = harness();
      const first = h.run(false);
      await h.run(false);
      await h.run(false);
      await h.finishOne();
      await first;
      expect(h.calls).toEqual([false]);
    });

    it("尾随那一轮在飞时又来 force：再登记一轮（它发起时也早于这次操作）", async () => {
      const h = harness();
      const first = h.run(false);
      await h.run(true);
      await h.finishOne(); // 第一轮结束 → 尾随（第二轮）开跑
      expect(h.calls).toEqual([false, true]);
      await h.run(true); // 第二轮在飞时再来一次 force
      await h.finishOne();
      expect(h.calls).toEqual([false, true, true]);
      await h.finishOne();
      await first;
      expect(h.calls).toEqual([false, true, true]);
    });

    it("扫描永不并发（尾随一定等在飞的结束后才开）", async () => {
      const h = harness();
      const first = h.run(true);
      await h.run(true);
      await h.finishOne();
      await h.finishOne();
      await first;
      expect(h.stats().maxInFlight).toBe(1);
    });

    it("refreshing 状态在连跑期间不闪烁：只 start 一次、全部结束后 settled 一次", async () => {
      const h = harness();
      const first = h.run(false);
      await h.run(true);
      await h.finishOne();
      expect(h.events).toEqual(["start"]); // 尾随期间仍是 refreshing
      await h.finishOne();
      await first;
      expect(h.events).toEqual(["start", "settled"]);
    });

    it("闸门空闲后新的请求照常开跑；排队的 force 不会残留到下一次", async () => {
      const h = harness();
      const first = h.run(false);
      await h.run(true);
      await h.finishOne();
      await h.finishOne();
      await first;
      expect(h.calls).toEqual([false, true]);

      const next = h.run(false);
      expect(h.calls).toEqual([false, true, false]);
      await h.finishOne();
      await next;
      expect(h.calls).toEqual([false, true, false]); // 没有凭空多出尾随
    });

    it("登记尾随的调用立刻 resolve，不阻塞调用方（与旧「丢弃」行为的返回时机一致）", async () => {
      const h = harness();
      void h.run(false);
      let resolved = false;
      void h.run(true).then(() => {
        resolved = true;
      });
      await new Promise((r) => setImmediate(r));
      expect(resolved).toBe(true);
    });

    it("scanOnce 意外抛错：闸门释放、refreshing 复位，之后的刷新不会卡死", async () => {
      const gateRef = { current: createInboxRefreshGate() };
      const events: string[] = [];
      const boom = runCoalescedInboxRefresh({
        gateRef,
        force: false,
        scanOnce: async () => {
          throw new Error("boom");
        },
        onStart: () => events.push("start"),
        onSettled: () => events.push("settled"),
      });
      await expect(boom).rejects.toThrow("boom");
      expect(gateRef.current).toEqual(createInboxRefreshGate());
      expect(events).toEqual(["start", "settled"]);

      const calls: boolean[] = [];
      await runCoalescedInboxRefresh({
        gateRef,
        force: true,
        scanOnce: async (f) => {
          calls.push(f);
        },
      });
      expect(calls).toEqual([true]);
    });
  });
});

describe("接线契约", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const hook = readFileSync(
    path.join(root, "src/hooks/use-mr-inbox.tsx"),
    "utf-8",
  );
  const panel = readFileSync(
    path.join(root, "src/components/mr-inbox/mr-inbox-panel.tsx"),
    "utf-8",
  );

  it("refresh 失败走 failScan、不再把已有列表翻成 error 态", () => {
    expect(hook).toContain("nextDataOnScanFailure");
    expect(hook).not.toMatch(/\.\.\.prev,\s*status: "error"/);
  });

  it("refresh 成功时重放扫描期间的补丁", () => {
    expect(hook).toContain("applyInboxPatches(fresh, patches)");
    expect(hook).toContain("pendingPatchesRef.current.push(patch)");
  });

  describe("N9-01：hook 里 refresh 真的接上了尾随 force 调度", () => {
    const sf = ts.createSourceFile(
      "use-mr-inbox.tsx",
      hook,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const walk = (root: ts.Node, visit: (n: ts.Node) => void) => {
      const go = (n: ts.Node) => {
        visit(n);
        ts.forEachChild(n, go);
      };
      go(root);
    };
    /** 找 `const <name> = useCallback(<fn>, deps)`，返回 fn */
    const useCallbackFn = (name: string): ts.ArrowFunction | undefined => {
      let found: ts.ArrowFunction | undefined;
      walk(sf, (n) => {
        if (
          ts.isVariableDeclaration(n) &&
          n.name.getText(sf) === name &&
          n.initializer &&
          ts.isCallExpression(n.initializer) &&
          n.initializer.expression.getText(sf) === "useCallback"
        ) {
          const fn = n.initializer.arguments[0];
          if (fn && ts.isArrowFunction(fn)) found = fn;
        }
      });
      return found;
    };
    const callsIn = (root: ts.Node, callee: string): ts.CallExpression[] => {
      const out: ts.CallExpression[] = [];
      walk(root, (n) => {
        if (ts.isCallExpression(n) && n.expression.getText(sf) === callee) out.push(n);
      });
      return out;
    };
    /** 对象字面量参数的「属性名 → 初始化文本」 */
    const objectArgProps = (call: ts.CallExpression): Map<string, string> => {
      const props = new Map<string, string>();
      const arg = call.arguments[0];
      if (arg && ts.isObjectLiteralExpression(arg)) {
        for (const p of arg.properties) {
          if (ts.isShorthandPropertyAssignment(p)) props.set(p.name.getText(sf), p.name.getText(sf));
          else if (ts.isPropertyAssignment(p)) props.set(p.name.getText(sf), p.initializer.getText(sf));
        }
      }
      return props;
    };

    it("refresh = useCallback(...) 的实现就是 runCoalescedInboxRefresh，闸门 / scanOnce / force 都传了", () => {
      const refresh = useCallbackFn("refresh");
      expect(refresh, "必须有 const refresh = useCallback(...)").toBeDefined();
      const calls = callsIn(refresh!, "runCoalescedInboxRefresh");
      expect(calls).toHaveLength(1);
      const props = objectArgProps(calls[0]!);
      expect(props.get("gateRef")).toBe("refreshGateRef");
      expect(props.get("scanOnce")).toBe("scanOnce");
      // force 直接来自调用方 opts（不能被写死成 false）
      expect(props.get("force")).toBe("opts?.force === true");
      expect(props.get("onStart")).toContain("setRefreshing(true)");
      expect(props.get("onSettled")).toContain("setRefreshing(false)");
    });

    it("refresh 自己没有「在飞就早返回」的丢弃逻辑；旧的 refreshingRef 已被闸门取代", () => {
      const refresh = useCallbackFn("refresh")!;
      let earlyReturnIf = false;
      walk(refresh, (n) => {
        if (ts.isIfStatement(n)) earlyReturnIf = true;
      });
      expect(earlyReturnIf).toBe(false);
      expect(hook).not.toContain("refreshingRef");
    });

    it("scanOnce 不碰闸门 / refreshing 状态（只管单轮），闸门只由驱动函数动", () => {
      const scanOnce = useCallbackFn("scanOnce");
      expect(scanOnce).toBeDefined();
      const text = scanOnce!.getText(sf);
      expect(text).not.toContain("refreshGateRef");
      expect(text).not.toContain("setRefreshing");
    });

    it("补丁入队开关读的是闸门的 running（含尾随交接期间）", () => {
      expect(hook).toContain("if (refreshGateRef.current.running) pendingPatchesRef.current.push(patch)");
    });

    it("撤销忽略：塞回条目后仍调 refresh({ force: true })（靠调度合并，不再被丢）", () => {
      const restore = useCallbackFn("restoreIgnored");
      expect(restore, "必须有 const restoreIgnored = useCallback(...)").toBeDefined();
      const refreshCalls = callsIn(restore!, "refresh");
      expect(refreshCalls).toHaveLength(1);
      expect(refreshCalls[0]!.arguments[0]!.getText(sf).replace(/\s+/g, "")).toBe("{force:true}");
    });
  });

  it("面板挂错误条 + 忽略 toast 带撤销", () => {
    // N1-01 粒度：错误条改读结构化的 scanNotice（按场景给文案，行为见 mr-inbox-partial-streak.test.ts）
    expect(panel).toContain("scanNotice");
    expect(panel).toContain('label: "撤销"');
    expect(panel).toContain("restoreIgnored");
  });
});
