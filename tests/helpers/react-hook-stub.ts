/**
 * React hook 的最小「槽位式」运行时桩（本仓 vitest 是 node 环境，没有 jsdom / testing-library）。
 *
 * 为什么需要它：`renderToStaticMarkup` 探针既跑不了 `useEffect`，也观察不到 `useState` 的更新
 * （SSR 里 setState 是空操作）。要验证「真 hook 在时间里的行为」——重连预算怎么累计、loading 何时复位——
 * 得让 hook 函数体在受控的 dispatcher 下真跑。
 *
 * 做法与 tests/streamdown-options.test.ts 同源：临时替换 React 内部的 dispatcher 槽位（H），一次 render 结束就还原。
 *
 * 用法：
 *   const h = createHookHarness();
 *   const api = h.render(() => useXxx(...));   // 一次 render：hook 顺序 = 调用顺序，槽位跨 render 复用
 *   h.flushEffects();                          // 跑登记的 effect（deps 变了才重跑，先跑旧 cleanup）
 *   ...
 *   h.unmount();                               // 跑全部 cleanup
 *
 * 注意：
 *  - setState 只改槽位、不会自动重渲染——要读最新值请再 render 一次（和真 React 一样，返回值是 render 时的快照）；
 *  - 只实现了 useRef / useState / useCallback / useMemo / useEffect / useLayoutEffect / useId，用到别的 hook 会直接抛错；
 *  - 依赖 React 内部字段（__CLIENT_INTERNALS_…）：React 升级后桩不够用会抛错，提醒重新评估这批测试。
 */
import React from "react";

type Cleanup = void | (() => void);
type Deps = readonly unknown[] | undefined;

interface RefSlot {
  kind: "ref";
  ref: { current: unknown };
}
interface StateSlot {
  kind: "state";
  value: unknown;
  set: (next: unknown) => void;
}
interface EffectSlot {
  kind: "effect";
  first: boolean;
  deps: Deps;
  pending: (() => Cleanup) | null;
  cleanup: Cleanup;
}
type Slot = RefSlot | StateSlot | EffectSlot;

export interface HookHarness {
  /** 在桩 dispatcher 下执行一次 hook 函数体（= 一次 render），返回 hook 的返回值 */
  render<T>(body: () => T): T;
  /** 执行登记的 effect（deps 变了才重跑；先跑上一轮的 cleanup） */
  flushEffects(): void;
  /** 卸载：跑全部 effect 的 cleanup */
  unmount(): void;
  /** 全部 useState 槽位的当前值（按调用顺序） */
  states(): unknown[];
}

const depsChanged = (prev: Deps, next: Deps): boolean =>
  prev === undefined ||
  next === undefined ||
  prev.length !== next.length ||
  next.some((d, i) => !Object.is(d, prev[i]));

export const createHookHarness = (): HookHarness => {
  const internals = (
    React as unknown as Record<string, { H: unknown } | undefined>
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  if (!internals) {
    throw new Error(
      "拿不到 React 内部 dispatcher，请更新 tests/helpers/react-hook-stub.ts 的桩",
    );
  }

  const slots: Slot[] = [];
  let cursor = 0;

  const slotAt = <S extends Slot>(make: () => S): S => {
    const i = cursor++;
    const existing = slots[i];
    if (existing) return existing as S;
    const created = make();
    slots[i] = created;
    return created;
  };

  const effectHook = (create: () => Cleanup, deps?: Deps): void => {
    const slot = slotAt<EffectSlot>(() => ({
      kind: "effect",
      first: true,
      deps: undefined,
      pending: null,
      cleanup: undefined,
    }));
    if (slot.first || depsChanged(slot.deps, deps)) {
      slot.first = false;
      slot.deps = deps;
      slot.pending = create;
    }
  };

  const impl: Record<string, unknown> = {
    useRef: (init: unknown) =>
      slotAt<RefSlot>(() => ({ kind: "ref", ref: { current: init } })).ref,
    useState: (init: unknown) => {
      const slot = slotAt<StateSlot>(() => {
        const created: StateSlot = {
          kind: "state",
          value: typeof init === "function" ? (init as () => unknown)() : init,
          set: (next) => {
            created.value =
              typeof next === "function"
                ? (next as (prev: unknown) => unknown)(created.value)
                : next;
          },
        };
        return created;
      });
      return [slot.value, slot.set];
    },
    useCallback: (fn: unknown) => fn,
    useMemo: (fn: () => unknown) => fn(),
    useId: () => "hook-stub-id",
    useEffect: effectHook,
    useLayoutEffect: effectHook,
  };

  const dispatcher = new Proxy(impl, {
    get: (target, prop) => {
      if (typeof prop === "string" && prop.startsWith("use") && !(prop in target)) {
        throw new Error(
          `hook 桩没实现 ${prop}，请在 tests/helpers/react-hook-stub.ts 里补上`,
        );
      }
      return target[prop as string];
    },
  });

  return {
    render<T>(body: () => T): T {
      cursor = 0;
      const prev = internals.H;
      internals.H = dispatcher;
      try {
        return body();
      } finally {
        internals.H = prev;
      }
    },
    flushEffects() {
      for (const slot of slots) {
        if (slot?.kind !== "effect" || !slot.pending) continue;
        const create = slot.pending;
        slot.pending = null;
        if (typeof slot.cleanup === "function") slot.cleanup();
        slot.cleanup = create();
      }
    },
    unmount() {
      for (const slot of slots) {
        if (slot?.kind !== "effect") continue;
        const cleanup = slot.cleanup;
        slot.cleanup = undefined;
        slot.pending = null;
        if (typeof cleanup === "function") cleanup();
      }
    },
    states() {
      return slots
        .filter((s): s is StateSlot => s?.kind === "state")
        .map((s) => s.value);
    },
  };
};
