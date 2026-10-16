/**
 * GitLab PAT 只发往可信 host（S02-03 / S03-03）：首次绑定固定（TOFU）
 *
 * 漏洞：GitLab PAT（settings.gitToken）会被发往「从 git remote 推导出的 host」。
 *   1. `git remote` 存在 agent 可写的 worktree / 主仓 `.git/config` 里（worktree 与主仓共享 config）：
 *      agent 被提示注入后 `git remote set-url origin https://evil/...` 再调 submit_mr，PAT 就发给攻击者；
 *   2. MR 收件箱扫描里的 host 来自飞书 / Meegle 评论里的 URL——任何能评论的人都能塞一个指向恶意 host 的链接。
 *
 * 产品口径是「单 GitLab 实例」，`gitHost` 设置项已退役（见 gitlab-host.ts 顶部，**不要复活 UI 配置**）。
 * 所以方案是：可信 host 一旦确定就固定下来，之后任何 PAT 出站前都拿目标 host 跟它比。
 *
 * ## 「host」= 主机名 + 端口（P3：同一台机器的另一个端口是另一个服务）
 *   所有比较的单位都是规范化后的 `hostname[:port]`（形同 `URL.host`），端口是身份的一部分：
 *   - 固定值 / 白名单 / 出站目标三处同口径：`gitlab.corp.com:8443` 与 `gitlab.corp.com` 互不放行；
 *   - 「无端口」恒指 https 默认端口 443（`:443` 显式与省略等价）；其它默认端口要显式写：
 *     http 的 80 在 URL → host 时写成 `:80`（见 {@link gitHostFromUrl}），不然 `http://h`（80）会和 `https://h`（443）撞成同一个 key；
 *   - 白名单里写不带端口的纯 hostname，只表示默认端口 443；实际地址带非默认端口 → 拒（严格），文案提示「白名单要写带端口的 host」；
 *   - 从 URL 提取 host 必须走 {@link gitHostFromUrl}（别用 `URL.hostname`——那会把端口丢掉）。
 *   本模块是新建、从未发版，没有线上旧固定值要兼容，所以不做「旧 hostname-only 固定值」的迁移 / 宽松匹配。
 *
 * ## 可信 host 的来源（优先级从高到低）
 *   1. `config.json` 里可选的 `gitHostAllowlist: string[]`（无 UI，高级用户手改）：非空时它**独占**——
 *      host 必须命中列表，固定文件不再参与（也不会被写入）。
 *   2. `<dataRoot>/trusted-git-host.json`：首次「可信时机」固定下来的 host。
 *
 * ## 「可信时机」（pinTrustedGitHostIfAbsent 的调用点，越靠前越可信）
 *   固定要有意义，就不能发生在 agent 控制的路径上。用户驱动、agent 介入之前的最早点：
 *   - 服务启动（boot-warmup）：本进程里还没有任何 agent 跑过，从设置里配的仓库 origin 推；
 *   - 设置保存（PUT /api/settings）：用户刚改完 token / 仓库，是纯用户动作；
 *   - 会话启动（task-runner / chat-runner，Agent.create 之前）：该会话的 agent 还没起；
 *   - 兜底：PAT 真正出站时（assertTrustedGitHost）若仍没有固定值，就地固定——
 *     这是最弱的一档（此刻 host 可能已经被篡改过），只保证「之后不再变」。
 *
 * ## 失败策略
 *   - 固定文件**损坏 / 读不出 → fail-closed**（拒发 PAT），且不会被「重新固定」覆盖：
 *     损坏本身就是异常信号，静默重新固定等于把「谁先写入」交给攻击者；用户删除文件即可恢复；
 *   - 固定文件写失败（磁盘满 / 权限）→ 本次放行并 warn：没有任何已固定值可以被违反，
 *     且挡住用户的 MR 比少一次固定更糟；下个可信时机会再试。
 *
 * ## 局限（TOFU 的固有边界，别过度承诺）
 *   - 首次固定之前 remote 已被篡改 → 会固定成攻击者的 host。所以固定尽量前移到启动 / 设置保存。
 *   - 能直接写数据目录（trusted-git-host.json / config.json）的 agent 不在防护范围内——
 *     它同样能直接读 config.json 里的 token。出错文案因此提示「由用户在本机处理、别让 agent 改文件」。
 *   - 只管 server 自己发起的 GitLab 请求；agent shell 里拿到 token 后自己 curl 到哪，这里管不到（见 git-token-env.ts）。
 *   - 「先发给谁」之外还有「对方 302 到谁」：Node `fetch`（undici）跨源重定向时只剔除 Authorization / Cookie，
 *     自定义头 `PRIVATE-TOKEN` 会原样带到新 host。所以带 PAT 的 fetch 一律走 {@link fetchWithGitToken}
 *     （`redirect: "error"`）；git 子进程侧见 team-library.ts 的 buildAuthedGitArgs（`http.followRedirects=false`）。
 *
 * 依赖方向：只依赖 data-root（node:fs / path），被 gitlab-client / task-runner 等引用，避免环。
 */

import fs from "node:fs";
import path from "node:path";

import { dataRoot, supportsUnixFileMode } from "./data-root";

/** 固定文件名（放数据目录根） */
export const TRUSTED_GIT_HOST_FILE_NAME = "trusted-git-host.json";

/** config.json 里可选的白名单字段名（无 UI） */
export const GIT_HOST_ALLOWLIST_KEY = "gitHostAllowlist";

/** 固定来源（只用于日志 / 文件里留痕，便于事后判断「是在哪个时机固定的」） */
export type PinSource = "boot" | "settings" | "session" | "egress";

export const trustedGitHostFilePath = (): string =>
  path.join(dataRoot(), TRUSTED_GIT_HOST_FILE_NAME);

const configFilePath = (): string => path.join(dataRoot(), "config.json");

/**
 * 明显不是自建 GitLab 的公共托管站点：不作为「可信 GitLab host」的固定候选。
 * 为什么：用户常有个别 github 仓库——只绑了 github 的任务若先于 GitLab 任务触发固定，
 * 会把 PAT 的可信 host 固定成 github.com、之后真正的 GitLab 全被拒。
 * 这些 host 即使没固定值也不会被兜底固定（出站时直接拒，GitLab PAT 本来就不该发给它们）。
 */
const NON_GITLAB_PUBLIC_HOSTS: ReadonlySet<string> = new Set([
  "github.com",
  "gitee.com",
  "bitbucket.org",
  "dev.azure.com",
  "ssh.dev.azure.com",
]);

// ----------------- host 规范化 -----------------

/**
 * host 规范化：小写、去协议前缀、去 https 默认端口 `:443`、去尾点；
 * 拒绝 userinfo（`@`）/ 路径 / 空白 / 查询等畸形——这些形态正是凭证外泄的攻击面。
 * 别因大小写 / `host:443` / 尾点 误杀同一个 host；不同端口（`:8443`）是另一个服务、保留不合并。
 * 解析不了返回 null（调用方当「非法 host」拒绝）。
 *
 * 剩下的细节交给 WHATWG `URL` 解析（与最终 fetch / git 实际解析 host 的是同一套规则）：
 * 端口越界 / 非数字（`:99999`、`:abc`）、裸 IPv6、非法字符直接解析失败 = 非法 host；
 * IPv6 字面量保留方括号（`[::1]:8443`）；`:0443` 这类前导零端口收敛成 `:443` 再被省略；IDNA 转 punycode。
 * 输出幂等：`normalizeGitHost(normalizeGitHost(x)) === normalizeGitHost(x)`。
 */
export const normalizeGitHost = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  let h = raw.trim().toLowerCase();
  if (!h) return null;
  h = h.replace(/^https?:\/\//, "");
  if (/[\s/\\@?#]/.test(h)) return null;
  if (!h || h.startsWith(":") || h.endsWith(":") || h.startsWith(".")) {
    return null;
  }
  let u: URL;
  try {
    u = new URL(`https://${h}`);
  } catch {
    return null;
  }
  // 尾点（FQDN 写法 `gitlab.example.com.`，含 `host.:443`）：WHATWG 不折叠它，这里收敛成同一个 host
  const hostname = u.hostname.replace(/\.+$/, "");
  if (!hostname) return null;
  // u.port 对 https 默认端口 443 恒为空串，所以「无端口」恒指 443；其它端口（含 80）原样保留
  return u.port ? `${hostname}:${u.port}` : hostname;
};

/** 把规范化后的 host 拆成「主机名（IPv6 含方括号）+ 端口（无端口 = 空串）」 */
const splitGitHost = (host: string): { hostname: string; port: string } => {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return { hostname: host.slice(0, end + 1), port: host.slice(end + 2) };
  }
  const i = host.lastIndexOf(":");
  return i === -1
    ? { hostname: host, port: "" }
    : { hostname: host.slice(0, i), port: host.slice(i + 1) };
};

/**
 * 从 URL 提取「目的地 host」（团队库 / git remote 这类 URL 形态的出站目标用；返回值可直接喂给 assertTrustedGitHost）。
 * 为什么不能用 `URL.hostname`：它把端口丢了，`https://gitlab.corp.com:8443/…` 会被当成 `gitlab.corp.com`
 * 而通过「同主机」比较——同一台机器上另一个端口的服务就成了可信的（P3）。
 * 口径：
 *   - http / https：身份是「主机名 + 实际端口」。`URL.host` 对各自 scheme 的默认端口不显示（http 的 80、https 的 443），
 *     但本模块 key 空间里「无端口」恒指 443，所以 http 的默认端口要显式写成 `:80`——否则 `http://h`（80）
 *     与 `https://h`（443）会撞成同一个 key。`https://h:80` → `h:80`、`http://h:443` → `h`（就是 443 那个服务）。
 *   - 其它 scheme（ssh:// 等）：URL 里的端口是那个协议自己的端口（ssh 的 22 / 2222），与 HTTPS 服务端口不可比，
 *     而 GitLab PAT 也不会走它——只比主机名，保持「这台机器是不是可信 GitLab」的判断。
 * 解析失败返回 null（调用方当「非法 host」拒绝，别放行）。
 */
export const gitHostFromUrl = (rawUrl: unknown): string | null => {
  if (typeof rawUrl !== "string") return null;
  let u: URL;
  try {
    u = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  const isHttp = u.protocol === "http:";
  if (isHttp || u.protocol === "https:") {
    return normalizeGitHost(`${u.hostname}:${u.port || (isHttp ? "80" : "443")}`);
  }
  return normalizeGitHost(u.hostname);
};

/**
 * 同一主机名、不同端口的「兄弟」提示（只在确有兄弟 / 带端口时返回文案）。
 * 为什么要专门提示：端口不同被拒时，用户眼里「明明写了这个 host」——最常见的是白名单里写了纯 hostname、
 * 而实际地址带端口（或反过来）；不点破就只会觉得「白名单没生效」。
 */
const samePortSiblingNote = (host: string, known: readonly string[]): string => {
  const { hostname, port } = splitGitHost(host);
  const sibling = known.find((k) => k !== host && splitGitHost(k).hostname === hostname);
  if (!sibling) return "";
  const shown = port ? `带端口（${host}）` : "是默认端口 443";
  return `（同一主机名但端口不同：「${sibling}」与「${host}」是两个不同的服务，被拒的地址${shown}）`;
};

/** 白名单未命中时的端口提示：被拒地址带端口，或白名单里有同主机名的兄弟条目，就提示怎么写 */
const allowlistPortHint = (host: string, allow: readonly string[]): string => {
  const sibling = samePortSiblingNote(host, allow);
  if (!sibling && !splitGitHost(host).port) return "";
  return (
    `${sibling}白名单要写带端口的 host（如 "${host}"）：不带端口的写法只表示默认端口 443，` +
    "不同端口是另一个服务、不会互相放行。"
  );
};

// ----------------- 错误类型 -----------------

export type UntrustedGitHostCode =
  | "invalid"
  | "allowlist-miss"
  | "pin-mismatch"
  | "pin-corrupt"
  | "not-candidate";

/** 带稳定 code 的拒绝错误：调用方可以 `instanceof` 判断、测试可以断 code */
export class UntrustedGitHostError extends Error {
  readonly code: UntrustedGitHostCode;
  constructor(code: UntrustedGitHostCode, message: string) {
    super(message);
    this.name = "UntrustedGitHostError";
    this.code = code;
  }
}

/** 错误文案共用的「处理指引」：只写给人看的恢复办法，并明确不要让 agent 自己改文件 */
const recoveryHint = (suggestHost?: string): string =>
  `若确实更换了 GitLab 域名：请用户在本机删除 ${trustedGitHostFilePath()}（下次会按新地址重新绑定），` +
  `或在 ${configFilePath()} 里配置 "${GIT_HOST_ALLOWLIST_KEY}": ["${suggestHost ?? "新的 GitLab host"}"]（高级用法）。` +
  "请把本提示如实转告用户、由用户在本机处理，agent 不要自行改动这些文件。";

// ----------------- 读：固定文件 / 白名单 -----------------

type PinRead =
  | { status: "absent" }
  | { status: "pinned"; host: string }
  | { status: "corrupt"; reason: string };

/** 读固定文件：只有 ENOENT 算「未固定」；其它任何读 / 解析失败都是 corrupt（fail-closed） */
export const readTrustedGitHostPin = (): PinRead => {
  let raw: string;
  try {
    raw = fs.readFileSync(trustedGitHostFilePath(), "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { status: "absent" };
    return { status: "corrupt", reason: `读取失败（${code ?? "unknown"}）` };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    const host =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? normalizeGitHost((parsed as Record<string, unknown>).host)
        : null;
    if (!host) return { status: "corrupt", reason: "内容缺少合法的 host 字段" };
    return { status: "pinned", host };
  } catch {
    return { status: "corrupt", reason: "不是合法 JSON" };
  }
};

/** 已有固定记录（含损坏）——启动 / 设置保存时用来跳过多余的 git remote 推导 */
export const hasTrustedGitHostRecord = (): boolean =>
  readTrustedGitHostPin().status !== "absent";

/**
 * 读 config.json 里的 `gitHostAllowlist`（只抠这一个字段，不缓存、不打印整个文件）。
 * 读不到 / 不是合法 JSON / 字段缺失或不是数组 → 空数组（= 没配白名单，退回固定文件）；
 * 非法条目静默丢弃，全丢光也算没配。
 */
export const readGitHostAllowlist = (): string[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configFilePath(), "utf-8")) as unknown;
  } catch {
    return [];
  }
  const list =
    parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)[GIT_HOST_ALLOWLIST_KEY]
      : undefined;
  if (!Array.isArray(list)) return [];
  const out = new Set<string>();
  for (const item of list) {
    const h = normalizeGitHost(item);
    if (h) out.add(h);
  }
  return [...out];
};

// ----------------- 评估（不写盘、不抛） -----------------

type Evaluation =
  | { kind: "invalid" }
  | { kind: "allowlist-hit"; host: string }
  | { kind: "allowlist-miss"; host: string; allow: string[] }
  | { kind: "pin-match"; host: string }
  | { kind: "pin-mismatch"; host: string; pinned: string }
  | { kind: "pin-corrupt"; host: string; reason: string }
  | { kind: "unpinned"; host: string };

const evaluate = (rawHost: unknown): Evaluation => {
  const host = normalizeGitHost(rawHost);
  if (!host) return { kind: "invalid" };
  const allow = readGitHostAllowlist();
  if (allow.length > 0) {
    return allow.includes(host)
      ? { kind: "allowlist-hit", host }
      : { kind: "allowlist-miss", host, allow };
  }
  const pin = readTrustedGitHostPin();
  if (pin.status === "corrupt") {
    return { kind: "pin-corrupt", host, reason: pin.reason };
  }
  if (pin.status === "absent") return { kind: "unpinned", host };
  return pin.host === host
    ? { kind: "pin-match", host }
    : { kind: "pin-mismatch", host, pinned: pin.host };
};

// ----------------- 固定（TOFU 写入） -----------------

export type PinResult =
  | { status: "pinned"; host: string }
  | { status: "exists-same"; host: string }
  | { status: "exists-different"; host: string; pinned: string }
  | { status: "corrupt"; reason: string }
  | { status: "skipped-allowlist" }
  | { status: "invalid" }
  | { status: "not-candidate"; host: string }
  | { status: "write-failed"; host: string };

/**
 * tmp + rename 原子写固定文件（0600，目录 0700）。
 * 「先读到未固定、再写」之间有极窄的竞态（同一毫秒两个入口各固定一个不同 host）：
 * 两个都是可信时机推出来的 host，后落盘者胜；不为此引入锁，单实例口径下可忽略。
 */
const writePinFileSync = (host: string, source: PinSource): void => {
  const file = trustedGitHostFilePath();
  fs.mkdirSync(
    path.dirname(file),
    supportsUnixFileMode() ? { recursive: true, mode: 0o700 } : { recursive: true },
  );
  const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  const body = `${JSON.stringify(
    { version: 1, host, pinnedAt: new Date().toISOString(), source },
    null,
    2,
  )}\n`;
  try {
    fs.writeFileSync(
      tmp,
      body,
      supportsUnixFileMode()
        ? { encoding: "utf-8", mode: 0o600 }
        : { encoding: "utf-8" },
    );
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 清 tmp 失败不影响抛原错误 */
    }
    throw err;
  }
};

/**
 * 在「可信时机」把 host 固定下来（已固定则什么都不改）。**永不抛**：
 * 调用点是启动 / 设置保存 / 会话启动，固定失败不能挡住这些主流程。
 * 白名单非空时不写固定文件（白名单独占，写了也不会被读）。
 */
export const pinTrustedGitHostIfAbsent = (
  rawHost: unknown,
  source: PinSource,
): PinResult => {
  const host = normalizeGitHost(rawHost);
  if (!host) return { status: "invalid" };
  if (readGitHostAllowlist().length > 0) return { status: "skipped-allowlist" };
  const pin = readTrustedGitHostPin();
  if (pin.status === "corrupt") return { status: "corrupt", reason: pin.reason };
  if (pin.status === "pinned") {
    return pin.host === host
      ? { status: "exists-same", host }
      : { status: "exists-different", host, pinned: pin.host };
  }
  // 按主机名判（不看端口）：`github.com:8443` 也是 github，不该被固定成可信 GitLab
  if (NON_GITLAB_PUBLIC_HOSTS.has(splitGitHost(host).hostname)) {
    return { status: "not-candidate", host };
  }
  try {
    writePinFileSync(host, source);
  } catch (err) {
    console.warn(
      "[trusted-git-host] 写固定文件失败（本次不固定、下个可信时机再试）:",
      err instanceof Error ? err.message : err,
    );
    return { status: "write-failed", host };
  }
  console.log(`[trusted-git-host] 已绑定 GitLab host=${host}（来源=${source}）`);
  return { status: "pinned", host };
};

// ----------------- 出站校验 -----------------

/**
 * PAT 出站前的闸门：host 不可信就 throw {@link UntrustedGitHostError}，调用方必须在**构造请求之前**调用，
 * 失败不得发出任何网络请求。通过则返回规范化后的 host。
 *
 * - 有白名单：必须命中；
 * - 否则读固定值：相同放行、不同拒绝、损坏 fail-closed；
 * - 没有固定值：默认就地兜底固定（最弱一档，见文件头）；`pinIfAbsent:false` 则只放行不固定——
 *   给 host 来自配置而非 remote / 评论的出站点（如共享库）用，它们不该决定「可信 host 是谁」。
 */
export const assertTrustedGitHost = (
  rawHost: unknown,
  opts: { pinIfAbsent?: boolean } = {},
): string => {
  const ev = evaluate(rawHost);
  switch (ev.kind) {
    case "invalid":
      throw new UntrustedGitHostError(
        "invalid",
        `GitLab host 非法或为空（${String(rawHost ?? "")}），为防止 GitLab Token 外发已拒绝。`,
      );
    case "allowlist-hit":
    case "pin-match":
      return ev.host;
    case "allowlist-miss":
      throw new UntrustedGitHostError(
        "allowlist-miss",
        `检测到仓库 origin / 链接指向的 GitLab 地址（${ev.host}）不在 config.json 的 ${GIT_HOST_ALLOWLIST_KEY}（${ev.allow.join("、")}）内，为防止 GitLab Token 外发已拒绝。` +
          allowlistPortHint(ev.host, ev.allow) +
          `如需放行请用户在 ${configFilePath()} 的 ${GIT_HOST_ALLOWLIST_KEY} 里加上该地址；请把本提示如实转告用户、由用户在本机处理，agent 不要自行改动该文件。`,
      );
    case "pin-mismatch":
      throw new UntrustedGitHostError(
        "pin-mismatch",
        `检测到仓库 origin / 链接指向的 GitLab 地址（${ev.host}）与首次绑定的「${ev.pinned}」不一致${samePortSiblingNote(ev.host, [ev.pinned])}，为防止 GitLab Token 外发已拒绝。${recoveryHint(ev.host)}`,
      );
    case "pin-corrupt":
      throw new UntrustedGitHostError(
        "pin-corrupt",
        `可信 GitLab host 记录 ${trustedGitHostFilePath()} 无法使用（${ev.reason}），为防止 GitLab Token 外发已拒绝（fail-closed）。` +
          "请用户在本机修复或删除该文件（删除后会在下次可信时机按仓库 origin 重新绑定）；请把本提示如实转告用户，agent 不要自行改动该文件。",
      );
    case "unpinned": {
      if (opts.pinIfAbsent === false) return ev.host;
      const r = pinTrustedGitHostIfAbsent(ev.host, "egress");
      if (r.status === "pinned" || r.status === "write-failed") return ev.host;
      if (r.status === "exists-same") return ev.host;
      if (r.status === "exists-different") {
        // 评估到固定之间被别处抢先固定成了别的 host（极窄竞态）：按不一致拒绝
        throw new UntrustedGitHostError(
          "pin-mismatch",
          `检测到仓库 origin / 链接指向的 GitLab 地址（${ev.host}）与首次绑定的「${r.pinned}」不一致${samePortSiblingNote(ev.host, [r.pinned])}，为防止 GitLab Token 外发已拒绝。${recoveryHint(ev.host)}`,
        );
      }
      if (r.status === "corrupt") {
        throw new UntrustedGitHostError(
          "pin-corrupt",
          `可信 GitLab host 记录 ${trustedGitHostFilePath()} 无法使用（${r.reason}），为防止 GitLab Token 外发已拒绝（fail-closed）。请用户在本机修复或删除该文件。`,
        );
      }
      // not-candidate（公共托管站点）/ invalid / skipped-allowlist（评估后白名单被改）→ 一律拒绝
      throw new UntrustedGitHostError(
        "not-candidate",
        `尚未绑定可信 GitLab host，且 ${ev.host} 是公共代码托管站点（不是 GitLab 实例），为防止 GitLab Token 外发已拒绝。`,
      );
    }
  }
};

// ----------------- 出站之后：不跟随重定向 -----------------

/**
 * 请求被重定向时抛出（token 没有被带出去）。message 面向最终用户，直接可展示。
 * 单独一个类：调用方 / 测试用 `instanceof` 判断，不必各自去嗅探 undici 的内部错误文案。
 */
export class GitHostRedirectError extends Error {
  constructor() {
    super(
      "GitLab 返回了重定向（3xx），为防止 GitLab Token 被带到其它地址，已拒绝跟随。" +
        "请检查 GitLab 地址是否被改写（http→https 跳转、域名迁移、反向代理）后重试。",
    );
    this.name = "GitHostRedirectError";
  }
}

/**
 * undici 在 `redirect: "error"` 遇到 3xx 时抛 `TypeError("fetch failed", { cause: Error("unexpected redirect") })`。
 * 嗅探 cause 文案不优雅，但这是 fetch 规范里唯一能区分「被重定向」与普通网络错误的信号；
 * 集中在这一处，并由 tests/git-host-redirect.test.ts 用真 undici + 真 http server 钉住——
 * Node 升级后文案变了会直接红，而不是悄悄退化成「网络错误：fetch failed」。
 */
const isRedirectRefusal = (err: unknown): boolean => {
  const cause = (err as { cause?: unknown } | null)?.cause;
  return cause instanceof Error && /unexpected redirect/i.test(cause.message);
};

/**
 * 带 GitLab PAT 的出站 `fetch`：**永不跟随重定向**。
 *
 * 为什么必须关：assertTrustedGitHost 只保证「第一跳发给可信 host」，但 undici 跨源重定向只剔除
 * Authorization / Cookie，自定义头 `PRIVATE-TOKEN` 会原样发给 3xx 指向的任何 host——
 * 可信 host 上一个开放重定向、或反向代理被改写，就把 PAT 送出去了。
 * 用 `error` 而不是 `manual` + 逐跳校验：GitLab REST API 正常不会重定向，没有需要跟随的合法场景；
 * 宁可明确失败（GitHostRedirectError），也不要维护一套「同源才跟随」的逻辑。
 *
 * `redirect` 放在展开之后：调用方无法（也不该）通过 init 再把它改回 follow。
 */
export const fetchWithGitToken = async (
  url: string,
  init: RequestInit = {},
): Promise<Response> => {
  try {
    return await fetch(url, { ...init, redirect: "error" });
  } catch (err) {
    if (isRedirectRefusal(err)) throw new GitHostRedirectError();
    throw err;
  }
};

// ----------------- 给 prompt 用：别让 agent 照着被篡改的 origin 发 token -----------------

/**
 * 「GitLab 访问」提示里该展示的 host。
 * 为什么不直接用 origin 推导值：remote 被篡改后的下一个会话，提示词里写着「host: evil」+
 * 「用 $FLOWSHIP_GITLAB_TOKEN 调 API」，连没被注入的 agent 都会老老实实把 token 发过去。
 * 所以 origin 不可信时改展示可信 host，并通过 untrustedOriginHost 让文案明确警告。
 * 纯读（不固定、不写盘、不抛）。
 */
export const resolveGitHostForPrompt = (
  originHost: string | null | undefined,
): { host?: string; untrustedOriginHost?: string } => {
  if (typeof originHost !== "string" || !originHost.trim()) return {};
  const ev = evaluate(originHost);
  switch (ev.kind) {
    case "allowlist-hit":
    case "pin-match":
    case "unpinned":
      return { host: originHost.trim() };
    case "allowlist-miss":
      return { host: ev.allow.join(" / "), untrustedOriginHost: originHost.trim() };
    case "pin-mismatch":
      return { host: ev.pinned, untrustedOriginHost: originHost.trim() };
    case "pin-corrupt":
    case "invalid":
      return { untrustedOriginHost: originHost.trim() };
  }
};
