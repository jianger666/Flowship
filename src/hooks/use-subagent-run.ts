"use client";

/**
 * 子代理详情面板的取数 hook：打开时取一次，运行中每秒轮询到终态为止。
 *
 * 为什么轮询而不是新开一条 SSE：主流 SSE 里没有子代理的内部过程（也不该有——量大、只有点开的人要看），
 * 面板只在打开 + 子代理还在跑时才取数，1s 一次、带 `rev` 没变化服务端只回几十字节。
 *
 * 状态机（每次打开 / 点「重试」从头来）在 `startSubagentRunPolling`（`@/lib/subagent-run-client`，
 * 不依赖 React、有行为测试）；这里只把它的状态存进 state，关闭 / 换目标时 stop（掐掉在飞请求 + 清定时器，
 * 晚到的响应不会写进新目标的状态）：
 *  - 取到快照 → ready；终态（done / failed / cancelled / interrupted）就停，运行中 1s 后再取
 *  - 404 → 记录可能还没建好：多等几轮，仍没有 → missing（面板退回展示卡片自带的信息）
 *  - 请求失败：还没拿到过快照 → error（停下，给「重试」）；已有快照 → 当瞬时抖动、界面不动继续轮询
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  subagentDetailTargetId,
  type SubagentDetailTarget,
  type SubagentRunSnapshot,
} from "@/lib/subagent-run";
import {
  startSubagentRunPolling,
  type SubagentRunPhase,
} from "@/lib/subagent-run-client";

export type { SubagentRunPhase };

export interface SubagentRunView {
  phase: SubagentRunPhase;
  /** 最近一次取到的快照（ready 时有；轮询中瞬时失败也保留旧的） */
  snapshot: SubagentRunSnapshot | null;
  /** loading 中且已经 404 过——「记录还没建好、在等」，界面可以说得更具体 */
  waiting: boolean;
  /** error 态下的手动重试 */
  reload: () => void;
}

interface InternalState {
  /** 这份状态属于哪一次打开（`目标 id#重试序号`）：不匹配就当还没开始，免得在 effect 里同步 reset */
  forKey: string;
  phase: SubagentRunPhase;
  snapshot: SubagentRunSnapshot | null;
  waiting: boolean;
}

export const useSubagentRun = (
  taskId: string,
  target: SubagentDetailTarget | null,
): SubagentRunView => {
  const [reloadSeq, setReloadSeq] = useState(0);
  const [state, setState] = useState<InternalState | null>(null);
  const targetId = target ? subagentDetailTargetId(target) : null;
  const openKey = targetId ? `${targetId}#${reloadSeq}` : null;

  // effect 里读最新的 target（不让 target 对象身份变化重启轮询）
  const targetRef = useRef(target);
  useEffect(() => {
    targetRef.current = target;
  });

  useEffect(() => {
    const current = targetRef.current;
    if (!openKey || !current) return;
    // 状态机本体在 subagent-run-client（可脱离 React 单测）；这里只负责把它的状态存进 state、卸载时 stop
    return startSubagentRunPolling({
      taskId,
      ref: current.ref,
      fallback: current.fallback,
      onState: (s) => setState({ forKey: openKey, ...s }),
    });
  }, [taskId, openKey]);

  const reload = useCallback(() => setReloadSeq((n) => n + 1), []);

  if (!openKey || !state || state.forKey !== openKey) {
    return { phase: "loading", snapshot: null, waiting: false, reload };
  }
  return {
    phase: state.phase,
    snapshot: state.snapshot,
    waiting: state.waiting,
    reload,
  };
};
