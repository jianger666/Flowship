/**
 * 网络层守卫（增强包 E2 · A4 证书错误 / A3 HTTP 认证，契约 §15.2）：每个 tab 的 `webContents` 上接
 * `certificate-error` / `login` / `select-client-certificate` 三个事件，把「要不要放行」交给纯函数策略或**用户**（PromptHub 的提示条）。
 * 与 electron 零耦合：事件接线只用 `tab.wc.on`，单测用假 wc 即可驱动。
 *
 * ── A4 证书错误 ──
 *  - Flowship 自己的 origin → 永远拒绝（红线 1）；
 *  - 设置 `trustLoopbackCerts` 开着且主机是「真正的回环」（localhost / 127.x / [::1] / *.localhost；R6-23：`*.local` 是 mDNS、可能是局域网别人的机器，不再自动放行而是询问）→ 放行并在 tab 上记 `certOverride`，
 *    navigate 的结果据此告诉 AI「证书错误已被放行（自签名 / 本机）」；
 *  - 其余主框架 → `cert` 提示（默认拒绝；`allow-host` 只对**本会话 + 这个 host（含端口）+ 这张证书的指纹**有效，不落盘）；
 *  - 子资源证书错误 → 拒绝，除非该 host 已被放行（或属于上面的本机信任）；
 *  - 回调恰好调一次：超时 / tab 销毁 / 导航离开 / 异常一律按默认「拒绝」。
 *
 * ── A3 HTTP Basic / Digest / 代理认证 ──
 *  - `login` 事件：`event.preventDefault()` 后发 `auth` 提示（detail 只有 realm / scheme / proxy / port，host 在提示的 host 字段）；
 *  - 用户提交 → `callback(username, password)`；取消 / 超时 / tab 关闭 / 导航离开 → `callback()`；
 *  - **凭据只在 `answer()` 的参数里经过一次，直接递给网络栈**：不进状态、不进日志、不进活动日志、不给 AI、不记忆（默认）。
 *    本模块里凭据对象的生命周期 = 一次 Promise 回调；活动日志只写「用户为 xxx 提供了认证」，连用户名都不写。
 *
 * ── 客户端证书 ──
 *  - 默认不提供；只有**恰好一张**候选证书且用户在 `clientcert` 提示里点「选择证书」才会使用它（多张证书的选择器面板还没有，一律不提供）。
 *
 * navigate 被认证 / 证书提示挂住时：`tab.promptHold` 返回「本 tab 上挂着的提示的结算 Promise」，tab.navigate 的超时分支据此继续等用户
 * （提示自己有 60 秒超时，不会无限挂）；server 的 pendingPrompts 提示由分发层自动附加。
 */

import { cleanPromptText, createOverflowLogThrottle, overflowSuppressedNote } from "./prompts.mjs";

/** 提示超时（契约：60 秒无人处理按默认动作） */
export const NET_PROMPT_TIMEOUT_MS = 60_000;
/** 被拒 / 取消 / 超时之后，同 tab + 同对象多久内不再重复弹（防页面 / AI 反复触发刷提示条） */
export const CERT_COOLDOWN_MS = 5_000;
export const AUTH_COOLDOWN_MS = 15_000;
/** 凭据长度上限（与提示条输入框的 maxLength 对齐） */
export const AUTH_USERNAME_MAX = 256;
export const AUTH_PASSWORD_MAX = 1024;
const STATE_KEY = "net-guard";
const MAX_ALLOWED_HOSTS = 50;
const MAX_FINGERPRINTS_PER_HOST = 5;
const MAX_COOLDOWN_ENTRIES = 100;

// ───────────────────────── 纯函数：主机判断 ─────────────────────────

/**
 * 「本机 / 开发环境」主机（只传 URL 解析出来的 hostname；调用方务必用 `new URL()`，别自己切字符串——
 * `http://localhost@evil.com` 的 hostname 是 evil.com，`localhost.evil.com` / `evil-localhost` 都不是）：
 *  - `localhost`、`*.localhost`（RFC 6761）；
 *  - 127.0.0.0/8（URL 解析会把 `127.1` / `0x7f.1` 归一成点分十进制，这里只认规范形式）；
 *  - IPv6 回环 `[::1]`；
 *  - **不含** `*.local`（R6-23）：mDNS 名字解析到局域网里的任意机器，局域网中间人可以无提示放行自签名证书；它走「询问」。
 */
export const isLoopbackTrustHost = (hostname) => {
  if (typeof hostname !== "string") return false;
  let h = hostname.toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1); // `localhost.` 是同一个名字
  if (h === "") return false;
  if (h === "localhost" || h === "[::1]") return true;
  if (h.endsWith(".localhost") && h.length > ".localhost".length) return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m && [m[1], m[2], m[3]].every((x) => Number(x) <= 255)) return true;
  return false;
};

/**
 * 证书例外表（allowedCerts / overrideHosts）的 key（R6-22）：带上 partition 标识。
 * 无痕标签是独立内存 partition（独立 cookie 罐），普通标签上选的「放行该主机证书」不能顺带放行无痕标签、反之亦然；
 * 同样，清除浏览数据 / 无痕 wipe 只应清掉对应 partition 的例外。partition 缺省（单测的假 tab）退回裸 host，保持旧 key 兼容。
 * @param {string | undefined | null} partition
 * @param {string} host
 */
export const certScopeKey = (partition, host) => (typeof partition === "string" && partition !== "" ? `${partition}|${host}` : host);

/** URL → `{ host, hostname }`（http / https 之外或解析失败返回 null）；host 含非默认端口 */
export const parseHttpUrl = (url) => {
  if (typeof url !== "string" || url === "" || url.length > 4096) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.hostname === "") return null;
    return { host: u.host, hostname: u.hostname };
  } catch {
    return null;
  }
};

/** 证书指纹（Electron 的 `certificate.fingerprint`，形如 `sha256/Base64…`）；不合格式返回 ""（不记忆、只放行这一次） */
export const certFingerprint = (certificate) => {
  const fp = typeof certificate?.fingerprint === "string" ? certificate.fingerprint.trim() : "";
  return /^[A-Za-z0-9+/=_:-]{8,160}$/.test(fp) ? fp : "";
};

/** 证书错误码展示：`net::ERR_CERT_*` 原样，其余剥格式字符限长 */
const cleanCertError = (error) => (/^net::ERR_[A-Z0-9_]{1,80}$/.test(String(error)) ? String(error) : cleanPromptText(error, 80));

// ───────────────────────── 纯函数：证书决策 ─────────────────────────

/**
 * @param {{
 *   url: string,
 *   isMainFrame: boolean,
 *   config?: { trustLoopbackCerts?: boolean } | null,
 *   isAppUrl?: (url: string) => boolean,
 *   allowedCerts?: Map<string, Set<string>> | null,   // certScopeKey(partition, host) → 已放行的证书指纹
 *   fingerprint?: string,
 *   partition?: string,                               // 发起请求的 tab 的 partition（R6-22：例外按 partition 隔离）
 * }} input
 * @returns {{ action: "allow" | "deny" | "ask", reason: string, host: string | null }}
 */
export const decideCertError = (input) => {
  const parsed = parseHttpUrl(input?.url);
  if (!parsed) return { action: "deny", reason: "bad-url", host: null };
  const host = parsed.host;
  let app = true; // 判断出错按「是 Flowship 自己」处理
  try {
    app = input?.isAppUrl?.(input.url) === true;
  } catch {
    app = true;
  }
  if (app) return { action: "deny", reason: "app-origin", host };
  // 本机信任（开关默认开）：子资源与主框架一样放行——同一台开发机上的页面 + 它的 API / 静态资源
  if (input?.config?.trustLoopbackCerts === true && isLoopbackTrustHost(parsed.hostname)) return { action: "allow", reason: "loopback", host };
  const fp = typeof input?.fingerprint === "string" ? input.fingerprint : "";
  if (fp !== "" && input?.allowedCerts?.get(certScopeKey(input?.partition, host))?.has(fp)) return { action: "allow", reason: "user-allowed", host };
  if (input?.isMainFrame === true) return { action: "ask", reason: "needs-user", host };
  return { action: "deny", reason: "subresource", host };
};

/**
 * auth 回答的校验（交给 PromptHub 的 `validate`）：submit 的 username / password 必须是长度合理、无控制字符的字符串。
 * 非 submit 的动作原样放过；不合格抛错 = 回答无效、提示保持挂起（凭据不进错误信息）。
 */
export const validateAuthAnswer = (decision) => {
  if (!decision || typeof decision !== "object") throw new Error("invalid");
  if (decision.action !== "submit") return { action: decision.action };
  const { username, password } = decision;
  if (typeof username !== "string" || typeof password !== "string") throw new Error("invalid");
  if (username.length > AUTH_USERNAME_MAX || password.length > AUTH_PASSWORD_MAX) throw new Error("invalid");
  if (username === "" && password === "") throw new Error("invalid");
  if (/[\p{Cc}]/u.test(username) || /[\p{Cc}]/u.test(password)) throw new Error("invalid");
  return { action: "submit", username, password };
};

// ───────────────────────── 状态 ─────────────────────────

const createNetState = () => {
  const state = {
    /** host → 用户本会话放行的证书指纹（allow-host） */
    allowedCerts: new Map(),
    /** host → 本会话里「证书错误被放行过」的记录（error / source）：同一主机再次导航时 Chromium 可能复用已建立的连接、不再触发 certificate-error，
     *  靠它在 did-navigate 补回 `tab.certOverride` 标注，免得 AI 第二次访问时把它当成正常 https 站点 */
    overrideHosts: new Map(),
    /**
     * R6-42：本会话里「放行过证书错误」的 partition 集合——loopback 自动放行、用户 allow-host、一次性放行都算，主框架与子资源都算。
     * `allowedCerts` / `overrideHosts` 是**决策记忆**（只在用户选了 allow-host / 主框架放行时才有）；而 Chromium 会复用已放行的那条连接、之后不再触发
     * certificate-error，所以「这个 partition 里是否可能还留着被放行的坏证书连接」只能靠这个集合回答（loopback 自动放行不写 allowedCerts）。
     * key 是系统生成的 partition 名（持久档案 + 无痕名，数量有界）。
     */
    certAllowedPartitions: new Set(),
    certAsk: new Map(),
    authAsk: new Map(),
    cooldown: new Map(),
    /** R6-19：auth / cert 提示名额满（overflow）时的活动日志限速（懒建、时钟取 createNetGuard 的 deps.now；只管日志，不影响决策） */
    overflowLog: null,
    dispose() {
      state.allowedCerts.clear();
      state.overrideHosts.clear();
      state.certAllowedPartitions.clear();
      state.certAsk.clear();
      state.authAsk.clear();
      state.cooldown.clear();
      state.overflowLog?.reset();
    },
    /**
     * `browser:clearBrowsingData`：证书例外也属于浏览数据。
     * R6-22：给了 partition 就只清该 partition 的例外（清除只作用于持久档案，不能连无痕标签刚放行的例外一起清）；不给 = 全清（旧行为）。
     */
    onBrowsingDataCleared(partition) {
      if (typeof partition !== "string" || partition === "") {
        state.allowedCerts.clear();
        state.overrideHosts.clear();
        state.certAllowedPartitions.clear();
        state.cooldown.clear();
        return;
      }
      state.dropPartition(partition);
      // 冷却 key 以 tabId 开头、与 partition 无关；清除浏览数据后让用户能立刻重新决定，整张表清掉即可
      state.cooldown.clear();
    },
    /** 无痕 partition 被 wipe（index.mjs 对所有会话的 ext 广播）：该 partition 的例外作废，名字复用给下一个标签时不能继承 */
    onPartitionWiped(partition) {
      state.dropPartition(partition);
    },
    /** R6-10：该 partition 下的证书例外全部作废（无痕 partition wipe / 会话结束 / 清除数据时调） */
    dropPartition(partition) {
      const prefix = `${partition}|`;
      for (const map of [state.allowedCerts, state.overrideHosts]) {
        for (const k of [...map.keys()]) if (k.startsWith(prefix)) map.delete(k);
      }
      state.certAllowedPartitions.delete(partition);
    },
    /**
     * 该 partition 里是否「放行过证书错误」（会话结束 / 清除浏览数据时据此决定要不要 `closeAllConnections`）。
     * R6-42：不再只看 `allowedCerts`——loopback 自动放行不写它，用户的一次性放行（指纹为空）也不写它，但这些连接同样会被 Chromium 复用；
     * `overrideHosts` 与 `certAllowedPartitions` 一并算。
     */
    hasCertExceptions(partition) {
      const prefix = `${partition}|`;
      for (const map of [state.allowedCerts, state.overrideHosts]) {
        for (const k of map.keys()) if (k.startsWith(prefix)) return true;
      }
      return state.certAllowedPartitions.has(partition);
    },
    /** 会话里出现过的、放行过证书错误的 partition 名（不含无 partition 的旧 key） */
    certExceptionPartitions() {
      const out = new Set();
      for (const map of [state.allowedCerts, state.overrideHosts]) {
        for (const k of map.keys()) {
          const i = k.indexOf("|");
          if (i > 0) out.add(k.slice(0, i));
        }
      }
      for (const p of state.certAllowedPartitions) if (p !== "") out.add(p);
      return [...out];
    },
  };
  return state;
};

/** 取会话的网络守卫状态（没有就建；单测也用它检查「状态里没有凭据」） */
export const getNetGuardState = (session) => session.getExt(STATE_KEY, createNetState);

/** 只看不建（会话结束时判断有没有证书例外；没建过就是没有） */
export const peekNetGuardState = (session) => session?.ext?.get?.(STATE_KEY) ?? null;

/** session：最近一次在本 tab 上发提示所在的会话——tab 销毁时 `findOwner` 已经找不到它了（真机 e2e 抓到的），取消提示得靠这个引用 */
const createTabState = () => ({ pending: new Set(), session: null });
const fallbackTabStates = new WeakMap();
const tabStateOf = (tab) => {
  if (typeof tab.getExt === "function") return tab.getExt(STATE_KEY, createTabState);
  let s = fallbackTabStates.get(tab);
  if (!s) fallbackTabStates.set(tab, (s = createTabState()));
  return s;
};

const rememberCert = (state, host, fp, partition) => {
  if (fp === "") return;
  const key = certScopeKey(partition, host);
  let set = state.allowedCerts.get(key);
  if (!set) {
    if (state.allowedCerts.size >= MAX_ALLOWED_HOSTS) return;
    state.allowedCerts.set(key, (set = new Set()));
  }
  if (set.size >= MAX_FINGERPRINTS_PER_HOST) set.clear();
  set.add(fp);
};

// ───────────────────────── 工厂 ─────────────────────────

/**
 * @param {{
 *   findOwner: (wc: any) => ({ session: any, tab: any } | null),
 *   getConfig: () => ({ trustLoopbackCerts?: boolean } | null),
 *   isAppUrl?: (url: string) => boolean,
 *   log?: (msg: string) => void,
 *   now?: () => number,
 * }} deps
 */
export const createNetGuard = (deps) => {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  const alive = (owner) => !!owner && !owner.session?.destroyed && !owner.tab?.destroyed;
  const isApp = (url) => {
    try {
      return deps.isAppUrl?.(url) === true;
    } catch {
      return true;
    }
  };

  const safeSystemLog = (owner, kind, summary) => {
    try {
      owner.session.activityLog.addSystem({ kind, tabId: owner.tab.id, url: owner.tab.url, summary });
    } catch (err) {
      log(`[browser] 网络守卫活动日志写入失败：${err?.message || err}`);
    }
  };

  const track = (tab, p) => {
    const set = tabStateOf(tab).pending;
    set.add(p);
    const rm = () => set.delete(p);
    p.then(rm, rm);
  };

  const cooling = (state, key) => (state.cooldown.get(key) ?? 0) > now();
  const startCooldown = (state, key, ms) => {
    if (state.cooldown.size >= MAX_COOLDOWN_ENTRIES) state.cooldown.clear();
    state.cooldown.set(key, now() + ms);
  };
  /**
   * R6-19：overflow（提示名额满）不进冷却，所以页面循环请求会让每次都走到「写日志」——这里给 overflow 日志单独限速（每会话每类每 60 秒一条，其余只计数）。
   * 只管日志：决策（按默认拒绝 / 取消）与冷却都不受影响。
   */
  const overflowSlot = (state, kind) => {
    if (!state.overflowLog) state.overflowLog = createOverflowLogThrottle({ now });
    return state.overflowLog.take(kind);
  };

  /** R6-42：这个 partition 里放过一次证书错误（loopback / 用户放行 / 一次性放行、主框架 / 子资源）：之后可能有被复用的连接，要靠 `hasCertExceptions` 触发断连 */
  const noteCertAllowed = (state, tab) => {
    state.certAllowedPartitions.add(typeof tab?.partition === "string" ? tab.partition : "");
  };

  // ── 证书错误 ──

  const markOverride = (tab, host, error, source, state) => {
    tab.certOverride = { host, error, source, at: now() };
    const hosts = state?.overrideHosts;
    if (hosts && typeof host === "string" && host !== "") {
      const key = certScopeKey(tab.partition, host);
      if (hosts.size >= MAX_ALLOWED_HOSTS && !hosts.has(key)) hosts.clear();
      hosts.set(key, { error, source });
    }
  };

  /** certificate-error 事件：回调恰好一次 */
  const onCertificateError = (tab, event, url, error, certificate, callback, isMainFrame) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try {
        callback(ok === true);
      } catch (err) {
        log(`[browser] 证书回调失败（已忽略）：${err?.message || err}`);
      }
    };
    try {
      // 先接管：不 preventDefault 的话 Electron 会按默认（拒绝）直接结束，我们的提示就没机会了
      event?.preventDefault?.();
      const owner = deps.findOwner?.(tab.wc);
      if (!alive(owner)) return done(false);
      tabStateOf(tab).session = owner.session;
      const state = getNetGuardState(owner.session);
      const fp = certFingerprint(certificate);
      const verdict = decideCertError({
        url,
        isMainFrame: isMainFrame === true,
        config: deps.getConfig?.() ?? null,
        isAppUrl: deps.isAppUrl,
        allowedCerts: state.allowedCerts,
        fingerprint: fp,
        partition: tab.partition,
      });
      const err = cleanCertError(error);
      if (verdict.action === "deny") {
        if (isMainFrame === true && verdict.reason !== "app-origin") log(`[browser:${tab.id}] 证书错误已拒绝（${verdict.reason}）：${cleanPromptText(verdict.host ?? "", 80)} ${err}`);
        return done(false);
      }
      if (verdict.action === "allow") {
        if (isMainFrame === true) markOverride(tab, verdict.host, err, verdict.reason === "loopback" ? "loopback" : "user", state);
        // R6-42：loopback 自动放行 / 子资源放行也留一笔记录——这些连接同样会被 Chromium 复用，清除数据 / 会话结束时要能据此断连
        noteCertAllowed(state, tab);
        return done(true);
      }
      // ask：主框架
      const key = `${tab.id}|${verdict.host}|${fp}`;
      if (cooling(state, key)) return done(false);
      let pending = state.certAsk.get(key);
      if (!pending) {
        const host = verdict.host;
        pending = owner.session.prompts
          .request({
            kind: "cert",
            tabId: tab.id,
            host,
            detail: { error: err, subject: certificate?.subjectName ?? "", issuer: certificate?.issuerName ?? "", fingerprint: fp },
            timeoutMs: NET_PROMPT_TIMEOUT_MS,
          })
          .then((ans) => {
            state.certAsk.delete(key);
            if (ans?.action === "allow-host") {
              rememberCert(state, host, fp, tab.partition);
              safeSystemLog(owner, "cert", `用户在本会话内放行了 ${cleanPromptText(host, 80)} 的证书错误（${err}）`);
              return true;
            }
            // R6-19：名额满（overflow）不是用户的决定，不进冷却（免得名额空出来后同一主机仍被冷却挡着）、文案也不写「无人处理」；
            // 没有冷却就没有去重，所以 overflow 的日志单独限速（见 overflowSlot）——页面循环触发证书错误不能把活动日志刷满
            if (ans?.overflow) {
              const slot = overflowSlot(state, "cert");
              if (slot.log) safeSystemLog(owner, "cert", `提示太多，已按默认拒绝 ${cleanPromptText(host, 80)} 的证书错误（${err}）${overflowSuppressedNote(slot.suppressed)}`);
              return false;
            }
            startCooldown(state, key, CERT_COOLDOWN_MS);
            safeSystemLog(owner, "cert", `${ans?.timedOut ? "无人处理，已自动拒绝" : "已拒绝"} ${cleanPromptText(host, 80)} 的证书错误（${err}）`);
            return false;
          });
        state.certAsk.set(key, pending);
        track(tab, pending);
      }
      void pending.then(
        (ok) => {
          if (ok && alive(owner)) {
            markOverride(tab, verdict.host, err, "user", state);
            noteCertAllowed(state, tab); // R6-42：见上
          }
          done(ok && alive(owner));
        },
        () => done(false),
      );
    } catch (e) {
      log(`[browser] 证书错误处理出错，已拒绝：${e?.message || e}`);
      done(false);
    }
  };

  // ── HTTP 认证 ──

  /** login 事件：event.preventDefault() 接管；回调恰好一次；凭据只在这条 Promise 链里经过 */
  const onLogin = (tab, event, details, authInfo, callback) => {
    let settled = false;
    const done = (creds) => {
      if (settled) return;
      settled = true;
      try {
        if (creds) callback(creds.username, creds.password);
        else callback();
      } catch (err) {
        log(`[browser] 认证回调失败（已忽略）：${err?.message || err}`);
      }
    };
    try {
      event?.preventDefault?.();
      const owner = deps.findOwner?.(tab.wc);
      if (!alive(owner)) return done(null);
      tabStateOf(tab).session = owner.session;
      if (isApp(details?.url)) return done(null); // Flowship 自己的 origin 永远不接受认证
      const host = cleanPromptText(authInfo?.host ?? "", 120);
      const port = Number.isFinite(authInfo?.port) ? String(authInfo.port) : "";
      const realm = cleanPromptText(authInfo?.realm ?? "", 160);
      const scheme = cleanPromptText(authInfo?.scheme ?? "", 20);
      const isProxy = authInfo?.isProxy === true;
      if (host === "") return done(null);
      const state = getNetGuardState(owner.session);
      const key = `${tab.id}|${isProxy}|${host}:${port}|${scheme}|${realm}`;
      if (cooling(state, key)) return done(null);
      let pending = state.authAsk.get(key);
      if (!pending) {
        pending = owner.session.prompts
          .request({
            kind: "auth",
            tabId: tab.id,
            host: port ? `${host}:${port}` : host,
            detail: { realm, scheme, proxy: String(isProxy), port },
            timeoutMs: NET_PROMPT_TIMEOUT_MS,
            validate: validateAuthAnswer,
          })
          .then((ans) => {
            state.authAsk.delete(key);
            if (ans?.action === "submit") {
              // 活动日志只写事实，不写用户名 / 密码
              safeSystemLog(owner, "auth", `用户为 ${host}${isProxy ? "（代理服务器）" : ""} 提供了 HTTP 认证`);
              return { username: ans.username, password: ans.password };
            }
            // R6-19：同 cert——overflow 不进冷却、日志单独限速（只管日志，决策不变）
            if (ans?.overflow) {
              const slot = overflowSlot(state, "auth");
              if (slot.log) safeSystemLog(owner, "auth", `提示太多，已按默认取消 ${host}${isProxy ? "（代理服务器）" : ""} 的 HTTP 认证${overflowSuppressedNote(slot.suppressed)}`);
              return null;
            }
            startCooldown(state, key, AUTH_COOLDOWN_MS);
            safeSystemLog(owner, "auth", `${ans?.timedOut ? "无人处理，已自动取消" : "已取消"} ${host}${isProxy ? "（代理服务器）" : ""} 的 HTTP 认证`);
            return null;
          });
        state.authAsk.set(key, pending);
        track(tab, pending);
      }
      void pending.then(
        (creds) => done(alive(owner) ? creds : null),
        () => done(null),
      );
    } catch (e) {
      log(`[browser] 认证处理出错，已取消：${e?.message || e}`);
      done(null);
    }
  };

  // ── 客户端证书 ──

  const onSelectClientCertificate = (tab, event, url, list, callback) => {
    let settled = false;
    const done = (cert) => {
      if (settled) return;
      settled = true;
      try {
        if (cert) callback(cert);
        else callback();
      } catch (err) {
        log(`[browser] 客户端证书回调失败（已忽略）：${err?.message || err}`);
      }
    };
    try {
      // 不 preventDefault 的话 Electron 会自动选第一张证书（等于替用户决定），所以无论如何先接管
      event?.preventDefault?.();
      const owner = deps.findOwner?.(tab.wc);
      if (!alive(owner) || isApp(url)) return done(null);
      tabStateOf(tab).session = owner.session;
      const certs = Array.isArray(list) ? list : [];
      // 多张证书需要选择器面板（还没有）：一律不提供，不替用户猜
      if (certs.length !== 1) return done(null);
      const parsed = parseHttpUrl(url);
      const state = getNetGuardState(owner.session);
      const key = `${tab.id}|clientcert|${parsed?.host ?? ""}`;
      if (cooling(state, key)) return done(null);
      const cert = certs[0];
      const p = owner.session.prompts
        .request({
          kind: "clientcert",
          tabId: tab.id,
          host: parsed?.host ?? "",
          detail: { subject: cert?.subjectName ?? "", issuer: cert?.issuerName ?? "" },
          timeoutMs: NET_PROMPT_TIMEOUT_MS,
        })
        .then((ans) => {
          if (ans?.action === "select") {
            safeSystemLog(owner, "cert", `用户为 ${cleanPromptText(parsed?.host ?? "", 80)} 选择了客户端证书`);
            return cert;
          }
          startCooldown(state, key, CERT_COOLDOWN_MS);
          return null;
        });
      track(tab, p);
      void p.then(
        (c) => done(alive(owner) ? c : null),
        () => done(null),
      );
    } catch (e) {
      log(`[browser] 客户端证书处理出错，已不提供：${e?.message || e}`);
      done(null);
    }
  };

  // ── tab 绑定 ──

  const NET_PROMPT_KINDS = new Set(["auth", "cert", "clientcert"]);

  /** 每个 tab 创建后调一次（host.createTab 里，与 userFeatures.bindTab 同位置） */
  const bindTab = (tab) => {
    const wc = tab.wc;
    if (!wc || typeof wc.on !== "function") return;
    const cancelMine = () => {
      // tab 销毁钩子触发时 findOwner 可能已经找不到它（tab 先被摘出会话）：退回到发提示时记下的会话
      const owner = deps.findOwner?.(wc);
      const session = owner?.session ?? tabStateOf(tab).session;
      if (!session || session.destroyed) return;
      try {
        session.prompts.cancelWhere((p) => NET_PROMPT_KINDS.has(p.kind) && p.tabId === tab.id);
      } catch {
        // 会话正在销毁：提示已由 dispose 结算
      }
    };
    wc.on("certificate-error", (event, url, error, certificate, callback, isMainFrame) =>
      onCertificateError(tab, event, url, error, certificate, callback, isMainFrame),
    );
    wc.on("login", (event, details, authInfo, callback) => onLogin(tab, event, details, authInfo, callback));
    wc.on("select-client-certificate", (event, url, list, callback) => onSelectClientCertificate(tab, event, url, list, callback));
    // 主框架开始新的跨文档导航：上一次的证书放行标记作废、挂着的认证 / 证书提示作废（旧请求已不再需要它们）。
    // 注意本次导航自己的提示发生在 did-start-navigation 之后，不会被误取消
    wc.on("did-start-navigation", (details) => {
      if (details?.isMainFrame !== true || details.isSameDocument === true) return;
      tab.certOverride = null;
      cancelMine();
    });
    // 同一主机再次导航时 Chromium 可能复用已建好的连接，不会再触发 certificate-error：本会话里这个 host 的证书错误放行过，
    // 提交时就把标注补回去（只对 https；本次导航自己触发了事件时 certOverride 已经有值，不覆盖）
    wc.on("did-navigate", (_e, url) => {
      try {
        if (tab.certOverride) return;
        const parsed = parseHttpUrl(url);
        if (!parsed || !String(url).startsWith("https:")) return;
        const owner = deps.findOwner?.(wc);
        if (!alive(owner)) return;
        const rec = getNetGuardState(owner.session).overrideHosts.get(certScopeKey(tab.partition, parsed.host));
        if (rec) tab.certOverride = { host: parsed.host, error: rec.error, source: rec.source, at: now() };
      } catch (err) {
        log(`[browser] 证书放行标注补回失败（已忽略）：${err?.message || err}`);
      }
    });
    tab.addDestroyHook?.(cancelMine);
    // navigate 超时分支用：本 tab 上还有认证 / 证书提示在等用户时，返回它们的结算 Promise
    tab.promptHold = () => {
      const set = tabStateOf(tab).pending;
      return set.size > 0 ? Promise.allSettled([...set]) : null;
    };
  };

  return { bindTab, onCertificateError, onLogin, onSelectClientCertificate };
};
