/**
 * 增强包 E2 · A5 网络规则（block / set_headers / mock / fail / delay / list / clear）+ B1 HAR 导出（net_export）
 *
 * 纯逻辑在 ../net-rules-engine.mjs（pattern / 头 / mock 校验、规则仓库、命中决策、`Fetch.requestPaused` 的「恰好一次 + 兜底」处理器）、
 * ../har.mjs（HAR 组装与落盘）、../net-filter.mjs（network 列表过滤）。本文件把它们接到 tab / session：
 *
 *  - **Fetch 域只在需要时开**：该 tab 有规则且没被暂停才 `Fetch.enable`（带 `patterns` 限定范围），规则清空 / 暂停就 `Fetch.disable`；
 *    `tab.addSessionHook` 在 CDP 重连、新 OOPIF 子会话上重放；
 *  - **用户接管自动暂停**：`session.onControllerChange`，`controller === "user"`（含 ask_user_to_act）期间 Fetch 关闭、挂起的请求（含等延迟的）立刻放行，
 *    交还后恢复；规则本身不丢；
 *  - **生命周期**：规则存在 `tab.getExt("netrules")` 里，随 tab 关闭 / 会话销毁由 `dispose()` 清掉（不落盘、不跨会话）；
 *  - **凭据**：`set_headers` 的值只存在于规则对象里，list / 状态 / 活动日志 / 工具结果一律只给头名（engine 的 `describeRule` 保证）；
 *  - **动作类**走 `session.runAction`（串行、用户接管时 `USER_CONTROL`、写 AI 活动日志）；`list` 可读（接管期间也行，但标明 paused）；
 *    `net_export` 与 `save` 同属感知类（读页面状态 + 写任务目录，不改页面），自己记活动日志；
 *  - **Flowship origin**：engine 的 `decideForRequest` 对 `isAppUrl` 命中的 URL 一律放行，pattern 再宽也碰不到。
 */
import nodeFs from "node:fs";
import { buildHar, buildHarEntry, harBaseName, harDirFor, writeHarFile } from "../har.mjs";
import { redactUrlSecrets } from "../net-detail.mjs";
import { NetFilterError, normalizeNetworkArgs, selectNetworkEntries } from "../net-filter.mjs";
import { EVALUATE_SUMMARY_MAX, ensureEvaluateApproval, isEvaluateAuthorized, onEvaluateRevoked } from "../evaluate-approval.mjs";
import {
  buildRuleDef,
  createPauseController,
  createRuleStore,
  describeRule,
  MAX_RULES_PER_TAB,
  mockBodyStats,
  NetRuleError,
  RULE_ACTIONS,
  RULE_KINDS,
  ruleNeedsEvaluateApproval,
} from "../net-rules-engine.mjs";
import { BrowserError } from "../server-channel.mjs";
import { redactAndClip } from "../text-redact.mjs";

export const OPS = Object.freeze(["net_rules", "net_export"]);

/** 导出时取 body 的并发数与总时间预算：Network.getResponseBody 对已完成请求通常是毫秒级，预算只是防极端情况拖死 op */
export const HAR_BODY_CONCURRENCY = 6;
export const HAR_BODY_BUDGET_MS = 20_000;

const RULE_ID_RE = /^r\d{1,6}$/;

const wrapRule = (h, fn) => {
  try {
    return fn();
  } catch (err) {
    if (err instanceof NetRuleError) throw h.bad(err.message);
    throw err;
  }
};

export const normalize = (op, args, h) => {
  switch (op) {
    case "net_rules": {
      const action = h.reqEnum(args, "action", RULE_ACTIONS);
      if (RULE_KINDS.includes(action)) {
        // 全部校验交给 engine：缺参 / 多余参数 / 范围 / 禁止头 / 上限都在这里就报 BAD_ARGS（不进 runAction、不碰页面）
        const def = wrapRule(h, () =>
          buildRuleDef({
            action,
            pattern: args.pattern,
            headers: args.headers,
            status: args.status,
            body: args.body,
            contentType: args.contentType,
            errorReason: args.errorReason,
            delayMs: args.delayMs,
          }),
        );
        return h.withTab(args, { action, def });
      }
      if (action === "clear") {
        const ruleId = h.optStr(args, "ruleId", 20);
        if (ruleId !== undefined && !RULE_ID_RE.test(ruleId)) throw h.bad("rule_id 不合法：用 browser_network_rules list 看到的 r1 / r2 …");
        return h.withTab(args, { action, ...(ruleId ? { ruleId } : {}) });
      }
      return h.withTab(args, { action });
    }
    case "net_export": {
      const q = normalizeNetworkArgs(args, h, { defaultLimit: 500 });
      delete q.clear; // 导出不清空（清空是 browser_network 自己的参数）
      return h.withTab(args, { ...q, includeBodies: h.optBool(args, "includeBodies", true) });
    }
    default:
      throw h.bad(`未实现的浏览器操作：${String(op).slice(0, 40)}`);
  }
};

// ───────────────────────── 展示 ─────────────────────────

/** 规则的对外视图：engine 的 describeRule（只有头名、mock 只有大小）+ pattern 过一遍 URL 脱敏 */
export const viewRule = (rule) => {
  const v = describeRule(rule);
  return { ...v, pattern: redactUrlSecrets(v.pattern) };
};

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

const fmtSize = (bytes) => (bytes >= 1048576 ? `${Math.round((bytes / 1048576) * 10) / 10}MB` : bytes >= 1024 ? `${Math.round((bytes / 1024) * 10) / 10}KB` : `${bytes}B`);
const capCount = (n) => (n > 99 ? "99+" : String(n));
/** 审批卡里 body 开头预览的下限：就算前面的统计占得多，也至少留这么多字给「开头」 */
export const MOCK_PREVIEW_MIN_CHARS = 60;

/**
 * 可执行 mock 的审批卡摘要（R6-01 / R6-32）。卡片展示链路有两道上限（不在本文件里）：`ensureEvaluateApproval` → PromptHub.cleanDetail 每个值 ≤200 字，
 * 面板 `describePrompt` 再 clipOneLine 到 160 字——所以**风险信号放最前面**：类型 + body 大小 + 整个 body 里 `<script` / `on*=` 的个数（脚本藏在预览之后也看得见），
 * 其次匹配范围，最后才是 body 开头预览（脱敏后，预算 = 200 − 前面各段）。预览从 40 字放宽到约 100 字（受 200 字上限），要真正 ≥160 字需要 PromptHub / 面板配合。
 * @param {{ pattern: string, mock: { contentType: string, body: string } }} def  规整后的规则定义
 */
export const buildMockApprovalSummary = (def) => {
  const m = def.mock;
  const st = mockBodyStats(m.body);
  const ct = clip(String(m.contentType).split(";")[0].trim(), 40);
  const head = `[模拟响应] 替换页面请求的响应，等同在页面里执行脚本｜${ct} ${fmtSize(st.bytes)} <script×${capCount(st.scripts)} on*=×${capCount(st.handlers)}｜匹配 ${clip(redactUrlSecrets(def.pattern), 40)}｜开头：`;
  const budget = Math.max(MOCK_PREVIEW_MIN_CHARS, EVALUATE_SUMMARY_MAX - head.length);
  return `${head}${redactAndClip(m.body.trimStart(), budget).text}`;
};

/** 活动日志摘要：只写 pattern 与头名，**不写任何值**；整句再过一遍文本脱敏作保险 */
export const summarizeAdd = (rule) => {
  const p = clip(redactUrlSecrets(rule.pattern), 80);
  let s;
  switch (rule.action) {
    case "block":
      s = `屏蔽了匹配 ${p} 的请求`;
      break;
    case "set_headers":
      s = `给匹配 ${p} 的请求加了请求头：${rule.headers.map((x) => x.name).join("、")}（值已隐藏）`;
      break;
    case "mock":
      s = `把匹配 ${p} 的请求改成模拟响应（状态 ${rule.mock.status}，${String(rule.mock.contentType).split(";")[0].slice(0, 40)}）`;
      break;
    case "fail":
      s = `让匹配 ${p} 的请求失败（${rule.errorReason}）`;
      break;
    default:
      s = `让匹配 ${p} 的请求延迟 ${rule.delayMs}ms`;
  }
  return redactAndClip(s, 200).text;
};

// ───────────────────────── tab 级规则运行时 ─────────────────────────

/**
 * 一个 tab 的规则运行时（单测可用假 tab / 假 session 直接驱动）。
 * @param {any} tab
 * @param {{ controller: string }} session
 * @param {{ isAppUrl?: (u: string) => boolean, log?: (m: string) => void, now?: () => number, ruleAllowed?: (rule: any) => boolean, onRuleRefused?: (rule: any) => void }} [env]
 *   `ruleAllowed` / `onRuleRefused`（R6-31）：透传给 createPauseController——规则「当下是否仍被允许生效」的二次判定与被拒时的回调，语义见 engine。
 */
export const createTabRules = (tab, session, env = {}) => {
  const log = (m) => env.log?.(`[browser:${tab.id}] ${m}`);
  const store = createRuleStore({ now: env.now });
  let disposed = false;
  let fetchOn = false;
  let lastPaused = session.controller === "user";
  const isPaused = () => session.controller === "user";

  const controller = createPauseController({
    send: (method, params, sessionId) => tab.send(method, params, sessionId, 10_000),
    getRules: () => store.rules(),
    isPaused: () => disposed || isPaused(),
    isAppUrl: env.isAppUrl,
    onRuled: (info) => tab.noteNetworkRuled?.(info),
    ...(typeof env.ruleAllowed === "function" ? { ruleAllowed: env.ruleAllowed } : {}),
    ...(typeof env.onRuleRefused === "function" ? { onRuleRefused: env.onRuleRefused } : {}),
    log,
  });
  const offEvent = tab.onCdpEvent((method, params, sessionId) => {
    if (method === "Fetch.requestPaused") void controller.onPaused(params, sessionId ?? null);
  });

  const wanted = () => !disposed && store.count() > 0 && !isPaused();
  const enableOn = (sid) => tab.send("Fetch.enable", { patterns: store.cdpPatterns() }, sid, 8000);
  // 新会话（debugger 重连 / 新 OOPIF 子会话）初始化时重放；只负责「开」，关由 apply 统一处理
  const offHook = tab.addSessionHook(async (sid) => {
    if (wanted()) {
      await enableOn(sid);
      fetchOn = true;
    }
  });

  /** 让所有 CDP 会话的 Fetch 状态与「该不该开」一致；串行执行，不 throw，返回 { ok, error? } */
  let chain = Promise.resolve({ ok: true });
  const doApply = async () => {
    if (disposed) return { ok: true };
    const want = wanted();
    if (!want && !fetchOn) return { ok: true };
    try {
      // 关之前先把挂起的请求放行：Fetch.disable 本身也会放行，但我们的处理器里还有等延迟的定时器要收掉
      if (!want) await controller.flush();
      await tab.ensureCdp();
      let mainError = null;
      for (const sid of tab.cdpSessionIds()) {
        try {
          if (want) await enableOn(sid);
          else await tab.send("Fetch.disable", {}, sid, 8000);
        } catch (err) {
          log(`Fetch.${want ? "enable" : "disable"} 失败（session=${sid ?? "main"}）：${String(err?.message ?? err).slice(0, 120)}`);
          if (sid === null) mainError = err;
        }
      }
      if (mainError && want) return { ok: false, error: mainError };
      fetchOn = want;
      return { ok: true };
    } catch (err) {
      log(`同步 Fetch 状态失败：${String(err?.message ?? err).slice(0, 120)}`);
      return { ok: false, error: err };
    }
  };
  const apply = () => {
    chain = chain.then(doApply, doApply);
    return chain;
  };

  const failEnable = (err) =>
    new BrowserError("INTERNAL", `无法在这个标签页上启用网络拦截：${String(err?.message ?? err).slice(0, 120)}。规则没有生效，请稍后重试`);

  return {
    store,
    count: () => store.count(),
    controller,
    /** 加一条规则（上限等 NetRuleError 由 engine 抛）；Fetch 没能启用就回滚这条并抛 INTERNAL */
    async add(def) {
      const rule = store.add(def);
      const r = await apply();
      if (!r.ok) {
        store.remove(rule.id);
        await apply();
        throw failEnable(r.error);
      }
      return rule;
    },
    async remove(id) {
      const ok = store.remove(id);
      if (ok) await apply();
      return ok;
    },
    async clear() {
      const n = store.clear();
      if (n > 0) await apply();
      return n;
    },
    /** 控制权变化（session.onControllerChange 调）：接管 → 暂停、交还 → 恢复；没变化不动 */
    syncPaused() {
      const p = isPaused();
      if (p === lastPaused) return Promise.resolve();
      lastPaused = p;
      return apply().then(() => undefined);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      offEvent();
      offHook();
      controller.dispose();
      store.clear();
    },
  };
};

// ───────────────────────── handlers ─────────────────────────

const EXT_KEY = "netrules";

/**
 * @param {object} deps  index.mjs 的 createExtraHandlers 依赖（契约 §15.1）；测试可额外注入 `fs` / `now`
 */
export const createHandlers = (deps) => {
  const { requireSession, getConfig, abortable, scheduleState } = deps;
  const fs = deps.fs ?? nodeFs;
  const isAppUrl = (u) => {
    try {
      return deps.electron?.isAppUrl?.(u) === true;
    } catch {
      return false;
    }
  };
  const nowDate = () => {
    const v = typeof deps.now === "function" ? deps.now() : undefined;
    return v instanceof Date ? v : new Date(typeof v === "number" ? v : Date.now());
  };
  const userDataDir = () => {
    try {
      return deps.app?.getPath?.("userData") ?? "";
    } catch {
      return "";
    }
  };
  const schedule = (taskId) => {
    try {
      scheduleState?.(taskId);
    } catch {
      /* 状态推送失败不影响结果 */
    }
  };

  /** R6-31：每条规则「批准已失效、被拒绝生效」只写一次活动日志（同一条规则被许多请求命中也不刷屏） */
  const refusedLogged = new WeakSet();
  const noteRefused = (session, tab, rule) => {
    if (refusedLogged.has(rule)) return;
    refusedLogged.add(rule);
    try {
      session.activityLog.addSystem({
        kind: "select",
        tabId: tab.id,
        url: tab.url ?? "",
        summary: `模拟响应 ${rule.id} 的批准已失效（免审批总开关已关且本任务没有批准），已放行原请求、没有返回模拟内容；AI 需重新申请批准`,
      });
      schedule(session.taskId);
    } catch (err) {
      deps.log?.(`[browser] 模拟响应被拒绝生效的活动日志写入失败：${err?.message || err}`);
    }
  };

  const tabRules = (session, tab) => {
    ensureSessionHook(session);
    return tab.getExt(EXT_KEY, () =>
      createTabRules(tab, session, {
        isAppUrl,
        log: deps.log,
        now: typeof deps.now === "function" ? () => nowDate().getTime() : undefined,
        // R6-31 第二道：需要审批类型的 mock 在命中决策前 / fulfill 前都按「当下」的授权状态重判（总闸关且无会话批准 → 不生效）
        ruleAllowed: (rule) => !ruleNeedsEvaluateApproval(rule) || isEvaluateAuthorized(session),
        onRuleRefused: (rule) => noteRefused(session, tab, rule),
      }),
    );
  };
  /** 窥视（不创建）：没设置过规则的 tab 没有这个 ext */
  const peekRules = (tab) => tab.ext?.get(EXT_KEY);

  /**
   * R6-31 第一道：evaluate 批准被撤销（面板「撤销批准」/ 设置里总闸开→关）时，清掉本会话所有 tab 里**需要审批类型**的 mock 规则，并写一条用户可见的活动日志。
   * 同步先把规则从规则表里摘掉（此后任何新到的请求都不会再命中它们），Fetch 状态的重新同步（可能是 Fetch.disable）在后台完成；返回清掉的条数。
   * 不管撤销前有没有「仅本任务」批准都清：总闸开着时创建的可执行 mock 同样要在总闸关掉时收回。
   */
  const clearApprovalBoundMocks = (session, { reason } = {}) => {
    const jobs = [];
    let lastTab = null;
    for (const t of session.tabs ?? []) {
      const tr = peekRules(t);
      if (!tr) continue;
      for (const r of tr.store.rules()) {
        if (!ruleNeedsEvaluateApproval(r)) continue;
        jobs.push(tr.remove(r.id)); // remove 的 store.remove 是同步的，随后才异步 apply
        lastTab = t;
      }
    }
    const n = jobs.length;
    if (n === 0) return Promise.resolve(0);
    try {
      session.activityLog.addSystem({
        kind: "select",
        tabId: lastTab?.id ?? session.activeTabId ?? "",
        url: lastTab?.url ?? "",
        summary: `因撤销批准清除了 ${n} 条模拟响应（html / js 等会在页面里执行的类型）${reason === "gate-off" ? "：设置里关闭了「免审批执行页面脚本」总开关" : ""}`,
      });
      schedule(session.taskId);
    } catch (err) {
      deps.log?.(`[browser] 撤销批准清除模拟响应的活动日志写入失败：${err?.message || err}`);
    }
    return Promise.all(jobs).then(() => n);
  };

  /** 会话级：控制权变化时让各 tab 的规则暂停 / 恢复；批准被撤销时清掉需审批的 mock（第一次设置规则时才挂） */
  const ensureSessionHook = (session) => {
    session.getExt(EXT_KEY, () => {
      const off = session.onControllerChange(() => {
        for (const t of session.tabs ?? []) {
          try {
            void peekRules(t)?.syncPaused();
          } catch (err) {
            deps.log?.(`[browser] 网络规则暂停 / 恢复失败：${err?.message || err}`);
          }
        }
        schedule(session.taskId);
      });
      const offRevoke = onEvaluateRevoked(session, (info) => clearApprovalBoundMocks(session, info));
      return {
        dispose: () => {
          off();
          offRevoke();
        },
      };
    });
  };

  const totalCount = (session) => (session.tabs ?? []).reduce((n, t) => n + (peekRules(t)?.count() ?? 0), 0);

  // 状态贡献者：netRules:{count, paused}（所有 tab 汇总；没有规则时不贡献 → 保持默认 null，横幅不显示）
  deps.addStateContributor?.((session) => {
    const count = totalCount(session);
    return count > 0 ? { netRules: { count, paused: session.controller === "user" } } : {};
  });

  // 面板「一键清除」：用户发起，接管期间也可用（清规则不是 AI 动作）。会话里所有 tab 的规则一起清
  deps.registerExt?.("netrules.clear", async (session) => {
    let cleared = 0;
    let lastTab = null;
    for (const t of session.tabs ?? []) {
      const tr = peekRules(t);
      if (!tr || tr.count() === 0) continue;
      lastTab = t;
      cleared += await tr.clear();
    }
    if (cleared > 0) {
      try {
        session.activityLog.addSystem({
          kind: "select",
          tabId: lastTab?.id ?? session.activeTabId ?? "",
          url: lastTab?.url ?? "",
          summary: `用户清除了 AI 设置的 ${cleared} 条网络规则`,
        });
      } catch (err) {
        deps.log?.(`[browser] 网络规则清除的活动日志写入失败：${err?.message || err}`);
      }
      schedule(session.taskId);
    }
    return { cleared };
  });

  // ── net_rules ──

  const listResult = (session, tab) => {
    const tr = peekRules(tab);
    const rules = tr ? tr.store.list().map((v) => ({ ...v, pattern: redactUrlSecrets(v.pattern) })) : [];
    const paused = session.controller === "user";
    const others = (session.tabs ?? [])
      .filter((t) => t.id !== tab.id)
      .map((t) => ({ tabId: t.id, count: peekRules(t)?.count() ?? 0 }))
      .filter((o) => o.count > 0);
    return {
      tabId: tab.id,
      rules,
      count: rules.length,
      limit: MAX_RULES_PER_TAB,
      paused,
      ...(others.length > 0 ? { otherTabs: others } : {}),
    };
  };

  /**
   * R6-01：mock 的有效 Content-Type 是可执行 / 可渲染类型（html / js / svg / xml / css…）≈ 在目标站 origin 里执行脚本，
   * 与 browser_evaluate 等价——必须过同一道 evaluate 审批（总闸开着免审批；拒绝 / 超时 / 取消 → DENIED，规则不落地）。
   * 放在 runAction **之外**：审批最长等 2 分钟，不能占着动作队列和「AI 操作中」的面板锁；批准后 runAction 里仍会做接管 / 对话框校验。
   */
  const approveExecutableMock = async (session, a, signal) => {
    if (session.controller === "user") {
      throw new BrowserError("USER_CONTROL", "用户正在接管浏览器，AI 的动作被拒绝。请结束本轮、或调用 ask_user_to_act 请用户协助，等用户点「交还给 AI」后再继续");
    }
    const tab = session.getTab(a.tabId);
    // 审批卡摘要由 buildMockApprovalSummary 生成（≤200 字：最要紧的「这是什么」+ 类型 / 大小 / script·on*= 计数放最前，预览放最后）
    const { via } = await ensureEvaluateApproval(session, {
      summary: buildMockApprovalSummary(a.def),
      signal,
      tabId: tab.id,
      host: deps.hostLabel?.(tab.url),
      ...(Number.isFinite(deps.electron?.evaluatePromptTimeoutMs) && deps.electron.evaluatePromptTimeoutMs > 0 ? { timeoutMs: deps.electron.evaluatePromptTimeoutMs } : {}),
    });
    return via;
  };

  const netRules = async (taskId, a, signal) => {
    const session = requireSession(taskId);
    if (a.action === "list") {
      // 只读：不走 runAction，用户接管期间也能看（paused 标明规则此刻没有生效）
      return listResult(session, session.getTab(a.tabId));
    }
    const approvedVia = ruleNeedsEvaluateApproval(a.def) ? await approveExecutableMock(session, a, signal) : null;
    return session.runAction({ op: "net_rules", tabId: a.tabId, signal }, async (ctx) => {
      const tab = ctx.tab;
      const tr = tabRules(session, tab);
      if (a.action === "clear") {
        let removed;
        if (a.ruleId) {
          const existing = tr.store.get(a.ruleId);
          if (!existing) {
            const have = tr.store.list().map((r) => r.id);
            throw new BrowserError("BAD_ARGS", `这个标签页没有规则 ${a.ruleId}（现有：${have.join("、") || "无"}）。用 browser_network_rules list 查看`);
          }
          ctx.describe({
            kind: "select",
            label: "清除网络规则",
            summary: `清除了网络规则 ${a.ruleId}（${existing.action}，${clip(redactUrlSecrets(existing.pattern), 60)}）`,
          });
          ctx.check();
          await tr.remove(a.ruleId);
          removed = 1;
        } else {
          const n = tr.count();
          ctx.describe({ kind: "select", label: "清除网络规则", summary: n > 0 ? `清除了本标签页的 ${n} 条网络规则` : "清除网络规则（本标签页没有规则）" });
          ctx.check();
          removed = await tr.clear();
        }
        schedule(taskId);
        return { tabId: tab.id, action: "clear", removed, count: tr.count(), otherTabsWithRules: (session.tabs ?? []).filter((t) => t.id !== tab.id && (peekRules(t)?.count() ?? 0) > 0).length };
      }
      ctx.check();
      // R6-31：审批与真正落地之间隔着动作队列（可能排队数秒），期间批准被撤销 / 总闸被关就不能落地。
      // 「永久开启」（prompt-always）批准时总闸要等 server 写设置后才变 true，这一刻看不到，所以这条路径不在这里重判（生效与否由 fulfill 前的二次判定把关）
      if (approvedVia !== null && approvedVia !== "prompt-always" && !isEvaluateAuthorized(session)) {
        throw new BrowserError("DENIED", "批准在模拟响应规则落地之前已被撤销（或免审批总开关已关闭），规则没有设置；需要的话请重新发起并等用户批准");
      }
      let rule;
      try {
        rule = await tr.add(a.def);
      } catch (err) {
        if (err instanceof NetRuleError) throw new BrowserError("BAD_ARGS", err.message);
        throw err;
      }
      ctx.describe({ kind: "select", label: "设置网络规则", summary: summarizeAdd(rule) });
      schedule(taskId);
      return { tabId: tab.id, action: a.action, rule: viewRule(rule), count: tr.count(), limit: MAX_RULES_PER_TAB };
    });
  };

  // ── net_export ──

  /** 并发取 body，最新的优先；超时间预算的剩余条目直接跳过（HAR 里注明）。返回 id → { requestText, response } */
  const gatherBodies = async (tab, items, signal) => {
    const bodies = new Map();
    const todo = items.filter((it) => it.found?.detail && !it.found.detail.stream && !it.found.detail.timingOnly && !it.found.detail.redirected).reverse();
    const deadline = Date.now() + HAR_BODY_BUDGET_MS;
    let skipped = 0;
    const worker = async () => {
      while (todo.length > 0) {
        if (Date.now() > deadline) {
          skipped += todo.length;
          for (const it of todo) bodies.set(it.entry.id, { requestText: it.found.detail.postData, response: { ok: false, reason: "导出的时间预算用尽，没有取这条的响应体" } });
          todo.length = 0;
          return;
        }
        const it = todo.shift();
        const [response, fetched] = await Promise.all([tab.fetchNetworkResponseBody(it.entry.id), tab.fetchNetworkPostData(it.entry.id)]);
        bodies.set(it.entry.id, { requestText: it.found.detail.postData ?? fetched, response });
      }
    };
    await abortable(Promise.all(Array.from({ length: HAR_BODY_CONCURRENCY }, worker)), signal);
    return { bodies, skipped };
  };

  const netExport = async (taskId, a, signal) => {
    const session = requireSession(taskId);
    const tab = session.getTab(a.tabId);
    // 开关由主进程独立判：关着就不取 body、HAR 里不含任何 body（也不含 WebSocket / SSE 的负载文本）
    const bodiesAllowed = getConfig().networkBodyRead !== false;
    const wantBodies = a.includeBodies !== false;
    const includeBodies = wantBodies && bodiesAllowed;
    if (typeof tab.backfillResourceTiming === "function") await abortable(tab.backfillResourceTiming().catch(() => 0), signal);
    let picked;
    try {
      picked = selectNetworkEntries(tab.networkRing.list(), a, { redactUrl: redactUrlSecrets });
    } catch (err) {
      if (err instanceof NetFilterError) throw new BrowserError("BAD_ARGS", err.message);
      throw err;
    }
    if (picked.entries.length === 0) {
      throw new BrowserError("BAD_ARGS", "没有可导出的网络请求（当前条件下列表为空）：先让页面发出请求，或放宽过滤条件");
    }
    const items = picked.entries.map((entry) => ({ entry, found: tab.getNetworkEntry(entry.id) }));
    let bodies = new Map();
    let skipped = 0;
    if (includeBodies) ({ bodies, skipped } = await gatherBodies(tab, items, signal));

    const harEntries = items.map(({ entry, found }) => {
      const detail = found?.detail ?? null;
      let body;
      if (includeBodies) {
        if (detail?.stream || entry.type === "WebSocket") body = {};
        else if (bodies.has(entry.id)) body = bodies.get(entry.id);
        else body = { requestText: detail?.postData, response: { ok: false, reason: detail?.redirected ? "这是一次重定向的中间响应，没有响应体" : "没有取到响应体（记录来自页面资源计时 / 详情已被淘汰）" } };
      }
      const streamFrames = detail?.stream || entry.type === "WebSocket" ? (tab.streams?.framesOf(entry.id, 200) ?? undefined) : undefined;
      return buildHarEntry({ entry, detail, body, streamFrames });
    });
    const built = buildHar({ entries: harEntries });

    const dir = harDirFor(userDataDir(), taskId);
    if (!dir) throw new BrowserError("INTERNAL", "无法确定任务目录（userData 或 taskId 不可用），不能导出 HAR");
    let written;
    try {
      written = writeHarFile({ fs, dir, base: harBaseName(nowDate(), tab.url), text: built.text, now: nowDate().getTime() });
    } catch (err) {
      throw new BrowserError("INTERNAL", `写入 HAR 失败：${String(err?.message ?? err).slice(0, 160)}`);
    }
    // 感知类不走 runAction，自己记一条 AI 条目（只写条数，不写路径）
    try {
      session.activityLog.addAI({ kind: "download", tabId: tab.id, url: tab.url, summary: `导出了网络记录（HAR，${built.kept} 条）` });
      schedule(taskId);
    } catch (err) {
      deps.log?.(`[browser] HAR 导出的活动日志写入失败：${err?.message || err}`);
    }
    return {
      tabId: tab.id,
      path: written.path,
      file: written.file,
      entries: built.kept,
      omitted: built.omitted,
      truncated: built.omitted > 0,
      bytes: written.bytes,
      redacted: true,
      bodiesIncluded: includeBodies,
      ...(wantBodies && !bodiesAllowed ? { bodiesDisabled: true } : {}),
      ...(skipped > 0 ? { bodiesSkipped: skipped } : {}),
    };
  };

  return { net_rules: netRules, net_export: netExport };
};
