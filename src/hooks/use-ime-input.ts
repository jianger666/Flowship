"use client";

/**
 * 受控文本框的「输入法组合态」处理：组合期间（拼音 / 假名还没上屏）不向外上报，上屏后补报一次。
 *
 * 为什么：受控 `<input onChange>` 在中日韩输入法里每敲一个字母就触发一次——拼音「ni」的 n、i 各一次。
 * 搜索框如果直接把它们当查询词，每个字母都会跑一遍全量文本搜索、并把视口跳到第一个命中；
 * 想搜「你」要白白搜 n、ni 两遍、跳两次。
 *
 * 做法（与 composer-lexical 的 runWhenNotComposing 同思路：组合期间不下发，结束后补一次）：
 * - 组合中：输入框显示草稿（draft），对外一次都不报——显示值必须是草稿，
 *   否则受控回写会把输入法正在编辑的拼音冲掉、打断输入；
 * - compositionend：清草稿，把最终值报一次；
 * - 去重：与「上次对外报的值」相同就不重复报——Safari 里 compositionend 先于最后一个 input，
 *   同一个值会走两条路，只报一次；
 * - 判定「是否在组合」认两个信号：compositionstart / end 维护的 ref，和 input 事件自带的 isComposing
 *   （事件序因内核而异，只认一个会漏）。
 *
 * 放在 hook 里的那一层状态（组合标记、草稿）随输入框一起卸载：用它的组件要把输入框放在
 * 「只在需要时才渲染」的子组件里，输入框卸载后组合标记不会残留成 true。
 *
 * 不放进 lib/ime.ts：那里只放按键判定（isImeComposing，Enter / Escape 用），
 * 且 tests/ime-enter-contract 要求各处统一从它导入这一个函数。
 */

import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CompositionEvent,
} from "react";

interface UseImeInputOptions {
  /** 外部（父组件）持有的值 */
  value: string;
  /** 非组合态下每次变化、以及组合结束时的最终值——只在值真的变了才调 */
  onCommit: (value: string) => void;
}

export interface ImeInputBindings {
  /** 给 `<input value>`：组合中是草稿，否则是外部值 */
  value: string;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  onCompositionStart: () => void;
  onCompositionEnd: (e: CompositionEvent<HTMLInputElement>) => void;
}

export const useImeInput = ({
  value,
  onCommit,
}: UseImeInputOptions): ImeInputBindings => {
  // 组合标记用 ref：决策要同步读（同一个事件序里 compositionstart 之后紧跟 input），不能等重渲染
  const composingRef = useRef(false);
  // 组合中输入框显示的草稿；null = 不在组合、显示外部值
  const [draft, setDraft] = useState<string | null>(null);
  // 上次对外报过（或外部同步过来）的值，用来去重
  const lastCommittedRef = useRef(value);

  // 外部值变了（别处清空 / 改写）就跟着对齐，否则去重会把「回到旧值」的合法输入吞掉
  useEffect(() => {
    lastCommittedRef.current = value;
  }, [value]);

  const commit = (next: string) => {
    if (next === lastCommittedRef.current) return;
    lastCommittedRef.current = next;
    onCommit(next);
  };

  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value;
    // nativeEvent 在类型上是 Event，input 事件才有 isComposing
    if (composingRef.current || (e.nativeEvent as InputEvent).isComposing === true) {
      setDraft(next);
      return;
    }
    setDraft(null);
    commit(next);
  };

  const onCompositionStart = () => {
    composingRef.current = true;
  };

  const onCompositionEnd = (e: CompositionEvent<HTMLInputElement>) => {
    composingRef.current = false;
    setDraft(null);
    // 无条件报最终值（commit 内部去重）：Chromium 里它是组合期间唯一的一次上报；
    // Safari 里最后一个 input 随后还会来一次，同值会被去掉
    commit(e.currentTarget.value);
  };

  return {
    value: draft ?? value,
    onChange,
    onCompositionStart,
    onCompositionEnd,
  };
};
