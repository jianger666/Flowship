/**
 * 子代理过程记录的客户端取数（纯 fetch，不依赖 React；hook 与测试共用）
 *
 * 对应服务端 `GET /api/tasks/[id]/subagent-runs`（见该路由的说明）。
 */

import {
  isSubagentRunTerminal,
  parseSubagentRunResponse,
  SUBAGENT_RUN_POLL_MS,
  type SubagentRunRef,
  type SubagentRunResponse,
  type SubagentRunSnapshot,
} from "@/lib/subagent-run";

/** 拼请求地址：key 优先于 callId（同服务端口径）；rev 带上则「没变化」时服务端只回 unchanged */
export const subagentRunUrl = (
  taskId: string,
  ref: SubagentRunRef,
  rev?: number,
): string => {
  const q = new URLSearchParams();
  if (ref.by === "key") q.set("key", ref.key);
  else q.set("callId", ref.callId);
  if (typeof rev === "number" && Number.isFinite(rev)) q.set("rev", String(rev));
  return `/api/tasks/${encodeURIComponent(taskId)}/subagent-runs?${q.toString()}`;
};

/**
 * 取一次。404 → `{ kind: "missing" }`；网络失败 / 非预期响应 → 抛 Error（调用方决定重试还是报错）。
 * 取消（AbortSignal）时 fetch 自己抛 AbortError，原样往外抛，调用方按「已取消」处理。
 */
export const fetchSubagentRun = async (
  taskId: string,
  ref: SubagentRunRef,
  opts: { rev?: number; signal?: AbortSignal } = {},
): Promise<SubagentRunResponse> => {
  const res = await fetch(subagentRunUrl(taskId, ref, opts.rev), {
    cache: "no-store",
    signal: opts.signal,
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // 非 JSON：交给下面按状态码判
  }
  const parsed = parseSubagentRunResponse(res.status, body);
  if (parsed) return parsed;
  throw new Error(`HTTP ${res.status}`);
};

/**
 * 查不到记录（404）时还要再等几轮（每轮 `SUBAGENT_RUN_POLL_MS`）才下「没有记录」的结论。
 *
 * 卡片 / 条还在跑时记录可能只是**还没建好**：服务端是子 agent 建好、任务书发出去之后才开始记的
 * （中间有拉模型目录 / 建会话），而卡片在模型发出工具调用的那一刻就出现了。
 * 已经跑完的卡片（含功能上线前的历史卡片）查不到就是真没有，不用等。
 */
export const MISSING_RETRY_ROUNDS_RUNNING = 30;
export const MISSING_RETRY_ROUNDS_IDLE = 0;

export const missingRetryRounds = (
  fallback: { running?: boolean } | undefined,
): number =>
  fallback?.running ? MISSING_RETRY_ROUNDS_RUNNING : MISSING_RETRY_ROUNDS_IDLE;

// ---------- 轮询状态机（hook 与测试共用；不依赖 React） ----------

export type SubagentRunPhase = "loading" | "ready" | "missing" | "error";

/** 轮询状态机对外发的状态（hook 在外面套上「属于哪一次打开」的 forKey 再存） */
export interface SubagentRunPollState {
  phase: SubagentRunPhase;
  /** 最近一次取到的快照（轮询中瞬时失败也保留旧的） */
  snapshot: SubagentRunSnapshot | null;
  /** loading 中且已经 404 过——「记录还没建好、在等」 */
  waiting: boolean;
}

export interface SubagentRunPollOptions {
  taskId: string;
  ref: SubagentRunRef;
  /** 卡片 / 条自己手上的信息：只用 `running` 决定 404 时要多等几轮 */
  fallback?: { running?: boolean };
  onState: (state: SubagentRunPollState) => void;
  /** 注入取数函数（测试用；默认 {@link fetchSubagentRun}） */
  fetchRun?: typeof fetchSubagentRun;
  /** 轮询间隔（测试用；默认 `SUBAGENT_RUN_POLL_MS`） */
  pollMs?: number;
}

/**
 * 开始一轮「取一次 → 运行中隔 pollMs 再取」的轮询；返回 stop（关闭 / 换目标时调）。
 *
 * 状态机（原先写在 `useSubagentRun` 的 effect 里，抽出来是为了能真跑起来测，而不只是读源码断言字符串）：
 *  - 取到快照 → ready；终态（done / failed / cancelled / interrupted）就停，运行中 pollMs 后再取
 *  - 304 式 unchanged（rev 没变）→ 不发状态、继续轮询（手上有快照才可能走到这里）
 *  - 404：还没拿到过快照 → 按 {@link missingRetryRounds} 多等几轮（loading + waiting），仍没有 → missing 并停；
 *    拿到过又 404（被保留策略清掉）→ 保留手上最后一份、停（不抹掉用户正在看的内容）
 *  - 请求失败：还没拿到过快照 → error 并停（给「重试」）；已有快照 → 当瞬时抖动、不发状态继续轮询
 *  - stop：掐掉在飞请求 + 清定时器；之后晚到的响应不会再发任何状态
 */
export const startSubagentRunPolling = (opts: SubagentRunPollOptions): (() => void) => {
  const { taskId, ref, onState } = opts;
  const fetchRun = opts.fetchRun ?? fetchSubagentRun;
  const pollMs = opts.pollMs ?? SUBAGENT_RUN_POLL_MS;
  const maxMissing = missingRetryRounds(opts.fallback);

  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rev: number | undefined;
  let snapshot: SubagentRunSnapshot | null = null;
  let missingCount = 0;

  const publish = (phase: SubagentRunPhase, waiting = false) => {
    if (ac.signal.aborted) return;
    onState({ phase, snapshot, waiting });
  };

  const schedule = () => {
    timer = setTimeout(() => void tick(), pollMs);
  };

  const tick = async (): Promise<void> => {
    try {
      const r = await fetchRun(taskId, ref, { rev, signal: ac.signal });
      if (ac.signal.aborted) return;
      if (r.kind === "snapshot") {
        snapshot = r.snapshot;
        rev = r.snapshot.rev;
        publish("ready");
        if (isSubagentRunTerminal(r.snapshot.meta.status)) return;
      } else if (r.kind === "unchanged") {
        // rev 没变 = 内容没变；能走到这里说明手上的快照还是运行中（终态已经停了轮询）
        if (!snapshot) return;
      } else if (snapshot) {
        // 拿到过又 404：记录被保留策略清掉了。保留手上最后一份，别抹掉用户正在看的内容
        return;
      } else if (missingCount < maxMissing) {
        missingCount += 1;
        publish("loading", true);
      } else {
        publish("missing");
        return;
      }
    } catch (err) {
      if (ac.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
        return;
      }
      if (!snapshot) {
        publish("error");
        return;
      }
      // 已有快照：瞬时失败，界面不动、下一轮再试
    }
    schedule();
  };

  void tick();
  return () => {
    ac.abort();
    clearTimeout(timer);
  };
};
