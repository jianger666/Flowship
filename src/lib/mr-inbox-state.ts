/**
 * 收件箱前端 store 的纯状态变换（useMrInbox 的乐观更新 / 扫描失败兜底都走这里，便于单测）。
 *
 * 为什么抽出来：
 * - S13-04：慢扫描期间用户做的乐观操作（忽略 / 合并 / 流转 / 标已读）会被「扫描响应整表覆盖」冲掉，
 *   已忽略、已合并的条目"复活"。做法：扫描期间所有本地变换都记成「补丁」，响应回来后按序重放到新结果上。
 * - S13-05：一次瞬时失败不能清空整表 / 角标归零 / 重置通知基线——失败时保留上一次成功的数据，
 *   只额外记一个 scanError 让面板展示错误条。
 * - S13-19：忽略后给「撤销」——把被移除的条目快照下来，撤销时幂等塞回。
 * - N9-01：撤销忽略后的 force 刷新若撞上在飞的刷新，不能被丢弃——登记一次尾随 force、在飞的结束后立刻再跑。
 * - N1-01（粒度）：部分失败的「保留旧表 / 合并展示 / 建不建基线 / 发不发通知」决策全在本文件的纯函数里
 *   （decideInboxScanResult / planInboxNotify），hook 只调它们，可脱离 React 做行为测试。
 */

import {
  buildInboxNotifyCopy,
  diffInboxUnreadForNotify,
  listUnreadInboxItems,
  MR_INBOX_FAILURE_KIND_LABEL,
  MR_INBOX_HIDDEN_POLL_INTERVAL_MS,
  MR_INBOX_POLL_INTERVAL_MS,
  type MrInboxFailureKind,
  type MrInboxIncompleteScope,
} from "@/lib/mr-inbox";

/** 三组共有的最小形状（hook 里的 MrInboxData 结构兼容它） */
export interface InboxGroupsShape {
  status: string;
  pendingMr: { mrUrl: string }[];
  myBugs: { bugUrl: string }[];
  pendingRegression: { bugUrl: string }[];
  message?: string;
}

/** 对一份数据的纯变换（扫描期间记录、响应回来后重放） */
export type InboxPatch<D extends InboxGroupsShape> = (data: D) => D;

/** 把扫描期间记下的补丁按发生顺序重放到新扫描结果上 */
export const applyInboxPatches = <D extends InboxGroupsShape>(
  data: D,
  patches: readonly InboxPatch<D>[],
): D => patches.reduce((acc, patch) => patch(acc), data);

/** 三组里都剔掉某个 url（MR 用 mrUrl、bug 用 bugUrl） */
export const removeInboxUrl = <D extends InboxGroupsShape>(
  data: D,
  url: string,
): D => ({
  ...data,
  pendingMr: data.pendingMr.filter((it) => it.mrUrl !== url),
  myBugs: data.myBugs.filter((it) => it.bugUrl !== url),
  pendingRegression: data.pendingRegression.filter((it) => it.bugUrl !== url),
});

/** 「忽略」前被移除条目的快照（撤销用）：命中哪组就带哪组 */
export interface InboxIgnoredSnapshot<
  M extends { mrUrl: string },
  B extends { bugUrl: string },
> {
  url: string;
  pendingMr?: M;
  myBugs?: B;
  pendingRegression?: B;
}

/** 从当前数据里抠出某 url 对应条目的快照 */
export const snapshotInboxUrl = <
  M extends { mrUrl: string },
  B extends { bugUrl: string },
>(
  data: {
    pendingMr: M[];
    myBugs: B[];
    pendingRegression: B[];
  },
  url: string,
): InboxIgnoredSnapshot<M, B> => ({
  url,
  pendingMr: data.pendingMr.find((it) => it.mrUrl === url),
  myBugs: data.myBugs.find((it) => it.bugUrl === url),
  pendingRegression: data.pendingRegression.find((it) => it.bugUrl === url),
});

/** 撤销忽略：把快照里的条目幂等塞回（已存在就不重复加；顺序以后续重扫为准） */
export const restoreInboxSnapshot = <
  M extends { mrUrl: string },
  B extends { bugUrl: string },
  D extends {
    pendingMr: M[];
    myBugs: B[];
    pendingRegression: B[];
  },
>(
  data: D,
  snapshot: InboxIgnoredSnapshot<M, B>,
): D => ({
  ...data,
  pendingMr:
    snapshot.pendingMr &&
    !data.pendingMr.some((it) => it.mrUrl === snapshot.pendingMr!.mrUrl)
      ? [...data.pendingMr, snapshot.pendingMr]
      : data.pendingMr,
  myBugs:
    snapshot.myBugs &&
    !data.myBugs.some((it) => it.bugUrl === snapshot.myBugs!.bugUrl)
      ? [...data.myBugs, snapshot.myBugs]
      : data.myBugs,
  pendingRegression:
    snapshot.pendingRegression &&
    !data.pendingRegression.some(
      (it) => it.bugUrl === snapshot.pendingRegression!.bugUrl,
    )
      ? [...data.pendingRegression, snapshot.pendingRegression]
      : data.pendingRegression,
});

// ----------------- 刷新调度（N9-01：force 刷新遇到在飞刷新不能丢） -----------------

/**
 * 刷新闸门：
 * - running：有一次刷新在飞（同时也是「乐观补丁要不要入队」的开关）；
 * - trailingForce：在飞期间登记过「它结束后立刻再 force 刷一次」，多次登记合并成一次。
 */
export interface InboxRefreshGate {
  running: boolean;
  trailingForce: boolean;
}

export const createInboxRefreshGate = (): InboxRefreshGate => ({
  running: false,
  trailingForce: false,
});

/** 一次刷新请求的处置：start 立即开跑 / queued 登记尾随 force / skipped 并入在飞的那次 */
export type InboxRefreshAction = "start" | "queued" | "skipped";

/**
 * 收到一次刷新请求时怎么处置（纯函数）。
 *
 * 为什么 force 不能像普通刷新那样「有在飞的就丢」：撤销忽略 / 合并等操作后调用方要的是
 * 「在这次操作之后再扫一遍」。在飞的那次扫描是操作之前发起的，拿到的是旧结果，
 * 返回后会盖掉条目状态（顺序 / 详情停在乐观快照上，要等 10 分钟轮询才校正）。
 * 所以 force 遇到在飞刷新时登记一次尾随刷新；普通（轮询 / 回前台）刷新并入在飞那次即可。
 */
export const requestInboxRefresh = (
  gate: InboxRefreshGate,
  force: boolean,
): { action: InboxRefreshAction; gate: InboxRefreshGate } => {
  if (!gate.running) {
    return { action: "start", gate: { running: true, trailingForce: false } };
  }
  if (force) {
    return { action: "queued", gate: { running: true, trailingForce: true } };
  }
  return { action: "skipped", gate };
};

/**
 * 一次刷新结束时的处置（纯函数）：有登记过的尾随 force 就保持 running、立刻再跑一次，
 * 否则释放闸门。交接期间 running 一直为 true，避免被别的普通刷新插队、也不让补丁入队开关抖动。
 */
export const finishInboxRefresh = (
  gate: InboxRefreshGate,
): { runTrailing: boolean; gate: InboxRefreshGate } => {
  if (gate.trailingForce) {
    return {
      runTrailing: true,
      gate: { running: true, trailingForce: false },
    };
  }
  return { runTrailing: false, gate: createInboxRefreshGate() };
};

/**
 * 带「尾随 force 合并」的刷新驱动（hook 的 refresh 直接用它，调度逻辑可脱离 React 单测）：
 * - 闸门空闲 → 调 scanOnce(force) 并在结束后检查是否有登记的尾随 force，有就连跑；
 * - 已有在飞：force 登记尾随、普通请求并入；这两种调用都立刻 resolve（不等在飞的那次，与旧行为一致）。
 *
 * scanOnce 自己吞错误（失败走 failScan）；若意外抛出，finally 会释放闸门，
 * 否则之后所有刷新都会被误判成「在飞」而永久卡死。
 */
export const runCoalescedInboxRefresh = async (args: {
  gateRef: { current: InboxRefreshGate };
  force: boolean;
  scanOnce: (force: boolean) => Promise<void>;
  /** 一轮连跑开始 / 全部结束（驱动 refreshing 状态：连跑期间保持 true、不闪烁） */
  onStart?: () => void;
  onSettled?: () => void;
}): Promise<void> => {
  const { gateRef, scanOnce } = args;
  const req = requestInboxRefresh(gateRef.current, args.force);
  gateRef.current = req.gate;
  if (req.action !== "start") return;

  args.onStart?.();
  let force = args.force;
  try {
    for (;;) {
      await scanOnce(force);
      const fin = finishInboxRefresh(gateRef.current);
      gateRef.current = fin.gate;
      if (!fin.runTrailing) return;
      // 尾随刷新必然是 force：登记它的就是要「操作之后重扫」的调用方
      force = true;
    }
  } finally {
    // 兜底释放（正常结束时 finishInboxRefresh 已释放，这里幂等）
    gateRef.current = createInboxRefreshGate();
    args.onSettled?.();
  }
};

/**
 * 扫描失败（网络 / 非 2xx / 服务端回 status:"error"）时决定留什么数据：
 * - 上一次是 ok → 原样保留（列表 / 角标 / 通知基线都不动），错误另走 scanError 展示；
 * - 否则（首拉就失败 / 之前是未登录等降级态）→ 空列表 + error 态。
 */
export interface InboxPartialScanOutcome<D> {
  data: D;
  /** 面板错误条文案（非空 = 本轮不完整） */
  scanError: string;
}

/**
 * 服务端回 `status:"ok"` 但 `partial:true`（N1-01：扫描中途有单步失败 / 超时，列表不完整）：
 * - 之前已有成功数据 → 原样保留旧表（角标 / 通知基线都不动），只挂错误条；
 *   否则「少了几条」会被当成「处理完了」、下一轮恢复后又把存量全判成「新增」重复通知；
 * - 没有旧表（首拉）→ 先展示已扫到的部分，但带 `partial` 标记：通知 effect 看到它不建基线、不发通知。
 */
export const resolvePartialScan = <
  D extends InboxGroupsShape & { partial?: boolean },
>(
  prev: D | null,
  fresh: D,
  message: string,
): InboxPartialScanOutcome<D> => {
  const scanError = message || "本轮扫描未完整";
  if (prev && prev.status === "ok" && !prev.partial) {
    return { data: prev, scanError };
  }
  return { data: { ...fresh, partial: true }, scanError };
};

/** 扫描 fetch 抛错 → 面板文案（N1-15：超时 / 被中止统一叫「扫描超时」） */
export const describeScanFetchError = (err: unknown): string => {
  const name =
    err && typeof err === "object" && "name" in err
      ? String((err as { name?: unknown }).name)
      : "";
  if (name === "TimeoutError" || name === "AbortError") return "扫描超时";
  return err instanceof Error ? err.message : String(err);
};

export const nextDataOnScanFailure = <D extends InboxGroupsShape>(
  prev: D | null,
  message: string,
  makeErrorData: (message: string) => D,
): D => {
  if (prev && prev.status === "ok") return prev;
  return makeErrorData(message);
};

// ----------------- N1-01 粒度：连续多轮同类部分失败 → 合并展示 / 通知基线 -----------------

/**
 * 连续几轮出现「同一类」部分失败后，从「保留旧表（冻结）」切到「已扫到的部分与旧表合并展示」。
 * 2 = 第二轮仍是同类失败就合并（轮询 5 分钟 → 最多冻结约 5~10 分钟）。
 * 永久性失败（某工作项数据异常）否则会让每一轮都 partial、列表永远停在上次完整结果。
 */
export const INBOX_PARTIAL_MERGE_AFTER_ROUNDS = 2;

/** 合并所需的条目最小形状（hook 的 MrInboxData 结构兼容它） */
export interface InboxMergeShape {
  status: string;
  pendingMr: { mrUrl: string; workItemId: string; projectKey: string }[];
  myBugs: { bugUrl: string; projectKey: string }[];
  pendingRegression: { bugUrl: string; projectKey: string }[];
  message?: string;
  scannedAt?: number;
  partial?: boolean;
  /**
   * 这份表是「连续多轮同类部分失败后合并展示 / 只含已扫到部分」的结果（客户端打的标，服务端响应里没有它）：
   * 表本身可以展示，但**不能当通知基线**——它缺失败范围里的存量，之后一次完整扫描会把这些存量全判成「新增」
   * （第六轮 P3-1 / 场景 B）。见 {@link planInboxNotify} 的 baselineIncomplete。
   */
  incompleteScan?: boolean;
}

const withoutPartialFlag = <D extends { partial?: boolean }>(data: D): D => {
  const copy = { ...data };
  delete copy.partial;
  return copy;
};

/**
 * 把「本轮扫到的部分」与旧表合并（纯函数）：
 * - 本轮扫到的条目用新数据（按 mrUrl / bugUrl 去重，新数据优先、保持服务端顺序）；
 * - 本轮**没扫到**范围里的旧条目沿用旧表（别丢）：待测 MR 看 workItemId / 排期失败的空间，
 *   两组 bug 看各自查询失败的空间；超总时限（all）或缺范围信息时，所有没被新数据覆盖的旧条目都沿用；
 * - 范围之外、本轮扫到却没出现的旧条目是真的没了（MR 已合 / bug 已流转），不沿用。
 */
export const mergePartialScan = <D extends InboxMergeShape>(
  prev: D,
  fresh: D,
  incomplete: MrInboxIncompleteScope | undefined,
): D => {
  const all = !incomplete || incomplete.all === true;
  const workItemIds = new Set(incomplete?.workItemIds ?? []);
  const scheduleProjects = new Set(incomplete?.scheduleProjectKeys ?? []);
  const myBugsProjects = new Set(incomplete?.myBugsProjectKeys ?? []);
  const regressionProjects = new Set(
    incomplete?.pendingRegressionProjectKeys ?? [],
  );

  const freshMr = new Set(fresh.pendingMr.map((it) => it.mrUrl));
  const freshMyBugs = new Set(fresh.myBugs.map((it) => it.bugUrl));
  const freshRegression = new Set(fresh.pendingRegression.map((it) => it.bugUrl));

  const keptMr = prev.pendingMr.filter(
    (it) =>
      !freshMr.has(it.mrUrl) &&
      (all ||
        workItemIds.has(it.workItemId) ||
        scheduleProjects.has(it.projectKey)),
  );
  const keptMyBugs = prev.myBugs.filter(
    (it) =>
      !freshMyBugs.has(it.bugUrl) && (all || myBugsProjects.has(it.projectKey)),
  );
  const keptRegression = prev.pendingRegression.filter(
    (it) =>
      !freshRegression.has(it.bugUrl) &&
      (all || regressionProjects.has(it.projectKey)),
  );

  return withoutPartialFlag({
    ...fresh,
    pendingMr: [...fresh.pendingMr, ...keptMr],
    myBugs: [...fresh.myBugs, ...keptMyBugs],
    pendingRegression: [...fresh.pendingRegression, ...keptRegression],
  });
};

/** 跨轮次的扫描跟踪（hook 用 ref 持有） */
export interface InboxScanTracker {
  /** 连续出现「同类」部分失败的轮数（完整扫描清零） */
  partialStreak: number;
  /** 这一段连续失败里每一轮都出现过的失败类别（交集；交集为空 = 换了一类，重新计数） */
  commonKinds: string[];
  /** 最近一次**完整**扫描的时间（ms）；从未完整扫成功过 = null */
  lastFullScanAt: number | null;
}

export const createInboxScanTracker = (): InboxScanTracker => ({
  partialStreak: 0,
  commonKinds: [],
  lastFullScanAt: null,
});

/**
 * 面板错误条的场景：
 * - failed：整轮失败（网络 / 非 2xx / status:error），保留上次列表；
 * - kept-old：部分失败、有上次完整结果 → 保留旧表（尚未连续同类失败）；
 * - kept-partial：部分失败、保留的「旧表」本身就是之前不完整的结果（至今没有完整扫描成功过）——
 *   不能说「上次完整结果」，也不能说「只含本轮已扫到的」（第六轮 P4）；
 * - kept-merged：同上，但**有过完整扫描**：保留的是之前「合并展示」的表（有完整史 → 同类失败合并 → 换了一类失败，
 *   又被保留），它也不是「上次完整结果」——失败范围内的条目是沿用的旧数据（第七轮 R7-2）；
 * - merged：连续同类部分失败 → 已扫到的部分与旧表合并展示；
 * - partial-only：没有可用的上次完整结果，只展示本轮已扫到的部分。
 */
export type InboxScanNoticeKind =
  | "failed"
  | "kept-old"
  | "kept-partial"
  | "kept-merged"
  | "merged"
  | "partial-only";

export interface InboxScanNotice {
  kind: InboxScanNoticeKind;
  /** 原始失败文案（服务端 partialMessage / 网络错误） */
  message: string;
  /** 列表停在哪次完整扫描（ms）；没有 = null */
  staleSinceMs: number | null;
  /** 连续同类失败轮数 */
  rounds: number;
  /** 连续同类的失败类别 */
  kinds: string[];
}

export interface InboxScanDecision<D> {
  data: D;
  /** null = 本轮完整成功，无错误条 */
  notice: InboxScanNotice | null;
  tracker: InboxScanTracker;
}

/**
 * 一轮扫描响应落 data 前的决策（纯函数；hook 的 scanOnce 成功分支只调它）：
 * - 完整扫描：直接用新结果，跟踪清零、记下完整扫描时间；
 * - 部分失败且尚未连续同类 → resolvePartialScan 的老口径（有旧表保留旧表；无旧表展示残表且带 partial 不建基线）；
 * - 部分失败且连续 ≥ INBOX_PARTIAL_MERGE_AFTER_ROUNDS 轮同类 → 合并展示（无旧表则只展示已扫到的部分），
 *   结果**不带 partial**：通知 effect 会对本轮结果建 / 对基线（无基线时只对「已扫到的条目」静默建基线，避免永远不发通知）。
 */
export const decideInboxScanResult = <D extends InboxMergeShape>(args: {
  prev: D | null;
  /** 本轮新结果（乐观补丁已重放） */
  fresh: D;
  partial: boolean;
  partialMessage?: string;
  incomplete?: MrInboxIncompleteScope;
  tracker: InboxScanTracker;
  /** 测试注入当前时间；缺省取 Date.now() */
  now?: number;
}): InboxScanDecision<D> => {
  const { prev, fresh, tracker } = args;

  if (!args.partial) {
    return {
      // fresh 来自服务端响应、本来不带 incompleteScan；这里显式剔掉，保证完整扫描的结果永远是「可当基线」的
      data: (() => {
        const copy = withoutPartialFlag(fresh);
        delete copy.incompleteScan;
        return copy;
      })(),
      notice: null,
      tracker: {
        partialStreak: 0,
        commonKinds: [],
        lastFullScanAt: fresh.scannedAt ?? args.now ?? Date.now(),
      },
    };
  }

  const message = args.partialMessage || "本轮扫描未完整";
  // 老服务端没带范围信息时按同一类处理，连续失败照样能触发合并
  const kinds: string[] =
    args.incomplete && args.incomplete.kinds.length > 0
      ? [...args.incomplete.kinds]
      : ["unknown"];
  let streak = 1;
  let commonKinds = kinds;
  if (tracker.partialStreak > 0) {
    const common = tracker.commonKinds.filter((k) => kinds.includes(k));
    if (common.length > 0) {
      streak = tracker.partialStreak + 1;
      commonKinds = common;
    }
  }
  const nextTracker: InboxScanTracker = {
    partialStreak: streak,
    commonKinds,
    lastFullScanAt: tracker.lastFullScanAt,
  };
  const staleSinceMs = tracker.lastFullScanAt;
  const hasFullEver = staleSinceMs !== null;

  if (streak >= INBOX_PARTIAL_MERGE_AFTER_ROUNDS) {
    const base = prev && prev.status === "ok" ? prev : null;
    const merged = base
      ? mergePartialScan(base, fresh, args.incomplete)
      : withoutPartialFlag(fresh);
    return {
      // 打「不完整」标：这份表能看、不能当通知基线（见 InboxMergeShape.incompleteScan）
      data: { ...merged, incompleteScan: true },
      notice: {
        kind: hasFullEver ? "merged" : "partial-only",
        message,
        staleSinceMs,
        rounds: streak,
        kinds: commonKinds,
      },
      tracker: nextTracker,
    };
  }

  const out = resolvePartialScan(prev, fresh, message);
  const keptOld = prev !== null && out.data === prev;
  // 保留下来的旧表是不是「合并表」（带 incompleteScan 标记）——旧表是否完整看**这张表本身**，不能用「有没有完整扫描史」代替：
  // 有完整史 → 同类失败合并 → 换了一类失败时，被冻结的恰恰是合并表（第七轮 R7-2）。
  // 只看 incompleteScan：resolvePartialScan 只在 `prev.status==="ok" && !prev.partial` 时才保留 prev，冻结的表不可能带 partial（第八轮 P5-1）
  const keptTableIncomplete = keptOld && prev.incompleteScan === true;
  return {
    data: out.data,
    notice: {
      kind: !keptOld
        ? "partial-only"
        : !keptTableIncomplete
          ? "kept-old" // 完整旧表 →「上次完整结果」
          : hasFullEver
            ? "kept-merged" // 合并表（有完整史）
            : "kept-partial", // 无完整史的合并表（首拉就不完整、连续同类失败合并后又换了一类失败）
      message: out.scanError,
      staleSinceMs,
      rounds: streak,
      kinds: commonKinds,
    },
    tracker: nextTracker,
  };
};

/** HH:mm（本地时区） */
const formatClock = (ms: number): string => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const describeFailureKinds = (kinds: readonly string[]): string =>
  kinds
    .map((k) => MR_INBOX_FAILURE_KIND_LABEL[k as MrInboxFailureKind] ?? k)
    .join("、");

/** 面板错误条整句文案（按场景给准确措辞；末尾的「重试」按钮由面板追加） */
export const formatInboxScanNotice = (notice: InboxScanNotice): string => {
  const since =
    notice.staleSinceMs !== null ? ` ${formatClock(notice.staleSinceMs)} ` : "";
  switch (notice.kind) {
    case "failed":
      return `最近一次扫描失败（下方为上次结果）：${notice.message}`;
    case "kept-old":
      return `${notice.message}——本轮未更新，下方仍是${since}的上次完整结果`;
    case "kept-partial":
      return `${notice.message}——本轮未更新，下方仍是上一轮的部分结果（至今没有完整扫描成功过，失败范围内的条目暂时看不到）`;
    case "kept-merged":
      // 沿用的条目可能来自比「最近一次完整扫描」更新的中间合并批次（第八轮 P4-1），所以只说「更早的数据、最早可追溯到」，不说「就是那次的」
      return `${notice.message}——本轮未更新，下方仍是上一轮的合并结果（失败范围内的条目沿用更早的数据，最早可追溯到${since}的完整扫描，可能不是最新）`;
    case "merged":
      return (
        `${notice.message}——已连续 ${notice.rounds} 轮出现同类失败（${describeFailureKinds(notice.kinds)}），` +
        `列表停在${since}；以下为合并结果：本轮扫到的用新数据，没扫到的沿用旧结果`
      );
    case "partial-only": {
      const streak =
        notice.rounds > 1
          ? `已连续 ${notice.rounds} 轮出现同类失败（${describeFailureKinds(notice.kinds)}），`
          : "";
      return `${notice.message}——${streak}没有上次完整结果可用，以下只含本轮已扫到的条目，失败范围内的条目暂时看不到`;
    }
  }
};

/** 通知决策的最小数据形状 */
export type InboxNotifyShape = Parameters<typeof listUnreadInboxItems>[0] & {
  status: string;
  partial?: boolean;
  incompleteScan?: boolean;
};

/**
 * 每份 data 落地后「建不建基线 / 发不发通知」的决策（纯函数；hook 的通知 effect 只调它）：
 * - 降级态（非 ok）→ 清基线（下次 ok 当首轮，存量不推）；
 * - 带 partial 的残表（首拉不完整且尚未连续同类失败）→ 清基线、不通知（少几条会让下一轮完整结果把存量全判成「新增」）；
 * - 其余：对**这份数据里的条目**做差——合并展示时「没扫到」的旧条目仍在表里（沿用旧表），
 *   既不会因缺席被当成「消失」，也不会被当成「新增」；本轮新扫到的才算新增；
 * - **基线是否可信（第六轮 P3-1 / 场景 B）**：基线若是在「不完整的表」（`incompleteScan`：连续多轮同类失败后合并 / 只含已扫到部分）
 *   上建的，它缺失败范围里的存量——之后第一次完整扫描会把这些存量全判成「新增」一次性误推。所以：
 *   · 无基线时在不完整表上建的基线记 `baselineIncomplete: true`；
 *   · 基线不可信、而这一轮数据**已经完整**（失败恢复）→ 静默重建基线、不发通知，基线恢复可信；
 *     ⚠ 代价（第七轮 R7-1，已接受）：失败期间才冒出来的**真新增**也在这一轮被一并静默——它们仍在面板未读里、角标照算，
 *     只是少一次系统横幅（按随机失败序列的模型估算，约 6–7% 的「首拉连续失败后恢复」序列会漏 ≥1 条；模型参数是假设、不是实测）。要精确区分得让不可信基线
 *     记下「缺口范围」、只对缺口内的条目静默，没做；
 *   · 基线不可信、这一轮仍不完整 → 照常做差（永久性失败期间仍能通知真正的新增，不退回「永远不发」），基线继续不可信；
 *     ⚠ 残余风险：失败范围在轮次之间漂移时（这轮 w1 失败、下轮 w2 失败），w1 的存量会在下一轮当「新增」推一次——
 *     比「恢复时整批存量全推」小得多，但不是零；
 *   · 基线可信（建在完整表上）时，即使这轮是合并展示也照常做差——本轮新扫到的条目相对一个完整基线确实是新增，
 *     没扫到的旧条目仍在表里、不会误判，基线保持可信。
 * - 窗口在前台只更新基线、不发横幅（角标已够）。
 *
 * @param baselineIncomplete 上一轮留下的基线是否建在不完整表上（缺省 false；hook 用 ref 持有并回写返回值）
 */
export const planInboxNotify = (args: {
  data: InboxNotifyShape | null;
  prevKeys: ReadonlySet<string> | null;
  windowFocused: boolean;
  baselineIncomplete?: boolean;
}): {
  nextKeys: Set<string> | null;
  copy: { title: string; body: string } | null;
  /** 回写给下一轮的「基线不可信」标记 */
  baselineIncomplete: boolean;
} => {
  const { data, prevKeys } = args;
  const priorUntrusted = args.baselineIncomplete === true;
  if (!data) {
    return {
      nextKeys: prevKeys ? new Set(prevKeys) : null,
      copy: null,
      baselineIncomplete: priorUntrusted,
    };
  }
  if (data.status !== "ok") return { nextKeys: null, copy: null, baselineIncomplete: false };
  if (data.partial) return { nextKeys: null, copy: null, baselineIncomplete: false };

  const items = listUnreadInboxItems(data);
  const nextKeys = new Set(items.map((it) => it.key));
  const incompleteNow = data.incompleteScan === true;

  // 没有基线：这份数据就是基线（静默）；它是不完整表则记为不可信
  if (prevKeys === null) {
    return { nextKeys, copy: null, baselineIncomplete: incompleteNow };
  }
  // 基线不可信、这份数据已完整（失败恢复）：存量全是「第一次见」——静默重建基线、基线恢复可信
  if (priorUntrusted && !incompleteNow) {
    return { nextKeys, copy: null, baselineIncomplete: false };
  }
  // 其余照常做差；基线仍不可信（上一轮不可信且这轮仍不完整）则继续标记，等完整扫描来重建
  const stillUntrusted = priorUntrusted && incompleteNow;
  const { notify, newItems } = diffInboxUnreadForNotify(prevKeys, items);
  if (!notify || newItems.length === 0 || args.windowFocused) {
    return { nextKeys, copy: null, baselineIncomplete: stillUntrusted };
  }
  return { nextKeys, copy: buildInboxNotifyCopy(newItems), baselineIncomplete: stillUntrusted };
};

/**
 * 「通知基线」的状态机（第七轮：hook 原来用两个 ref 手工往返 `planInboxNotify` 的 nextKeys / baselineIncomplete，
 * 往返接线只有源码文本契约）。把「基线 keys + 基线是否可信」收进一个对象，hook 只调 `settle`——
 * 往返的行为（含场景 B 的多轮序列）可以直接对这个对象测，不依赖 hook 怎么写。
 */
export interface InboxNotifyBaseline {
  /** 一份 data 落地：更新基线 / 可信标记，返回要发的系统通知文案（没有 = null） */
  settle(data: InboxNotifyShape | null, windowFocused: boolean): { title: string; body: string } | null;
  /** 当前基线（null = 尚未建基线）；测试 / 诊断用 */
  readonly keys: ReadonlySet<string> | null;
  /** 当前基线是否建在不完整的表上；测试 / 诊断用 */
  readonly incomplete: boolean;
}

export const createInboxNotifyBaseline = (): InboxNotifyBaseline => {
  let keys: Set<string> | null = null;
  let incomplete = false;
  return {
    settle(data, windowFocused) {
      const plan = planInboxNotify({
        data,
        prevKeys: keys,
        windowFocused,
        baselineIncomplete: incomplete,
      });
      keys = plan.nextKeys;
      incomplete = plan.baselineIncomplete;
      return plan.copy;
    },
    get keys() {
      return keys;
    },
    get incomplete() {
      return incomplete;
    },
  };
};

/**
 * 轮询拍上「这一拍要不要扫」（N1-03：托盘常驻时收件箱照常低频扫描，角标 / 通知才有意义）：
 * - 窗口可见：每拍都扫（拍 = {@link MR_INBOX_POLL_INTERVAL_MS}，与以前一致）；
 * - 窗口不可见（Cmd+W 收进托盘 / 最小化 / 被全遮住）：**Electron 壳内**放宽到 {@link MR_INBOX_HIDDEN_POLL_INTERVAL_MS} 继续扫——
 *   以前不可见直接不扫，角标不涨、通知发不出，回前台补拉时 `document.hasFocus()` 已为真、通知又被静默；
 * - 非壳环境（浏览器标签页）：维持「不可见不扫」，没人看的标签页不该占 meegle / GitLab 额度。
 *
 * 放宽实现为「隔拍扫」：拍仍是 5 分钟，不可见时只在距上次扫描已过约 10 分钟的那一拍才扫。
 * 留半拍容差——定时器抖动 / 扫描耗时会让 `sinceLastFetchMs` 略小于整数倍，不留容差会隔拍变成隔两拍。
 */
export const shouldPollInboxNow = (args: {
  visible: boolean;
  inShell: boolean;
  /** 距上次发起扫描的毫秒数 */
  sinceLastFetchMs: number;
}): boolean => {
  if (args.visible) return true;
  if (!args.inShell) return false;
  return (
    args.sinceLastFetchMs >=
    MR_INBOX_HIDDEN_POLL_INTERVAL_MS - MR_INBOX_POLL_INTERVAL_MS / 2
  );
};
