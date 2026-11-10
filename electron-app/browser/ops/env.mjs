/**
 * V3 IO 类新增 op：upload / downloads（契约 §14.1）。
 *
 * - `upload`（动作类）：把本机文件交给页面里的 `<input type=file>`。路径先过 upload-guard（形状 + 敏感黑名单），
 *   白名单目录由 server 侧负责；动作走 session.runAction + AI 归因，和 click / type 一致。
 * - `downloads`（感知类；`wait` 是等待型）：读会话级下载登记表（downloads.mjs），登记发生在 index.mjs 的 will-download。
 *
 * 为什么 upload 不复用 actions.mjs 里的 click：它要在「点击」前后开 / 关 Page.setInterceptFileChooserDialog，
 * 且点击后要等 Page.fileChooserOpened；这些是 V3 独有的 CDP 流程，放在本文件，不碰 V1 正在改的 actions.mjs
 * （只借用它导出的 locate / callOnNode / settle / labelOf）。
 */
import fs from "node:fs";
import path from "node:path";

import { BrowserError } from "../server-channel.mjs";
import { HELD_BUTTON_CLICK_MESSAGE, heldButtonBitsOf } from "../secret-field.mjs";
import { MAX_UPLOAD_FILES, revalidateUploadFiles, validateUploadFiles } from "../upload-guard.mjs";

export const OPS = Object.freeze(["upload", "downloads"]);

/** 点击上传按钮后，等文件选择框弹出的上限 */
export const FILE_CHOOSER_WAIT_MS = 5000;

export const normalize = (op, args, h) => {
  switch (op) {
    case "upload": {
      const paths = args.paths;
      if (
        !Array.isArray(paths) ||
        paths.length === 0 ||
        paths.length > MAX_UPLOAD_FILES ||
        !paths.every((p) => typeof p === "string" && p.trim() !== "" && p.length <= 4096)
      ) {
        throw h.bad(`paths 必须是 1–${MAX_UPLOAD_FILES} 个绝对路径字符串组成的数组`);
      }
      return h.withTab(args, { ref: h.reqStr(args, "ref", { max: 20 }), paths: [...paths] });
    }
    case "downloads": {
      const action = h.reqEnum(args, "action", ["list", "wait"]);
      const sinceId = h.optNum(args, "sinceId", { min: 0, dflt: undefined });
      return h.withTab(args, {
        action,
        ...(sinceId !== undefined ? { sinceId } : {}),
        timeoutMs: h.optNum(args, "timeoutMs", { min: 1000, max: 300_000, dflt: 30_000 }),
      });
    }
    default:
      throw h.bad(`未实现的浏览器操作：${String(op).slice(0, 40)}`);
  }
};

// ───────────────────────── 纯函数 ─────────────────────────

const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

/** 活动日志 / 覆盖层文案：只写文件名，绝不写完整路径（路径里常有用户名 / 项目结构） */
export const describeUpload = (files, label) => {
  const names = files.map((f) => f.name);
  const shown = clip(names.slice(0, 3).join("、") + (names.length > 3 ? ` 等 ${names.length} 个` : ""), 90);
  return {
    summary: `上传了 ${files.length} 个文件到${label}：${shown}`,
    label: `上传 ${files.length} 个文件`,
  };
};

/**
 * 主进程要豁免的「数据目录内、属于本任务」的子目录：`<userData>/data/tasks/<taskId>/{uploads,workspace}`。
 * taskId 必须是安全字符（与 server 的 sanitizeId 同规则），否则不豁免——不能让 `../` 之类的 taskId 把豁免范围拐出去。
 */
export const taskDataAllowDirs = (userData, taskId, extraDataRoots = []) => {
  if (!/^[a-zA-Z0-9_-]+$/.test(String(taskId ?? ""))) return [];
  const roots = [userData ? path.join(userData, "data") : "", ...extraDataRoots].filter(Boolean);
  return roots.flatMap((r) => [path.join(r, "tasks", taskId, "uploads"), path.join(r, "tasks", taskId, "workspace")]);
};

// ───────────────────────── 页内函数（元素所在 frame 的主世界，`this` = 目标元素） ─────────────────────────

const FILE_INPUT_INFO_FN = `function () {
  var el = this;
  var tag = String(el.tagName || '').toLowerCase();
  if (tag !== 'input') return { isFileInput: false };
  return {
    isFileInput: String(el.type || '').toLowerCase() === 'file',
    multiple: !!el.multiple,
    disabled: !!el.disabled,
    directory: !!(el.webkitdirectory)
  };
}`;

// ───────────────────────── handlers ─────────────────────────

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/** 动作期间保持 AI 归因 flag（与 actions.mjs 的 aiScope 同义；那个没导出，这里按同样的约定写一份） */
const aiScope = async (tab, fn) => {
  await tab.setAI(true);
  try {
    return await fn();
  } finally {
    await tab.setAI(false);
  }
};

const findNewTab = (session, tabSeqAtStart) =>
  session.tabSeq > tabSeqAtStart ? (session.tabs.find((t) => t.id === `t${session.tabSeq}`) ?? null) : null;

/** 点一下目标中心（按钮路径用）。输入锁 / AI 归因由 tab.withAiInput 包裹。 */
const clickAt = async (tab, { x, y }) => {
  // R6-30 三轮复审②：AI 还按着 browser_mouse 的键时，这里的 mouseReleased 会把按住的拖放结束在按钮上（落点没探过）——派发前先拒
  if (heldButtonBitsOf(tab) !== 0) throw new BrowserError("BAD_ARGS", HELD_BUTTON_CLICK_MESSAGE);
  const send = (params) => tab.send("Input.dispatchMouseEvent", params, null, 5000);
  await send({ type: "mouseMoved", x, y, button: "none", buttons: 0 });
  await send({ type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await send({ type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
};

/**
 * 等 Page.fileChooserOpened。必须在点击**之前**调用（先订阅再点，避免事件早于订阅丢失）。
 * 返回 { promise, dispose }；dispose 之后 promise 的 rejection 已被吞掉，不会变成未处理的 rejection。
 */
const watchFileChooser = (tab, signal, timeoutMs, ref) => {
  let off = () => {};
  let timer = null;
  let onAbort = null;
  const promise = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new BrowserError(
          "NOT_INTERACTABLE",
          `点击 ${ref} 后 ${Math.round(timeoutMs / 1000)} 秒内没有弹出文件选择框，它可能不是上传按钮。请重新 browser_snapshot，找 type=file 的输入框或带「上传 / 选择文件」字样的按钮再试`,
        ),
      );
    }, timeoutMs);
    if (signal) {
      onAbort = () => reject(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    off = tab.onCdpEvent((method, params, sessionId) => {
      if (method === "Page.fileChooserOpened") resolve({ params: params ?? {}, sessionId: sessionId ?? null });
    });
  });
  promise.catch(() => {});
  return {
    promise,
    dispose: () => {
      clearTimeout(timer);
      off();
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    },
  };
};

export const createHandlers = (deps) => {
  const { app, getSession, requireSession, actions } = deps;

  const userDataDir = () => {
    try {
      return app?.getPath?.("userData") ?? "";
    } catch {
      return "";
    }
  };

  /** 数据目录候选：userData、FLOWSHIP_DATA_DIR（若有），各带 realpath 版本（macOS /var → /private/var 之类） */
  const dataRoots = () => {
    const raw = [userDataDir(), process.env.FLOWSHIP_DATA_DIR ?? ""].filter(Boolean);
    const out = new Set(raw);
    for (const r of raw) {
      try {
        out.add(fs.realpathSync(r));
      } catch {
        /* 目录不存在就没有 realpath */
      }
    }
    return [...out];
  };

  /** upload-guard 的依赖：fs / 数据目录黑名单 / 本任务豁免目录（首次校验与 setFileInputFiles 前的复检共用同一份算法） */
  const guardDeps = (taskId) => {
    const roots = dataRoots();
    const allowedUnderData = taskDataAllowDirs(userDataDir(), taskId, process.env.FLOWSHIP_DATA_DIR ? [process.env.FLOWSHIP_DATA_DIR] : []);
    // 豁免目录也要带 realpath 版本，否则 realpath 后的文件路径对不上
    for (const d of [...allowedUnderData]) {
      try {
        allowedUnderData.push(fs.realpathSync(d));
      } catch {
        /* 目录还没建：没有 realpath */
      }
    }
    // guardFs 仅供单测注入（假 fs 才能模拟「校验后文件被换」）；生产恒为 fs.promises
    return { fs: deps.guardFs ?? fs.promises, dataRoots: roots, allowedUnderData };
  };

  const validate = async (taskId, paths) => {
    try {
      return await validateUploadFiles(paths, guardDeps(taskId));
    } catch (err) {
      throw new BrowserError("BAD_ARGS", err?.message || String(err));
    }
  };

  /** R1-27 TOCTOU：紧贴 DOM.setFileInputFiles 之前再 realpath + 黑名单 + ino/dev 指纹校验一次 */
  const recheck = async (taskId, files) => {
    try {
      await revalidateUploadFiles(files, guardDeps(taskId));
    } catch (err) {
      throw new BrowserError("BAD_ARGS", err?.message || String(err));
    }
  };

  const upload = async (taskId, a, signal) => {
    const session = requireSession(taskId);
    // 先校验再进动作队列：被拒的路径不该点亮「AI 操作中」，也不该排在别的动作后面白等
    const files = await deps.abortable(validate(taskId, a.paths), signal);
    const paths = files.map((f) => f.path);

    return session.runAction({ op: "upload", tabId: a.tabId, signal }, (ctx) =>
      aiScope(ctx.tab, async () => {
        const tab = ctx.tab;
        await tab.ensureCdp();
        const before = { url: tab.url, navCommitted: tab.navCommitted ?? 0, navStarted: tab.navStarted ?? 0 };
        const entry = tab.resolveRef(a.ref);
        const sid = entry.sessionId ?? null;
        const label = actions.labelOf(entry);
        const target = { role: entry.role, name: entry.name, ref: a.ref };
        const info = await actions.callOnNode(tab, entry, a.ref, FILE_INPUT_INFO_FN);
        const setFiles = async (backendNodeId, sessionId) => {
          // 校验发生在动作队列之前，到这里已隔了 ref 解析 / 点击 / 等文件选择框（最长数秒）：交给页面前再核对一遍
          await recheck(taskId, files);
          try {
            await tab.send("DOM.setFileInputFiles", { files: paths, backendNodeId }, sessionId, 10_000);
          } catch (err) {
            throw tab.mapNodeError(err, a.ref);
          }
        };
        const tooMany = (what) =>
          new BrowserError("BAD_ARGS", `${what}只接受 1 个文件，但传了 ${files.length} 个。请只给 1 个路径（需要多个就分次上传）`);

        if (info?.isFileInput) {
          // 路径 A：ref 本身就是 input[type=file]（含视觉上被隐藏、但在 AX 树里的）→ 直接塞文件，不需要点击
          if (info.disabled) throw new BrowserError("NOT_INTERACTABLE", `文件输入框 ${a.ref}（${label}）已禁用，无法上传`);
          if (info.directory) throw new BrowserError("BAD_ARGS", `${a.ref}（${label}）是「选择文件夹」输入框，本工具只支持上传文件`);
          if (!info.multiple && files.length > 1) throw tooMany(`文件输入框 ${a.ref}（${label}）`);
          const d = describeUpload(files, label);
          ctx.describe({ kind: "select", summary: d.summary, label: d.label, target });
          await setFiles(entry.backendNodeId, sid);
        } else {
          // 路径 B：ref 是会弹出文件选择框的按钮 / label → 拦截选择框，点击，拿到它背后的 input 再塞文件
          const loc = await actions.locate(tab, a.ref, ctx);
          const d = describeUpload(files, loc.label);
          ctx.describe({ kind: "select", summary: d.summary, label: d.label, target });
          const watch = watchFileChooser(tab, ctx.signal, FILE_CHOOSER_WAIT_MS, a.ref);
          try {
            // 拦截只对一次点击开着，最后（无论成败）关掉，免得之后用户点上传时选择框不出现
            await tab.send("Page.setInterceptFileChooserDialog", { enabled: true }, sid);
            await tab.withAiInput(() => clickAt(tab, loc.point));
            await tab.setAI(true);
            const chooser = await watch.promise;
            if (chooser.params.mode === "selectSingle" && files.length > 1) throw tooMany("该文件选择框");
            if (typeof chooser.params.backendNodeId !== "number") {
              throw new BrowserError("INTERNAL", "文件选择框没有关联到输入框，无法上传。请改为 browser_snapshot 找到 type=file 的输入框直接上传");
            }
            await setFiles(chooser.params.backendNodeId, chooser.sessionId);
          } finally {
            watch.dispose();
            await tab.send("Page.setInterceptFileChooserDialog", { enabled: false }, sid, 3000).catch(() => {});
          }
        }

        // 给页面一点时间处理 change（图片预览 / 自动上传等）；若触发了导航就等加载
        await sleepMs(200);
        await actions.settle(session, tab, ctx, before, { maxWaitMs: 3000 });
        const res = {
          tabId: tab.id,
          url: tab.url,
          title: tab.title,
          navigated: (tab.navCommitted ?? 0) > before.navCommitted || tab.url !== before.url,
          files: files.map((f) => ({ name: f.name, size: f.size })),
        };
        const newTab = findNewTab(session, ctx.tabSeqAtStart);
        if (newTab) res.newTabId = newTab.id;
        return res;
      }),
    );
  };

  const downloads = async (taskId, a, signal) => {
    // 感知类：没有会话就是「没有下载」，不建会话也不报 NO_SESSION
    const session = getSession(taskId);
    if (!session || session.destroyed || !session.downloads) return { downloads: [], timedOut: false };
    if (a.action === "list") return { downloads: session.downloads.list(), timedOut: false };
    // wait 可被 signal 打断（server cancel / 请求取消），会话销毁时登记表 dispose → CANCELLED
    return session.downloads.waitSettled({ sinceId: a.sinceId, timeoutMs: a.timeoutMs, signal });
  };

  return { upload, downloads };
};
