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
 */

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
export const nextDataOnScanFailure = <D extends InboxGroupsShape>(
  prev: D | null,
  message: string,
  makeErrorData: (message: string) => D,
): D => {
  if (prev && prev.status === "ok") return prev;
  return makeErrorData(message);
};
