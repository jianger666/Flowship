/**
 * macOS 锁屏解锁器：唤醒 → 确认确实是锁屏 → 从钥匙串取开机密码 → 用真实键码输入 → 回车 → 确认已解开。
 *
 * 契约见 ../types.mjs 的 ScreenUnlocker。本模块不含策略（谁能触发、冷却、遮罩、锁回去的时机都在 session.mjs），
 * 只负责「把这一次解锁做对、做完或停在原地」。
 *
 * 硬规矩（单测逐条钉死）：
 * - 只试一次，任何一步出问题都停手，绝不重试 —— 输错密码会触发账户锁定，比「没解开」严重得多。
 * - 不是锁屏界面（或读不到状态）就不输入任何东西；输入之前再确认一次仍是锁屏（用户可能刚好自己解开了）。
 * - 没有「辅助功能」权限就不输入（权限缺失时系统会静默丢弃事件，等于白输一次密码）。
 * - 密码只在取出后到输入前这一小段存在于局部变量里，随后丢弃引用；不进 onStep、不进返回值、不进日志。
 * - 取消：每一步之前都检查；已经提交过回车的，以「电脑实际是否已解锁」为准返回（会等满回车后的验证时间，
 *   慢机器上解锁要好几秒），这样刚好解开的那一刻被取消，上层也知道要把电脑锁回去。
 * - 返回 attempted 告诉上层「是不是真的把密码输进去过」：没输过的失败（没权限 / 没锁屏 / 读不到密码 /
 *   密码里有键码模式输入不了的字符）不该触发冷却。保存密码时同样预检一遍，存不进去比存进去却永远解不开好得多。
 * - 锁屏支持 method:"shortcut"：默认方式没生效时，session 换成直接按锁屏快捷键再试一次。
 * - 密码「在手上」时调用的驱动 / 钥匙串（预检、输入、保存）抛错或返回错误文字，出这个模块之前先把整串密码抹掉（redact-secret.mjs）：
 *   下游（事件 / 审计 / 日志 / 给 AI 的错误文案）都认不出它，只有这一层认得。
 */
import { redactError, redactSecret } from "../redact-secret.mjs";

export const UNLOCK_TIMING = Object.freeze({
  /** 唤醒显示器之后等一会儿，让锁屏界面起来 */
  wakeMs: 1200,
  /** 微移鼠标「叫醒」锁屏界面之后等它就绪 */
  revealMs: 800,
  /** 回车之后最多等多久看到「已解锁」 */
  verifyTimeoutMs: 8000,
  verifyStepMs: 250,
  /** 解开之后等桌面渲染完，再确认一次没有弹回锁屏 */
  settleMs: 1500,
  /** 取消时若已提交过回车，至少再等多久看看到底解开没有（实际还要等满「回车之后 verifyTimeoutMs」，取两者较晚的那个） */
  cancelGraceMs: 2000,
});

class Stop extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * @param {{
 *   driver: import("../types.mjs").DesktopDriver & { inputPermitted?: () => boolean | null },
 *   keychain: { available: () => boolean, unavailableReason: () => string | null, has: () => boolean, set: (p: string) => { ok: boolean, error?: string }, get: () => string | null, remove: () => boolean },
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   timing?: Partial<typeof UNLOCK_TIMING>,
 * }} deps
 * @returns {import("../types.mjs").ScreenUnlocker}
 */
export const createDarwinUnlocker = (deps) => {
  const { driver, keychain, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = deps;
  const t = { ...UNLOCK_TIMING, ...(deps.timing ?? {}) };

  const hasCredential = async () => keychain.has();

  /** 这段密码在锁屏界面「打得出来」吗（驱动没有预检能力时按「打得出」处理，真打不出会在输入前的预检里失败） */
  const typeable = (secret) => typeof driver.canTypeKeys !== "function" || driver.canTypeKeys(secret) === true;

  const NOT_TYPEABLE_HINT =
    "锁屏界面只认真实键码，自动解锁目前只能输入英文字母、数字和常见符号（中文、emoji、少见符号都不行）";

  /**
   * 保存开机密码。先预检「解锁时真的打得出来」：存进去却永远解不开，等到那一刻才白白失败（还会进冷却），不如保存时就说清楚。
   */
  const setCredential = async ({ password }) => {
    try {
      if (!typeable(password)) {
        return {
          ok: false,
          error: `${NOT_TYPEABLE_HINT}。这个开机密码里有输入不了的字符，所以没有保存。可以把开机密码改成只含英文字母、数字和常见符号的，或者只在电脑没锁屏时使用电脑操作`,
        };
      }
      const r = keychain.set(password);
      // 钥匙串层返回的错误文字也过一遍（它不该带密码，但这是密码在手上的最后一层）
      return r?.ok === true ? r : { ok: false, error: redactSecret(r?.error ?? "保存失败", password) };
    } catch (err) {
      // 预检 / 钥匙串抛的异常：不原样往外抛（异常文字可能回显了入参），折成统一的失败结果
      return { ok: false, error: `保存开机密码时出错：${redactSecret(String(err?.message || err), password).slice(0, 160)}` };
    }
  };

  /**
   * 保存的开机密码「读得出、打得出」吗（设置页「测试」在真的锁屏之前先问一句：明知解不开就别把用户的电脑锁上）。
   * 会读一次钥匙串，只在用户亲自点测试时调用；密码只活在这个函数里，返回值里没有它。
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  const checkCredential = async () => {
    let secret = null;
    try {
      secret = keychain.get();
      if (!secret) return { ok: false, error: "没有读到保存的开机密码，请到设置的「电脑操作」里重新保存" };
      if (!typeable(secret)) return { ok: false, error: `保存的开机密码里有输入不了的字符：${NOT_TYPEABLE_HINT}。请换成可输入的密码重新保存` };
      return { ok: true };
    } catch (err) {
      // keychain.get 的错误文案都是我们自己写的中文（describeStatus），不含密码；预检（driver.canTypeKeys）是外部代码、拿着密码跑的，
      // 它抛的错误文字可能回显了入参：先抹掉整串密码，再截断（先截断的话，被截成半截的密码就认不出来了）
      return { ok: false, error: redactSecret(String(err?.message || err), secret).slice(0, 160) };
    } finally {
      secret = null;
    }
  };

  /** 删除已保存的开机密码；返回真实结果（删不掉就如实说，别让用户以为已经清掉了） */
  const clearCredential = async () => {
    if (keychain.remove()) return { ok: true };
    return {
      ok: false,
      error: "没能删掉保存开机密码的钥匙串文件（钥匙串不可用，或文件被占用、没有权限）。如果一直删不掉，请退出 Flowship，把应用数据文件夹里的 desktop-keychain 文件夹删掉",
    };
  };

  const unlock = async ({ signal, onStep } = {}) => {
    let attempted = false;
    let submitted = false;
    /** 回车提交的时刻（虚拟时钟 / 真时钟）：取消时据此算「这次提交本来会等多久」 */
    let submittedAt = 0;
    const aborted = () => signal?.aborted === true;

    const emit = (name, ok, t0) => {
      try {
        // 输密码那一步不报耗时：输入循环的耗时随密码长度线性增长，而步骤耗时会原样进审计文件 / 设置页测试结果 / 导出的诊断包——
        // 报出去就等于把开机密码的长度送了出去（第三轮评审）。其余步骤（唤醒 / 验证等）与密码无关，照常报
        onStep?.({ name, ok, ms: name === "type" ? 0 : now() - t0 });
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

    /**
     * 取消：已提交回车的以「电脑实际是否解锁」为准，免得刚好解开又被取消时上层不知道要锁回去。
     * 看多久：至少 cancelGraceMs，**且要等满这次提交本来会等的验证时间**（回车后 verifyTimeoutMs）。
     * 只给「取消时刻起 2 秒」的话：慢机器 / FileVault 下解锁要 3~8 秒，取消恰好落在这段里，2 秒后判「还锁着」，
     * 上层就当它没解开（不锁回去），几秒后电脑却自己解开了——用户不在场、没遮罩、没人管（第二轮评审 P1-4）。
     */
    const finishCancelled = async () => {
      if (submitted) {
        const deadline = Math.max(now() + t.cancelGraceMs, submittedAt + t.verifyTimeoutMs);
        for (;;) {
          if (driver.isScreenLocked() === false) return { ok: true, code: "CANCELLED_AFTER_UNLOCK", attempted };
          if (now() >= deadline) break;
          await sleep(t.verifyStepMs);
        }
      }
      return { ok: false, code: "CANCELLED", error: "已取消", attempted };
    };

    try {
      if (aborted()) return await finishCancelled();

      // 1. 确认现在确实是锁屏，且有权限往里输入
      await step("check", async () => {
        const locked = driver.isScreenLocked();
        if (locked === null) throw new Stop("UNLOCK_FAILED", "读不到电脑当前是不是锁屏状态，为安全起见不介入");
        if (locked === false) throw new Stop("NOT_LOCKED", "电脑当前并不是锁屏状态");
        if (driver.inputPermitted?.() === false) {
          throw new Stop("NEED_PERMISSION", "Flowship 还没有「辅助功能」权限，没法往锁屏界面输入。请到系统设置 → 隐私与安全性 → 辅助功能里允许 Flowship");
        }
        if (!keychain.available()) throw new Stop("UNLOCK_FAILED", keychain.unavailableReason() ?? "钥匙串不可用");
      });
      if (aborted()) return await finishCancelled();

      // 2. 唤醒显示器
      await step("wake", async () => {
        await driver.wakeDisplay();
        await sleep(t.wakeMs);
      });
      if (aborted()) return await finishCancelled();

      // 3. 微移鼠标，让锁屏界面进入「可输入」状态（鼠标事件无害）
      await step("reveal", async () => {
        const r = driver.getPrimaryDisplay();
        await driver.mouseMove(r.x + Math.round(r.width / 2), r.y + Math.round(r.height / 2));
        await sleep(t.revealMs);
      });
      if (aborted()) return await finishCancelled();

      // 输入之前最后一次确认：这几秒里用户可能已经自己解开了 —— 那就一个键都不要再按
      if (driver.isScreenLocked() !== true) {
        return {
          ok: false,
          code: "USER_PRESENT",
          error: "检测到电脑已经被解锁（很可能是用户自己解开的），AI 不再介入；再调用一次桌面工具即可直接开始",
          attempted,
        };
      }

      // 4 + 5. 取密码并输入。密码只活在这个 try 里
      let secret = null;
      try {
        secret = await step("credential", async () => {
          const s = keychain.get();
          if (!s) throw new Stop("NO_CREDENTIAL", "没有读到保存的开机密码，请到设置的「电脑操作」里重新保存");
          // 输入之前先确认打得出来：打不出的密码（旧版本存进去的 / 钥匙串里被改过的）一个键都不会按，
          // 也就不算「输错过一次」——不能让一个根本没输过的失败进入冷却
          let canType;
          try {
            canType = typeable(s);
          } catch (err) {
            throw redactError(err, s); // 预检拿着密码跑，它抛的错误文字可能回显了入参
          }
          if (!canType) {
            throw new Stop("UNLOCK_FAILED", `保存的开机密码里有输入不了的字符：${NOT_TYPEABLE_HINT}。请到设置的「电脑操作」里换成可输入的密码重新保存`);
          }
          return s;
        });
        if (aborted()) return await finishCancelled();
        attempted = true; // 一旦开始输入就算「试过一次」（哪怕只输了一半）
        await step("type", async () => {
          try {
            await driver.typeText(secret, { mode: "keys" });
          } catch (err) {
            // 驱动 / 原生层抛的错误文字可能回显了入参（「无法输入 xxx」）：错误会顺着返回值进事件 / 审计 / 给 AI 的错误文案，
            // 下游认不出密码，只有这里（密码还在手上）能抹
            throw redactError(err, secret);
          }
        });
      } finally {
        secret = null;
      }
      if (aborted()) return await finishCancelled();

      // 6. 回车提交
      submitted = true;
      submittedAt = now();
      await step("submit", async () => {
        await driver.keyCombo({ mods: [], key: "enter" });
      });

      // 7. 等它解开
      await step("verify", async () => {
        const deadline = now() + t.verifyTimeoutMs;
        for (;;) {
          if (driver.isScreenLocked() === false) return;
          if (aborted()) throw new Stop("CANCELLED", "已取消");
          if (now() >= deadline) {
            throw new Stop(
              "UNLOCK_FAILED",
              "提交密码后电脑仍然是锁屏状态：可能是保存的密码不对、系统要求了指纹 / 其他验证，或者键盘事件没有送达锁屏界面",
            );
          }
          await sleep(t.verifyStepMs);
        }
      });

      // 8. 等桌面稳定，再确认一次没有弹回锁屏
      await step("settle", async () => {
        await sleep(t.settleMs);
        if (driver.isScreenLocked() !== false) throw new Stop("UNLOCK_FAILED", "解锁之后电脑又回到了锁屏状态");
      });

      return { ok: true, attempted };
    } catch (err) {
      if (err instanceof Stop) {
        if (err.code === "CANCELLED") return await finishCancelled();
        return { ok: false, code: err.code, error: err.message, attempted };
      }
      return { ok: false, code: "UNLOCK_FAILED", error: `自动解锁出错：${err?.message || err}`, attempted };
    }
  };

  /**
   * 锁屏。method:"shortcut"：绕开系统 API 直接按锁屏快捷键——上一次「命令发出了但没进入锁屏」时 session 换这条路再试一次。
   * @param {{ method?: 'auto' | 'shortcut' }} [opts]
   */
  const lock = async (opts = {}) => {
    try {
      if (opts?.method === "shortcut") await driver.lockScreen({ method: "shortcut" });
      else await driver.lockScreen();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `锁屏失败：${err?.message || err}` };
    }
  };

  return { supported: true, hasCredential, setCredential, clearCredential, checkCredential, unlock, lock };
};
