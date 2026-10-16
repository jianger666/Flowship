/**
 * 设置保存失败后的自动重试（S13-03）
 *
 * 背景：use-settings 的 saveFieldValue 失败只 toast、字段保持 dirty，之后没有任何东西会再去存它——
 * 草稿一直停在「未保存」，直到用户恰好再编辑 + 失焦同一字段；期间 beforeunload 还一直挂着。
 * 现在失败后按退避间隔自动重试几次；该字段一有新的保存发起就作废旧的重试（新值覆盖旧值）；
 * 卸载时把待重试的立刻各补跑一次，免得离开设置页就丢草稿。
 *
 * 纯逻辑（不依赖 React），便于用假定时器单测。
 */

/** 默认退避：2s / 8s / 30s（共 3 次） */
export const DEFAULT_RETRY_DELAYS_MS = [2_000, 8_000, 30_000] as const;

/**
 * 一次保存的结果：布尔（旧调用方），或 `{ ok, status? }`——`status` 是服务端 HTTP 状态码，
 * 网络错误 / 超时 / 初始化未成功这类没有响应的失败没有它。
 */
export type SaveResult = boolean | { ok: boolean; status?: number };

const toSaveOutcome = (r: SaveResult): { ok: boolean; status?: number } =>
  typeof r === "boolean" ? { ok: r } : { ok: r.ok === true, status: r.status };

/**
 * 4xx 里「同一份请求体再发仍可能成功」的三个状态码（第八轮 L1-01，审查方拍板）：
 * 408 Request Timeout、425 Too Early、429 Too Many Requests——它们说的是「现在不行」，不是「这份内容不行」，要退避重试。
 * 本地服务目前只会返回 400 / 403 / 500（审查方实证），所以这是潜伏的：日后前面挂了反向代理 / 限流时才会出现。
 */
const RETRYABLE_4XX: ReadonlySet<number> = new Set([408, 425, 429]);

/**
 * 服务端明确拒绝（4xx，如 PUT /api/settings 校验不过的 400）：同一个请求体再发多少次结果都一样，重试没有意义。
 * 5xx（写盘失败 / 暂时不可读）、没有状态码的失败（网络断 / 超时），以及上面 RETRYABLE_4XX 这三个「暂时不行」的 4xx，
 * 才可能重试成功，照旧退避重试。
 */
const isClientRejection = (status: number | undefined): status is number =>
  typeof status === "number" && status >= 400 && status < 500 && !RETRYABLE_4XX.has(status);

export interface SaveRetrierOptions {
  /** 每次重试的间隔；长度 = 最多重试次数 */
  delaysMs?: readonly number[];
  /** 某字段重试成功 */
  onRecovered?: (key: string) => void;
  /** 某字段重试次数用尽仍失败 */
  onGiveUp?: (key: string) => void;
  /** 某字段的重试被服务端 4xx（408 / 425 / 429 除外，见 isClientRejection）拒绝：立刻终止、不再排后续重试（不走 onGiveUp——它的文案说「多次重试」，这里并不是） */
  onRejected?: (key: string, status: number) => void;
}

export interface SaveRetrier {
  /** 登记一次失败：之后按退避重跑 attempt（返回成功 = 保存成功；永久性 4xx 失败直接终止，408 / 425 / 429 照常重试）；同 key 旧的重试被替换 */
  schedule: (key: string, attempt: () => Promise<SaveResult>) => void;
  /** 该字段有新的保存发起：作废它待办的重试，并让「更早发起、还在路上」的保存失效（世代 +1） */
  cancel: (key: string) => void;
  /**
   * 只丢待办的重试、不动世代：用于「草稿被改了」——
   * 失败的旧值不该再自动写盘（用户可能已改回旧值，blur 时因「和落盘一致」被去重跳过，
   * 没有新保存来 cancel），但此刻在路上的保存失败时仍要照常排重试（见 saveWithRetry）。
   */
  dropPending: (key: string) => void;
  /** 该字段当前世代（saveWithRetry 发起前记下、失败时对比，判断自己是否已被新保存取代） */
  generation: (key: string) => number;
  /** 立刻把所有待重试各跑一次（卸载时用）、并清掉定时器 */
  flush: () => void;
  /** 当前有待重试的字段数（测试 / 诊断用） */
  pendingCount: () => number;
}

interface PendingEntry {
  attempt: () => Promise<SaveResult>;
  /** 已重试次数 */
  tries: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export const createSaveRetrier = (opts: SaveRetrierOptions = {}): SaveRetrier => {
  const delays = opts.delaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const pending = new Map<string, PendingEntry>();

  const arm = (key: string, entry: PendingEntry) => {
    entry.timer = setTimeout(() => void run(key, entry), delays[entry.tries]);
  };

  const run = async (key: string, entry: PendingEntry) => {
    entry.timer = null;
    // 期间被 cancel / 被新的 schedule 替换：不再跑
    if (pending.get(key) !== entry) return;
    entry.tries += 1;
    let result: { ok: boolean; status?: number } = { ok: false };
    try {
      result = toSaveOutcome(await entry.attempt());
    } catch {
      result = { ok: false };
    }
    // await 期间被 cancel / 替换：结果作废（新的保存会自己负责）
    if (pending.get(key) !== entry) return;
    if (result.ok) {
      pending.delete(key);
      opts.onRecovered?.(key);
      return;
    }
    // 服务端 4xx 拒绝（408 / 425 / 429 不算，它们走下面的退避）：同一份内容再重试只会得到同样的拒绝，立刻终止
    if (isClientRejection(result.status)) {
      pending.delete(key);
      opts.onRejected?.(key, result.status);
      return;
    }
    if (entry.tries >= delays.length) {
      pending.delete(key);
      opts.onGiveUp?.(key);
      return;
    }
    arm(key, entry);
  };

  const dropPending = (key: string) => {
    const entry = pending.get(key);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    pending.delete(key);
  };

  // 每个字段的世代：新保存发起（cancel）时 +1。保存是异步的——V1 的 PUT 在路上时用户又发起 V2，
  // V1 晚失败再去排重试，就会在退避后用旧值把 V2 覆盖回去；世代让 V1 的失败回调能认出自己已过期
  const generations = new Map<string, number>();
  const generation = (key: string) => generations.get(key) ?? 0;

  const cancel = (key: string) => {
    generations.set(key, generation(key) + 1);
    dropPending(key);
  };

  return {
    schedule: (key, attempt) => {
      // 替换同 key 旧重试：只丢待办，不能 bump 世代（否则刚发起的那次保存会把自己判成过期）
      dropPending(key);
      const entry: PendingEntry = { attempt, tries: 0, timer: null };
      pending.set(key, entry);
      arm(key, entry);
    },
    cancel,
    dropPending,
    generation,
    flush: () => {
      for (const [key, entry] of [...pending]) {
        if (entry.timer) clearTimeout(entry.timer);
        pending.delete(key);
        // 最后一搏：不再排后续重试、结果不关心（组件已卸载）
        void entry.attempt().catch(() => false);
      }
    },
    pendingCount: () => pending.size,
  };
};

export interface SaveWithRetryArgs {
  retrier: SaveRetrier;
  key: string;
  /** 首次保存：同步发起（调用方依赖它乐观写 cache 的先后顺序）、返回是否成功（失败时可带 HTTP 状态码） */
  first: () => Promise<SaveResult>;
  /** 失败后的重试体（调用方自己用「落盘最新」做 base、成功后标已保存）；失败时同样可带 HTTP 状态码 */
  retry: () => Promise<SaveResult>;
  /** 首次保存失败、且确实会自动重试时调用（toast 提示等）；已被新保存取代 / 被服务端 4xx 拒绝则不调用 */
  onFailed?: () => void;
  /**
   * 首次保存被服务端 4xx 拒绝（如校验不过的 400）：不排重试，改调这里让调用方给出「不会自动重试」的提示。
   * 已被新保存取代则不调用。重试那一次才被拒绝的情形走 SaveRetrierOptions.onRejected。
   */
  onRejected?: (status: number) => void;
}

/**
 * 发起一次字段保存：先作废该字段旧重试、记下世代，失败时仅当「期间没有更新的保存」才处理：
 * 5xx / 无状态码（网络错误）/ 408 / 425 / 429 → 提示并排退避重试；其余 4xx → 不重试、走 onRejected。
 * 抽成纯函数是为了能脱离 React 单测「V1 晚失败 vs V2 已发起」这类竞态。
 */
export const saveWithRetry = ({
  retrier,
  key,
  first,
  retry,
  onFailed,
  onRejected,
}: SaveWithRetryArgs): Promise<boolean> => {
  // 同字段有新保存：旧值的待重试作废（新值覆盖）；cancel 同时 bump 世代、让更早发起的保存失效
  retrier.cancel(key);
  const gen = retrier.generation(key);
  return first().then((saved) => {
    const result = toSaveOutcome(saved);
    if (result.ok) return true;
    // 在路上期间同字段又发起了新保存：本次失败不再提示 / 重试——
    // 磁盘上的最终值由更新的那次保存负责；这里再排重试只会在退避后把旧值写回去
    if (retrier.generation(key) !== gen) return false;
    if (isClientRejection(result.status)) {
      onRejected?.(result.status);
      return false;
    }
    onFailed?.();
    retrier.schedule(key, retry);
    return false;
  });
};
