/**
 * Windows 锁屏解锁器：把「怎么让一台锁屏的电脑回到桌面」交给以 SYSTEM 身份运行的解锁组件（../win-helper/），
 * 这里只管三件事：确认现在确实是锁屏 → 经命名管道请求组件解锁 → 确认桌面稳定。
 *
 * 为什么不像 macOS 那样自己输密码：Windows 锁屏时输入桌面切到 Winlogon，普通用户进程注入不了键鼠、也碰不到锁屏界面，
 * 只有 SYSTEM 身份的进程能在上面输入。所以开机密码在 setCredential 时一次性交给组件（它用 Windows 数据保护加密存放在
 * 只有 SYSTEM / 管理员能读的目录里），解锁时由组件自己在登录界面输入——Flowship 这边既读不回密码，也不会在日志里见到它。
 *
 * 契约见 ../types.mjs 的 ScreenUnlocker。本模块不含策略（谁能触发、冷却、遮罩、锁回去的时机都在 session.mjs），
 * 硬规矩（单测逐条钉死）：
 * - 只试一次，绝不重试：输错开机密码会触发账户锁定，比「没解开」严重得多。组件自己还有 10 分钟的落盘冷却兜底。
 * - 不是锁屏（或读不到状态）就不请求组件；请求之前再确认一次，用户可能刚好自己解开了。
 * - attempted 如实告诉上层「密码是不是真的输进去过」：连接都没建立的失败不算，其它（超时 / 回应中断）按「试过」处理。
 * - 请求发出之后不能取消：组件那头一旦开始输入，必须等它给出真实结果；取消时若已解开，以 CANCELLED_AFTER_UNLOCK 告诉上层去锁回来。
 * - 组件说「已解锁」之后，驱动只在「明确还显示锁屏」时才判失败；读不到（null）按成功算——组件是在系统桌面层面确认的，
 *   这时返回失败反而会让一台已经解开的电脑没人收尾，比误判成功更危险。
 * - supported 恒为 true：Windows 平台是支持这条路线的，「装没装组件」由 helperStatus / hasCredential 表达
 *   （supported:false 会让设置页整块隐藏，用户就看不到安装入口了）。
 */
import { HelperClientError, UNLOCK_TIMEOUT_MS } from "../win-helper/client.mjs";
import { RESPONSE_CODES, describePasswordProblem, describeSetFailure, passwordProblem, responseText, unlockResultFromResponse } from "../win-helper/protocol.mjs";

export const UNLOCK_TIMING = Object.freeze({
  /** 组件说解开之后，最多等多久让驱动也看到「不再是锁屏」 */
  verifyTimeoutMs: 5000,
  verifyStepMs: 250,
  /** 解开之后等桌面渲染完，再确认一次没有弹回锁屏 */
  settleMs: 1500,
});

class Stop extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {boolean} attempted  这次失败时密码是不是已经（可能）输进去过
   */
  constructor(code, message, attempted) {
    super(message);
    this.code = code;
    this.attempted = attempted;
  }
}

const NEED_INSTALL = "还没有安装解锁组件，请先在设置的「电脑操作」里点「安装」（需要管理员授权一次），再保存开机密码";

/**
 * 管道通信出错 → 中文说明。HelperClientError 的消息都是我们自己写的、不含请求内容；
 * 其它「不知道哪来的」异常不回显原文，只给错误类型（请求里带着开机密码，宁可少说也不把原文带出去）。
 */
const describeClientError = (err) => {
  if (err instanceof HelperClientError) {
    if (err.code === "DENIED") return RESPONSE_CODES.DENIED;
    return err.message;
  }
  return `和解锁组件通信出错（${String(err?.code ?? err?.name ?? "未知")}）`;
};

/**
 * @param {{
 *   driver: import("../types.mjs").DesktopDriver,
 *   installer: ReturnType<typeof import("../win-helper/installer.mjs").createHelperInstaller>,
 *   client: ReturnType<typeof import("../win-helper/client.mjs").createHelperClient>,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   timing?: Partial<typeof UNLOCK_TIMING>,
 * }} deps
 * @returns {import("../types.mjs").ScreenUnlocker}
 */
export const createWin32Unlocker = (deps) => {
  const { driver, installer, client, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = deps;
  const t = { ...UNLOCK_TIMING, ...(deps.timing ?? {}) };

  const hasCredential = async () => {
    try {
      const p = await installer.probe();
      return p.installed === true && p.hasCredential === true;
    } catch {
      return false;
    }
  };

  /**
   * 组件里存着一份开机密码吗——**不看组件版本够不够新**（和上面「能用来解锁的」hasCredential 是两个问题）。
   * 只给设置页状态用（manager.getStatus 的 credentialSet）：装着旧版组件、设置页正提示「点安装升级」的那段时间，
   * 用户也得看得到、清得掉自己保存的开机密码（第六轮评审 P2-1：以前这时 credentialSet 恒为 false，「清除」按钮不出现，
   * 关开关也不会清；clearCredential 本来就有意不设版本闸，这里让它在界面上够得到）。
   * 只有组件还在运行、并回了看得懂的状态时才可能为 true（probe 在没装 / 没在运行 / 状态看不懂的分支里不带 hasCredential）；
   * 探测抛错 = 当作没有。解锁预检仍用 hasCredential：版本对不上的组件不拿来解锁。
   */
  const hasStoredCredential = async () => {
    try {
      const p = await installer.probe();
      return p.running === true && p.hasCredential === true;
    } catch {
      return false;
    }
  };

  /**
   * 保存开机密码：先在本地预检「锁屏界面打得出来」（存进去却永远解不开，不如保存时就说清楚），再一次性经管道交给组件。
   * 密码只存在于这个函数的入参和管道请求里，不进返回值、不进日志。
   */
  const setCredential = async ({ password }) => {
    const problem = passwordProblem(password);
    if (problem) return { ok: false, error: describePasswordProblem(problem) };
    const p = await installer.probe();
    if (!p.installed) return { ok: false, error: p.detail ? `${NEED_INSTALL}（${p.detail}）` : NEED_INSTALL };
    try {
      const resp = await client.request("set", { pw: password });
      if (resp.ok) return { ok: true };
      // COOLDOWN_NOT_CLEARED（组件同时回 saved=1）：密码已存好、冷却记录没清掉——不能当成功（用户会以为自动解锁已恢复），文案里写清「已保存」和还剩多久。
      // 返回值再带 saved:true，让设置页分得清「密码已经存上了（别叫用户重新输一遍）」和「根本没存上」；ok 仍是 false（自动解锁还没恢复）。
      // 其它失败一律不带 saved：没存上就是没存上，组件没回 saved=1 也不能当成存上了
      const saved = resp.code === "COOLDOWN_NOT_CLEARED" && resp.fields?.saved === "1";
      return { ok: false, ...(saved ? { saved: true } : {}), error: describeSetFailure(resp, "解锁组件没能保存开机密码") };
    } catch (err) {
      return { ok: false, error: describeClientError(err) };
    }
  };

  /** 保存的开机密码「读得出、打得出」吗（设置页「测试」在真的锁屏之前先问一句）。密码留在组件里，这里只拿到结论 */
  const checkCredential = async () => {
    const p = await installer.probe();
    if (!p.installed) return { ok: false, error: p.detail ? `${NEED_INSTALL}（${p.detail}）` : NEED_INSTALL };
    try {
      const resp = await client.request("check");
      if (resp.ok) return { ok: true };
      return { ok: false, error: responseText(resp.code) ?? "保存的开机密码读不出来，请重新保存" };
    } catch (err) {
      return { ok: false, error: describeClientError(err) };
    }
  };

  /**
   * 删除已保存的开机密码。没装组件 = 本来就没有保存过；装了但没在运行就如实说删不了（卸载会一并清掉）。
   * **有意不看组件版本**（没有版本闸）：只要组件在运行就照常发 clear——用户即使装着旧版组件、设置页正提示「点安装升级」，
   * 也必须能把自己保存的开机密码删掉；C# 侧 DoClear 同样不设闸（第五轮评审确认这是有意的，别「顺手」加上）。
   */
  const clearCredential = async () => {
    const p = await installer.probe();
    if (!p.exeExists) return { ok: true };
    if (!p.running) {
      return { ok: false, error: "解锁组件没有在运行，没法替你删除已保存的开机密码。可以点「安装」把它重新装起来再删，或者直接「卸载」（卸载会把保存的开机密码一起清掉）" };
    }
    try {
      const resp = await client.request("clear");
      if (resp.ok) return { ok: true };
      return { ok: false, error: responseText(resp.code) ?? "解锁组件没能删除已保存的开机密码" };
    } catch (err) {
      return { ok: false, error: describeClientError(err) };
    }
  };

  const unlock = async ({ signal, onStep } = {}) => {
    let attempted = false;
    let submitted = false;
    let unlocked = false;
    const aborted = () => signal?.aborted === true;

    const emit = (name, ok, t0) => {
      try {
        // unlock 这一步 = 组件在锁屏界面上唤醒 + 逐字输入密码 + 等结果的整段往返，用时随密码长度线性增长；
        // 步骤事件会写进审计日志，不报它的耗时（和 macOS 解锁器的 type 步骤一样），免得日志泄露密码长度
        onStep?.({ name, ok, ms: name === "unlock" ? 0 : now() - t0 });
      } catch {
        /* 回调出错不影响解锁流程 */
      }
    };
    const step = async (name, body) => {
      const t0 = now();
      try {
        const v = await body();
        emit(name, true, t0);
        return v;
      } catch (err) {
        emit(name, false, t0);
        throw err;
      }
    };

    /** 取消：请求已发出且组件说解开了的，告诉上层「其实已经解开」，让它去锁回来 */
    const finishCancelled = () => {
      if (submitted && unlocked) return { ok: true, code: "CANCELLED_AFTER_UNLOCK", attempted: true };
      return { ok: false, code: "CANCELLED", error: "已取消", attempted };
    };

    try {
      if (aborted()) return finishCancelled();

      // 1. 组件在不在、有没有保存开机密码、是不是正在冷却：这些都不满足时一个键都不会按，也就不算「试过」
      await step("helper", async () => {
        const p = await installer.probe();
        if (!p.installed) throw new Stop("UNLOCK_FAILED", p.detail ? `解锁组件不可用：${p.detail}` : NEED_INSTALL, false);
        if (p.hasCredential !== true) throw new Stop("NO_CREDENTIAL", RESPONSE_CODES.NO_CREDENTIAL, false);
        if (typeof p.cooldownSeconds === "number" && p.cooldownSeconds > 0) {
          const mins = Math.max(1, Math.ceil(p.cooldownSeconds / 60));
          throw new Stop("UNLOCK_FAILED", `刚刚自动解锁失败过，为避免连续输错密码导致账户被锁定，解锁组件暂停了自动解锁，约 ${mins} 分钟后恢复；重新保存开机密码可立即恢复`, false);
        }
      });
      if (aborted()) return finishCancelled();

      // 2. 确认现在确实是锁屏：用户可能刚好自己解开了——那就别请求组件，免得把密码输进别的窗口
      await step("check", async () => {
        const locked = driver.isScreenLocked();
        if (locked === null) throw new Stop("UNLOCK_FAILED", "读不到电脑当前是不是锁屏状态，为安全起见不介入", false);
        if (locked === false) {
          throw new Stop("USER_PRESENT", "检测到电脑已经被解锁（很可能是用户自己解开的），AI 不再介入；再调用一次桌面工具即可直接开始", false);
        }
      });
      if (aborted()) return finishCancelled();

      // 3. 请求组件解锁。从这里开始不能取消（不传 signal）：组件那头的输入程序一旦开始，必须等它的真实结果
      submitted = true;
      await step("unlock", async () => {
        let resp;
        try {
          resp = await client.request("unlock", {}, { timeoutMs: UNLOCK_TIMEOUT_MS });
        } catch (err) {
          const code = err instanceof HelperClientError ? err.code : "IO";
          // 连接都没建立 = 一个键都没按；其它（超时 / 回应中断 / 通信出错）不知道有没有输进去，按「试过一次」处理
          attempted = !(code === "NOT_RUNNING" || code === "DENIED");
          throw new Stop("UNLOCK_FAILED", describeClientError(err), attempted);
        }
        const result = unlockResultFromResponse(resp);
        attempted = result.attempted;
        if (!result.ok) throw new Stop(result.code ?? "UNLOCK_FAILED", result.error ?? "解锁组件没能解锁", result.attempted);
        unlocked = true;
      });
      if (aborted()) return finishCancelled();

      // 4. 等桌面稳定：驱动明确说「还是锁屏」才算失败（读不到按成功算，原因见文件头）
      await step("settle", async () => {
        const deadline = now() + t.verifyTimeoutMs;
        while (driver.isScreenLocked() === true) {
          if (now() >= deadline) throw new Stop("UNLOCK_FAILED", "解锁组件说已经解开了，但电脑仍然显示为锁屏状态", true);
          await sleep(t.verifyStepMs);
        }
        await sleep(t.settleMs);
        if (driver.isScreenLocked() === true) throw new Stop("UNLOCK_FAILED", "解锁之后电脑又回到了锁屏状态", true);
      });

      return { ok: true, attempted: true };
    } catch (err) {
      if (err instanceof Stop) return { ok: false, code: err.code, error: err.message, attempted: err.attempted };
      return { ok: false, code: "UNLOCK_FAILED", error: `自动解锁出错：${err?.message || err}`, attempted };
    }
  };

  /** 锁屏（LockWorkStation）。Windows 没有「改按快捷键」的备用路线，method 参数忽略 */
  const lock = async () => {
    try {
      await driver.lockScreen();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `锁屏失败：${err?.message || err}` };
    }
  };

  return {
    supported: true,
    overlayBeforeUnlock: true,
    helperStatus: () => installer.status(),
    installHelper: () => installer.install(),
    uninstallHelper: () => installer.uninstall(),
    hasCredential,
    hasStoredCredential,
    setCredential,
    clearCredential,
    checkCredential,
    unlock,
    lock,
  };
};
