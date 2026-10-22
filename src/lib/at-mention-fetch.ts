/**
 * `@` 文件候选请求（纯函数、无 React；第三轮 review R6-07）
 *
 * 旧写法 hook 里直接 `fetch` 且没有超时：服务端扫仓慢 / 挂起时，菜单一直停在 loading、
 * `stale` 一直为真，而 `onKeyDown` 对「stale 时 Enter / Tab 拦下」的约束（防半截 `@But`
 * 被当正文提交）就永远不会放开——输入框里 Enter 发不出消息，只能手动 Esc。
 *
 * 这里把「请求 + 读 body」整体收进一个有超时的函数，三种出口：
 * - ok：拿到候选；
 * - failed：HTTP 非 2xx / 网络错误 / 超时（超时同时 abort 底层请求）——调用方按「这个 query 没有候选」收口，
 *   结果所属 query 照记，菜单落「无匹配」、Enter 不再被吞；
 * - aborted：调用方主动取消（query 变了 / 组件卸载）——必须静默，不能把新 query 的结果冲掉。
 */

export interface AtFileHit {
  path: string;
  isDir: boolean;
}

/**
 * 候选请求（含读 body）的整体超时。仓库首扫可能偏慢，但超过它用户就是在等一个不会来的结果
 * （review R6-07 建议 3–5s：期间 Enter / Tab 被菜单拦着，超时后菜单落「无匹配」、Enter 才放开）
 */
export const AT_FETCH_TIMEOUT_MS = 5_000;

export type AtFetchOutcome =
  | { kind: "ok"; files: AtFileHit[] }
  | { kind: "failed" }
  | { kind: "aborted" };

export interface FetchAtFilesOpts {
  taskId: string;
  /** 已截断（normalizeAtQuery）的 query */
  q: string;
  /** 调用方取消信号（query 变化 / 卸载） */
  signal: AbortSignal;
  timeoutMs?: number;
  /** 测试注入 */
  fetchImpl?: typeof fetch;
}

export const fetchAtFiles = async (opts: FetchAtFilesOpts): Promise<AtFetchOutcome> => {
  const { signal } = opts;
  if (signal.aborted) return { kind: "aborted" };
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? AT_FETCH_TIMEOUT_MS;

  // 内部 controller：调用方取消 / 超时都经它终止底层请求
  const inner = new AbortController();
  // 调用方取消也要能立刻收口：不依赖底层 fetch 一定会因 abort 而 reject（body 读取阶段尤其不保证）
  let onOuterAbort: () => void = () => {};
  const cancelled = new Promise<"cancelled">((resolve) => {
    onOuterAbort = () => {
      inner.abort();
      resolve("cancelled");
    };
  });
  signal.addEventListener("abort", onOuterAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      inner.abort();
      resolve("timeout");
    }, timeoutMs);
  });

  const work = (async (): Promise<AtFetchOutcome> => {
    const params = new URLSearchParams({ taskId: opts.taskId, q: opts.q });
    const r = await fetchImpl(`/api/repo-files?${params}`, {
      cache: "no-store",
      signal: inner.signal,
    });
    // 响应已落地后 abort 不再抛 AbortError——这里再判，防慢请求覆盖新 query
    if (signal.aborted) return { kind: "aborted" };
    if (!r.ok) return { kind: "failed" };
    const d = (await r.json()) as { files?: AtFileHit[] } | null;
    if (signal.aborted) return { kind: "aborted" };
    return { kind: "ok", files: Array.isArray(d?.files) ? d.files : [] };
  })().catch((): AtFetchOutcome => (signal.aborted ? { kind: "aborted" } : { kind: "failed" }));

  try {
    const winner = await Promise.race([work, timeout, cancelled]);
    if (winner === "cancelled") return { kind: "aborted" };
    if (winner === "timeout") return signal.aborted ? { kind: "aborted" } : { kind: "failed" };
    return winner;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onOuterAbort);
  }
};
