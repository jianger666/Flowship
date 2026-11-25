/**
 * 「测试后台操作」探针（Windows，设置页按钮触发）：在**真的锁屏**的状态下，验证锁屏后台档整条链路是否可用。
 *
 * 为什么需要它：后台档靠的是一串「锁屏时 Windows 到底让不让」的假设（PrintWindow / PostMessage 在锁屏时照常工作吗、
 * 目标应用锁屏时还画不画界面……），项目里没有 Windows 机器，没法提前确认。这个探针让第一台 Windows 真机上的一次点击
 * 就能回答「机制本身通不通」，并把「哪些应用锁屏时画不出来」列出来——和「用户的某个具体应用不行」区分开。
 *
 * 做法（用一个我们自己开的经典控制台窗口当靶子，不碰用户的任何应用）：
 *   1. 倒计时（给用户把手拿开）
 *   2. 开靶子：`conhost.exe cmd.exe /k title flowship-probe-<随机>`（强制经典 conhost，不让「Windows 终端」接管），按标题找到它
 *   3. 锁屏（LockWorkStation），等进入锁屏并稳定
 *   4. 锁屏状态下后台截图：靶子窗口画出来了吗？其它应用各是什么状态（列进程名 + 状态，不含标题）
 *   5. 锁屏状态下对靶子点一下、打一条 `title flowship-probe-<随机>-ok` 再回车，然后读窗口标题：
 *      标题变了 = 窗口真的收到并执行了我们发的键盘消息（不需要读屏幕、不需要剪贴板）
 *   6. 清理（关靶子）。电脑保持锁屏——没有密码可输、也不应该输，用户自己解锁
 *
 * 安全：打字之前先用 windowAt 确认靶子在点击位置的最上层，被别的窗口盖住就不打（绝不把字打进用户的应用）；
 * 整个过程只发窗口消息、不碰真实键鼠、不碰密码；输入的文字是固定的探针标记，不含用户内容。
 *
 * 全部依赖注入（驱动 / 后台驱动 / spawn / sleep / now），Mac 上用假对象整条单测。
 */

export const PROBE_LIMITS = Object.freeze({
  /** 给用户把手拿开的时间 */
  countdownMs: 5000,
  /** 等靶子窗口出现 */
  windowWaitMs: 8000,
  /** 等锁屏生效 */
  lockWaitMs: 5000,
  /** 锁屏后等界面稳定 */
  lockSettleMs: 2500,
  /** 打完字等标题变化 */
  titleWaitMs: 4000,
  pollMs: 200,
  /** 关窗口后等多久再强杀进程 */
  cleanupGraceMs: 400,
});

const message = (err) => String(err?.message || err).replace(/\s+/g, " ").slice(0, 160);

/** 一次截图里各状态的窗口数，如「ok 5、blank 2」 */
export const describeStatusCounts = (windows) => {
  const counts = new Map();
  for (const w of windows) counts.set(w.status, (counts.get(w.status) ?? 0) + 1);
  return [...counts.entries()].map(([status, n]) => `${status} ${n}`).join("、") || "没有窗口";
};

/** 画不出来的窗口（blank / failed / timeout）的「进程名=状态」清单（最多 8 个，不含标题） */
export const describeProblemWindows = (windows) =>
  windows
    .filter((w) => w.status !== "ok" && w.status !== "skipped")
    .slice(0, 8)
    .map((w) => `${w.processName || w.className || "?"}=${w.status}`)
    .join("、");

/**
 * @param {{
 *   driver: { lockScreen: () => Promise<void> | void, isScreenLocked: () => boolean | null },
 *   background: {
 *     findWindowsByTitle: (text: string) => Array<{ hwnd: any, x: number, y: number, width: number, height: number }>,
 *     classOf: (hwnd: any) => string,
 *     capture: () => Promise<{ windows: Array<{ className: string, processName: string, x: number, y: number, width: number, height: number, status: string }> }>,
 *     windowAt: (x: number, y: number) => { hwnd: any } | null,
 *     click: (x: number, y: number) => Promise<void>,
 *     typeText: (text: string) => Promise<void>,
 *     keyCombo: (combo: { mods: string[], key: string }) => Promise<unknown>,
 *     readTitle: (hwnd: any) => string,
 *     closeWindow: (hwnd: any) => void,
 *     reset: () => void,
 *   },
 *   spawn: (command: string, args: string[], opts: Record<string, unknown>) => { once?: (ev: string, fn: (err: Error) => void) => void, kill: () => void },
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   log?: (msg: string) => void,
 *   randomId?: () => string,
 *   limits?: Partial<typeof PROBE_LIMITS>,
 * }} deps
 */
export const createBackgroundProbe = (deps) => {
  const { driver, background, spawn, log = () => {} } = deps;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const randomId = deps.randomId ?? (() => Math.random().toString(16).slice(2, 10).padEnd(8, "0"));
  const limits = { ...PROBE_LIMITS, ...(deps.limits ?? {}) };

  /**
   * @param {{ shouldAbort?: () => boolean, onStep?: (s: { name: string, ok: boolean, ms: number, detail?: string }) => void }} [ctx]
   * @returns {Promise<{ ok: boolean, steps: Array<{ name: string, ok: boolean, ms: number, detail?: string }>, error?: string }>}
   */
  const run = async (ctx = {}) => {
    const shouldAbort = typeof ctx.shouldAbort === "function" ? ctx.shouldAbort : () => false;
    const onStep = typeof ctx.onStep === "function" ? ctx.onStep : () => {};
    const steps = [];
    const add = (name, ok, ms, detail) => {
      const step = { name, ok, ms, ...(detail ? { detail: String(detail).slice(0, 400) } : {}) };
      steps.push(step);
      try {
        onStep(step);
      } catch {
        /* 进度回调出错不影响探针 */
      }
    };
    const finish = (error) => ({ ok: error === undefined, steps, ...(error === undefined ? {} : { error }) });

    const marker = `flowship-probe-${randomId()}`;
    const okTitle = `${marker}-ok`;
    let child = null;
    let hwnd = null;

    const cleanup = async () => {
      if (hwnd !== null) {
        try {
          background.closeWindow(hwnd);
        } catch {
          /* 窗口可能已经没了 */
        }
      }
      if (child) {
        await sleep(limits.cleanupGraceMs);
        try {
          child.kill();
        } catch {
          /* 进程可能已经退出 */
        }
      }
      try {
        background.reset();
      } catch {
        /* ignore */
      }
    };

    try {
      // ── 1 倒计时 ──
      let t = now();
      await sleep(limits.countdownMs);
      add("countdown", true, now() - t);
      if (shouldAbort()) return finish("倒计时期间 AI 开始使用电脑了，测试已取消（没有锁屏）");
      if (driver.isScreenLocked() === true) return finish("倒计时期间电脑已经被锁屏了，测试已取消");

      // ── 2 开靶子窗口 ──
      t = now();
      let spawnError = null;
      try {
        child = spawn("conhost.exe", ["cmd.exe", "/k", "title", marker], { windowsHide: false, stdio: "ignore" });
        child?.once?.("error", (err) => {
          spawnError = err;
        });
      } catch (err) {
        spawnError = err;
      }
      let target = null;
      const windowDeadline = t + limits.windowWaitMs;
      while (!target && !spawnError && now() < windowDeadline) {
        let list = [];
        try {
          list = background.findWindowsByTitle(marker);
        } catch (err) {
          add("window", false, now() - t, `枚举窗口失败：${message(err)}`);
          return finish("后台组件枚举窗口失败，没法继续测试");
        }
        if (list.length > 0) target = list[0];
        else await sleep(limits.pollMs);
      }
      if (!target) {
        add(
          "window",
          false,
          now() - t,
          spawnError
            ? `没能启动测试窗口：${message(spawnError)}`
            : `等了 ${Math.round(limits.windowWaitMs / 1000)} 秒，测试窗口没有出现（可能被安全软件拦下，或系统把控制台窗口交给了其它终端程序）`,
        );
        return finish("没能打开测试窗口，测试无法继续（没有锁屏）");
      }
      hwnd = target.hwnd;
      let className = "";
      try {
        className = background.classOf(hwnd);
      } catch {
        className = "";
      }
      add(
        "window",
        true,
        now() - t,
        className === "ConsoleWindowClass"
          ? "经典控制台窗口（ConsoleWindowClass）"
          : `窗口类名是 ${className || "未知"}，不是经典控制台窗口（可能被「Windows 终端」接管）：下面的输入测试结果可能不适用`,
      );

      // ── 3 锁屏 ──
      t = now();
      try {
        await driver.lockScreen();
      } catch (err) {
        add("lock", false, now() - t, message(err));
        return finish("锁屏命令失败，测试已取消");
      }
      let locked = false;
      const lockDeadline = now() + limits.lockWaitMs;
      while (now() < lockDeadline) {
        if (driver.isScreenLocked() === true) {
          locked = true;
          break;
        }
        await sleep(limits.pollMs);
      }
      add("lock", locked, now() - t);
      if (!locked) return finish("发出了锁屏命令，但电脑没有进入锁屏状态");
      await sleep(limits.lockSettleMs);
      if (shouldAbort()) return finish("测试期间 AI 开始使用电脑了，测试已中止");
      if (driver.isScreenLocked() !== true) {
        add("still_locked", false, 0, "锁屏之后电脑又被解开了");
        return finish("锁屏之后电脑又被解开了（用户回来了？），测试中止——这样测不出锁屏状态下的结果");
      }

      // 靶子可能被系统挪动过：锁屏之后重新取一次位置
      let current = target;
      try {
        current = background.findWindowsByTitle(marker)[0] ?? target;
      } catch {
        current = target;
      }

      // ── 4 锁屏状态下后台截图 ──
      t = now();
      let captureOk = false;
      let targetStatus = "missing";
      try {
        const shot = await background.capture();
        const windows = Array.isArray(shot?.windows) ? shot.windows : [];
        const mine = windows.find(
          (w) => w.className === className && w.x === current.x && w.y === current.y && w.width === current.width && w.height === current.height,
        );
        targetStatus = mine?.status ?? "missing";
        captureOk = targetStatus === "ok";
        const problems = describeProblemWindows(windows);
        add(
          "capture",
          captureOk,
          now() - t,
          `共 ${windows.length} 个窗口（${describeStatusCounts(windows)}）；测试窗口：${targetStatus}${problems ? `；画不出来的：${problems}` : ""}`,
        );
      } catch (err) {
        add("capture", false, now() - t, `合成截图失败：${message(err)}`);
      }

      // ── 5 锁屏状态下往靶子里打字 ──
      t = now();
      let inputOk = false;
      let inputDetail = "";
      try {
        const cx = Math.round(current.x + current.width / 2);
        const cy = Math.round(current.y + current.height / 2);
        const top = background.windowAt(cx, cy);
        if (!top || top.hwnd !== current.hwnd) {
          inputDetail = "测试窗口被别的窗口盖住了，为避免把字打进别的应用，这一步没有执行";
        } else {
          await background.click(cx, cy);
          await background.typeText(`title ${okTitle}`);
          await background.keyCombo({ mods: [], key: "enter" });
          const titleDeadline = now() + limits.titleWaitMs;
          while (now() < titleDeadline) {
            if (String(background.readTitle(current.hwnd)).includes(okTitle)) {
              inputOk = true;
              break;
            }
            await sleep(limits.pollMs);
          }
          inputDetail = inputOk ? "窗口收到了按键并执行了命令（标题已经变化）" : "消息发出去了，但窗口没有反应（标题没变）";
        }
      } catch (err) {
        inputDetail = `输入失败：${message(err)}`;
      }
      add("input", inputOk, now() - t, inputDetail);

      if (captureOk && inputOk) return finish();
      const problems = [];
      if (!captureOk) problems.push(`锁屏时对测试窗口截图没有成功（状态：${targetStatus}）`);
      if (!inputOk) problems.push("锁屏时往测试窗口里打字没有生效");
      return finish(problems.join("；"));
    } catch (err) {
      log(`[desktop-background-probe] 探针出错：${message(err)}`);
      add("error", false, 0, message(err));
      return finish(`测试过程中出错：${message(err)}`);
    } finally {
      await cleanup();
    }
  };

  return { run };
};
