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
 *  - useCallback 默认**不**记忆（每次 render 都返回新函数，老用例都是在这个语义下写的）；要验证「依赖了某个 useCallback 结果的 effect 何时重跑」
 *    必须传 `createHookHarness({ memoCallbacks: true })`——此时 useCallback 像真 React 一样按 deps 记忆（deps 不变返回同一个函数），
 *    否则 effect 的依赖里只要有它，每次 render 都会被当成「变了」而重跑，测不出真实的触发时机；
 *  - 只实现了 useRef / useState / useCallback / useMemo / useEffect / useLayoutEffect / useId / useSyncExternalStore（只读 getSnapshot），用到别的 hook 会直接抛错；
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
interface CallbackSlot {
  kind: "callback";
  fn: unknown;
  deps: Deps;
}
type Slot = RefSlot | StateSlot | EffectSlot | CallbackSlot;

export interface HookHarnessOptions {
  /** true = useCallback 按 deps 记忆（见文件头注意事项）；缺省 false = 每次 render 都是新函数（老用例的语义） */
  memoCallbacks?: boolean;
}

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

export const createHookHarness = (options: HookHarnessOptions = {}): HookHarness => {
  const memoCallbacks = options.memoCallbacks === true;
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
    useCallback: (fn: unknown, deps?: Deps) => {
      if (!memoCallbacks) return fn;
      const slot = slotAt<CallbackSlot>(() => ({ kind: "callback", fn, deps }));
      // 无 deps（undefined）= 每次重新生成，与真 React 一致；depsChanged 对 undefined 恒为 true
      if (depsChanged(slot.deps, deps)) {
        slot.fn = fn;
        slot.deps = deps;
      }
      return slot.fn;
    },
    useMemo: (fn: () => unknown) => fn(),
    // 客户端语义：每次 render 读一次 getSnapshot（不订阅——桩里没有「外部变化触发重渲」）。
    // 要看服务端 / 水合首帧（getServerSnapshot）请用 renderToStaticMarkup，它走的就是服务端快照
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
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
