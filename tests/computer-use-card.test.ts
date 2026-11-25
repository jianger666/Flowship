/**
 * 「电脑操作」设置卡（src/components/settings/computer-use-card.tsx）+ 渲染端桥类型（src/lib/computer-use-bridge.ts）的行为契约。
 *
 * 本仓 vitest 是 node 环境、没有 jsdom / testing-library，所以分两种手段：
 * - 结构 / 文案 / 禁用态：`renderToStaticMarkup` 看真实输出（SSR 里 effect 不跑 → 桥天然是 null，正好就是「网页版」）；
 * - 交互 / 轮询：`helpers/react-hook-stub` 的槽位桩在受控 dispatcher 下真跑组件 / hook，拿元素树直接调 onClick / onCheckedChange，
 *   setState 之后再 render 一次读最新快照；轮询另配 fake timers + 桩的 window / document。
 *
 * 守的是：
 *  1. 无桥环境整块禁用并提示「仅桌面端可用」（冒烟）；
 *  2. 权限区只在 darwin 出现、状态始终展示、未授权才有「去授权」、点过之后行内提示；
 *  3. 「锁屏时也能用」：门禁只拦「打开」、不支持平台只给说明、未存密码时先弹对话框、保存失败 / 取消开关一个字不动、清除密码联动关开关；
 *  4. 开机密码绝不进 settings / toast / 日志——只经 bridge.setCredential 单向交出；
 *  5. 状态轮询：挂载取一次、3 秒一次、页面隐藏跳过、在途不叠请求、旧响应不盖新快照、读失败静默、卸载清 timer；
 *  6. 设置页接线 / 契约对账（types.mjs ⇄ computer-use-bridge.ts）。
 *
 * 看不到的：「保存开机密码」对话框本身（Dialog 走 portal，SSR 不渲染、也没有 DOM 可点）——
 * 它的业务逻辑（saveCredentialFlow / 开关与对话框的联动）在这里直测，文案 / 掩码输入靠末尾的源码契约守住，真窗口行为要 Electron 里手点。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Loader2 } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BACKGROUND_STEP_LABELS,
  ComputerUseSection,
  ComputerUseView,
  ExportDiagnosticsButton,
  LOCKED_ACCESS_UNAVAILABLE_HINT,
  LockedAccessTest,
  LockedAccessTestReport,
  PermissionGuide,
  PermissionRow,
  STATUS_ERROR_AFTER_FAILURES,
  SWITCH_SYNC_GRACE_MS,
  UNAVAILABLE_CREDENTIAL_HINT,
  UnlockHelperRow,
  actualSwitchState,
  deferredClearVerdict,
  disableLockedAccessFlow,
  getLockedAccessBlockReason,
  getSwitchMismatchNote,
  isComputerUseStatus,
  saveCredentialFlow,
  scrubSecret,
  secretForms,
  shownSwitchState,
  statusReadErrorText,
  useComputerUseStatus,
} from "@/components/settings/computer-use-card";
import { initFailedStatus, unsupportedStatus } from "../electron-app/desktop/index.mjs";
import { secretForms as mainSecretForms } from "../electron-app/desktop/redact-secret.mjs";
import { describeSetFailure } from "../electron-app/desktop/win-helper/protocol.mjs";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { PasswordInput } from "@/components/ui/password-input";
import { SettingRow } from "@/components/ui/setting-row";
import { Switch } from "@/components/ui/switch";
import {
  getComputerUseBridge,
  type ComputerUseBridge,
  type ComputerUseStatus,
  type LockedAccessTestResult,
  type PermissionState,
} from "@/lib/computer-use-bridge";
import { contractBridgeMethods, tsBridgeMethods } from "./helpers/computer-use-contract";
import { createHookHarness } from "./helpers/react-hook-stub";

const h = vi.hoisted(() => ({
  confirm: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock("@/hooks/use-dialog", () => ({ useDialog: () => ({ confirm: h.confirm }) }));
vi.mock("sonner", () => ({
  toast: { error: h.toastError, success: h.toastSuccess, warning: h.toastWarning },
}));

// ---------------------------------------------------------------------------
// 固定文案（任务书规定的原文；改文案要同步改这里）
// ---------------------------------------------------------------------------
const MASTER_DESC =
  "让 AI 操作这台电脑上的任何应用（截图、点击、输入）。你不在电脑前时，也可以通过飞书让它帮你操作。";
const LOCKED_DESC =
  "电脑锁屏时，AI 会用你保存的开机密码自动解锁、盖住屏幕完成任务，做完自动重新锁屏。";
const RISK_TEXT =
  "开机密码只保存在本机 Flowship 专用的钥匙串里，不会上传，也不会给 AI 看；升级 Flowship 后一般不用重新输入。关闭这个开关会同时清除它，再次开启需要重新保存。开启后，只要是你的 AI 收到的指令（你自己在 Flowship 或飞书里下的、定时任务触发的）都能让它解锁并使用这台电脑，群里的其他成员不能。建议只在个人电脑上开启。";
/** 总开关从关到开的风险确认（每次都弹） */
const ENABLE_CONFIRM_TEXT =
  "开启后，AI 会截取这台电脑的屏幕画面（画面会发给你所用的模型服务商），并像你一样点击、输入，可以操作任何应用，包括你不在电脑前、通过飞书下指令的时候。建议只在个人电脑上开启，并留意 AI 的操作记录。";
const TEST_CONFIRM_TEXT =
  "点击确认后约 5 秒，电脑会锁屏，随后 Flowship 会自动解锁并回到桌面。期间屏幕会黑一下，请保持电脑在身边。";
/** Windows：开关下的说明 / 风险与限制 / 「测试后台操作」确认 */
const WIN_LOCKED_DESC =
  "电脑锁屏时，AI 可以继续操作你锁屏前已经打开的应用：电脑始终保持锁屏，不需要开机密码。";
const WIN_RISK_TEXT =
  "这种方式下电脑不会解锁，旁人看不到屏幕，但 AI 能看到并操作你已经打开的应用里的内容（比如已登录的聊天窗口）。它只能操作锁屏前已经打开的应用窗口；有些应用锁屏时不绘制界面，截图会是空白的。开启后，只要是你的 AI 收到的指令（你自己在 Flowship 或飞书里下的、定时任务触发的）都能这样使用这台电脑，群里的其他成员不能。建议只在个人电脑上开启。";
const BG_TEST_CONFIRM_TEXT =
  "点击确认后约 5 秒，电脑会锁屏。Flowship 会在锁屏状态下对一个测试窗口截图、打字，验证「锁屏后台模式」能不能用。测完电脑会保持锁屏，请你自己解锁，再回到这里查看结果。期间请不要碰键盘和鼠标。";
/**
 * 写开关没写进去时卡片补的说明（后果 + 让用户再点一次）。**不替 saveFieldValue 承诺「会自动重试」**：
 * 它只在 5xx / 网络错误时才重试，服务端 4xx 拒绝、配置没加载成功都不会——重试与否由它自己弹的那条「保存失败」说清楚（第二轮评审 #10）。
 */
const ENABLED_OFF_FAILED =
  "「电脑操作」还没有关掉：设置没能写入成功。写入成功之前，AI 仍然可以操作这台电脑，请再点一次开关重试";
const LOCKED_OFF_FAILED =
  "「锁屏时也能用」还没有关掉：设置没能写入成功。写入成功之前它仍然有效；开机密码先留着，开关真正关掉后会自动清除（需要停留在这个页面），也可以再点一次开关重试";
const CREDENTIAL_SAVED_SWITCH_FAILED =
  "开机密码已保存，但「锁屏时也能用」没能打开：设置没能写入成功。可以再点一次「保存」，或稍后在设置里手动打开开关";
const CLEAR_SWITCH_FAILED =
  "开机密码已清除，但「锁屏时也能用」的开关没能关掉：设置没能写入成功。没有密码时它不会自动解锁，请再点一次开关把它关掉";

// ---------------------------------------------------------------------------
// 数据 / 桥 mock
// ---------------------------------------------------------------------------
const perms = (accessibility: PermissionState, screen: PermissionState) => ({
  accessibility,
  screen,
});

/** 一份「macOS、权限齐、原生组件就绪、总开关开、没存密码」的基线状态 */
const makeStatus = (over: Partial<ComputerUseStatus> = {}): ComputerUseStatus => ({
  platform: "darwin",
  enabled: true,
  lockedAccessEnabled: false,
  supported: true,
  lockedAccessSupported: true,
  driverReady: true,
  permissions: perms("granted", "granted"),
  locked: false,
  credentialSet: false,
  lockedAccessReady: false,
  session: { active: false, unlockedByUs: false },
  ...over,
});

/** 一份「Windows、后台组件就绪、解锁组件没装（但能装）、没存密码」的基线状态 */
const makeWinStatus = (over: Partial<ComputerUseStatus> = {}): ComputerUseStatus =>
  makeStatus({
    platform: "win32",
    backgroundSupported: true,
    backgroundReady: true,
    unlockSupported: false,
    unlockReady: false,
    unlockHelper: { installed: false, canInstall: true },
    ...over,
  });

const makeBridge = () => ({
  getStatus: vi.fn<ComputerUseBridge["getStatus"]>(async () => makeStatus()),
  requestPermission: vi.fn<ComputerUseBridge["requestPermission"]>(async () => makeStatus()),
  openSettings: vi.fn<ComputerUseBridge["openSettings"]>(async () => undefined),
  setCredential: vi.fn<ComputerUseBridge["setCredential"]>(async () => ({ ok: true })),
  clearCredential: vi.fn<ComputerUseBridge["clearCredential"]>(async () => ({ ok: true })),
  testLockedAccess: vi.fn<ComputerUseBridge["testLockedAccess"]>(async () => ({
    ok: true,
    steps: [],
  })),
  testBackground: vi.fn<ComputerUseBridge["testBackground"]>(async () => ({
    ok: true,
    steps: [],
  })),
  installUnlockHelper: vi.fn<ComputerUseBridge["installUnlockHelper"]>(async () => ({ ok: true })),
  uninstallUnlockHelper: vi.fn<ComputerUseBridge["uninstallUnlockHelper"]>(async () => ({ ok: true })),
  exportDiagnostics: vi.fn<ComputerUseBridge["exportDiagnostics"]>(async () => ({
    path: "/tmp/cu-diag.json",
  })),
});
type MockBridge = ReturnType<typeof makeBridge>;

type ViewProps = Parameters<typeof ComputerUseView>[0];

const viewProps = (over: Partial<ViewProps> = {}): ViewProps => ({
  bridge: makeBridge(),
  status: makeStatus(),
  enabled: true,
  onEnabledChange: vi.fn(),
  lockedAccess: false,
  onLockedAccessChange: vi.fn(),
  onStatus: vi.fn(),
  onRefresh: vi.fn(),
  ...over,
});

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

/** 让已排队的微任务 / 0ms 宏任务都跑完（交互 describe 不开 fake timers） */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// SSR 输出的读取工具
// ---------------------------------------------------------------------------
const html = (over: Partial<ViewProps> = {}): string =>
  renderToStaticMarkup(createElement(ComputerUseView, viewProps(over)));

/** 「名称」所在行之后的第一个开关的开始标签（用来断言 checked / disabled） */
const switchTagAfter = (markup: string, label: string): string => {
  const at = markup.indexOf(`>${label}<`);
  if (at < 0) throw new Error(`找不到「${label}」`);
  const m = /<span [^>]*role="switch"[^>]*>/.exec(markup.slice(at));
  if (!m) throw new Error(`「${label}」之后没有开关`);
  return m[0];
};
const isOn = (tag: string) => tag.includes('aria-checked="true"');
const isDisabled = (tag: string) => tag.includes('aria-disabled="true"');

/** 按钮文字对应的 <button> 开始标签属性串；没有这个按钮 → undefined */
const buttonAttrs = (markup: string, text: string): string | undefined =>
  new RegExp(`<button ([^>]*)>${text}</button>`).exec(markup)?.[1];
const buttonDisabled = (attrs: string | undefined): boolean =>
  attrs?.includes('disabled=""') === true;

const switchCount = (markup: string): number =>
  (markup.match(/role="switch"/g) ?? []).length;

// ---------------------------------------------------------------------------
// 槽位桩下的元素树工具
// ---------------------------------------------------------------------------
type El = ReactElement<Record<string, unknown>>;

/** 把元素树拍平（深度优先）；不只走 children——SettingRow 的 hint / control 里也藏着元素 */
const walk = (node: unknown, out: El[] = []): El[] => {
  if (Array.isArray(node)) {
    for (const c of node) walk(c, out);
  } else if (isValidElement(node)) {
    const el = node as El;
    out.push(el);
    for (const v of Object.values(el.props)) {
      if (Array.isArray(v) || isValidElement(v)) walk(v, out);
    }
  }
  return out;
};

const pick = (els: El[], pred: (el: El) => boolean, what: string): El => {
  const hit = els.filter(pred);
  const [only] = hit;
  if (hit.length !== 1 || !only) {
    throw new Error(`期望恰好一个「${what}」，实际 ${hit.length}`);
  }
  return only;
};

const call = (el: El, prop: string, ...args: unknown[]): unknown => {
  const fn = el.props[prop];
  if (typeof fn !== "function") throw new Error(`元素没有函数 prop「${prop}」`);
  return (fn as (...a: unknown[]) => unknown)(...args);
};

/** 元素树里的纯文本（按钮文案等） */
const textOf = (node: unknown): string => {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node as El).props.children);
  return "";
};

const isButton = (el: El) => el.type === Button;

// ---------------------------------------------------------------------------
// 源码读取（契约断言用）
// ---------------------------------------------------------------------------
const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf-8");

/** 去掉注释后的源码（块注释 / 行注释）：「不碰 settings / 存储」这类断言只该看真正会执行的代码，不该被注释里的说明字样误伤 */
const readCode = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

beforeEach(() => {
  h.confirm.mockReset();
  h.toastError.mockReset();
  h.toastSuccess.mockReset();
  h.toastWarning.mockReset();
});
// 用例里装的 spy（console.* 等）统一在这里还原：写在用例末尾的话，断言先失败就走不到，spy 会泄漏进后面的用例
afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// 1. 门禁纯函数
// ===========================================================================
describe("getLockedAccessBlockReason：「锁屏时也能用」当前不能打开的原因", () => {
  it("总开关没开 → 先提示开总开关（优先级最高，哪怕权限 / 原生组件也有问题）", () => {
    const s = makeStatus({ permissions: perms("denied", "denied"), driverReady: false });
    expect(getLockedAccessBlockReason(s, false)).toBe("需要先开启「电脑操作」");
  });

  it("macOS 缺权限：点名缺哪项，两项都缺用「和」连起来", () => {
    expect(
      getLockedAccessBlockReason(makeStatus({ permissions: perms("denied", "granted") }), true),
    ).toBe("需要先授予「辅助功能」权限");
    expect(
      getLockedAccessBlockReason(makeStatus({ permissions: perms("granted", "denied") }), true),
    ).toBe("需要先授予「屏幕录制」权限");
    expect(
      getLockedAccessBlockReason(makeStatus({ permissions: perms("denied", "denied") }), true),
    ).toBe("需要先授予「辅助功能」和「屏幕录制」权限");
  });

  it("只有 granted 算授予：denied / not-determined / restricted / unknown 都算没授予", () => {
    for (const state of ["denied", "not-determined", "restricted", "unknown"] as const) {
      expect(
        getLockedAccessBlockReason(makeStatus({ permissions: perms("granted", state) }), true),
      ).toBe("需要先授予「屏幕录制」权限");
    }
  });

  it("权限齐但原生组件没就绪 → 用主进程给的 driverError；空白 / 缺省 → 兜底文案", () => {
    expect(
      getLockedAccessBlockReason(
        makeStatus({ driverReady: false, driverError: "原生组件加载失败：缺少 koffi" }),
        true,
      ),
    ).toBe("原生组件加载失败：缺少 koffi");
    expect(
      getLockedAccessBlockReason(makeStatus({ driverReady: false, driverError: "   " }), true),
    ).toBe("原生组件未就绪");
    expect(getLockedAccessBlockReason(makeStatus({ driverReady: false }), true)).toBe(
      "原生组件未就绪",
    );
  });

  it("权限缺失优先于原生组件没就绪（一次只报最靠前的一个）", () => {
    const s = makeStatus({
      permissions: perms("denied", "granted"),
      driverReady: false,
      driverError: "加载失败",
    });
    expect(getLockedAccessBlockReason(s, true)).toBe("需要先授予「辅助功能」权限");
  });

  it("非 macOS 不看权限（Windows 恒 granted，桥给了别的值也不拦）", () => {
    const s = makeStatus({ platform: "win32", permissions: perms("denied", "denied") });
    expect(getLockedAccessBlockReason(s, true)).toBeNull();
  });

  it("全部满足 → null", () => {
    expect(getLockedAccessBlockReason(makeStatus(), true)).toBeNull();
  });
});

describe("statusReadErrorText：读状态失败的原因整理成一句能给用户看的话", () => {
  it("去掉 Electron 给 IPC 错误加的前缀（只去开头一次，不动正文里的同样字样）", () => {
    expect(
      statusReadErrorText(
        new Error("Error invoking remote method 'computer-use:status': Error: No handler registered for 'computer-use:status'"),
      ),
    ).toBe("No handler registered for 'computer-use:status'");
    expect(statusReadErrorText(new Error("Error: 超时"))).toBe("超时");
    expect(statusReadErrorText(new Error("正文里提到 Error: 不该被去掉"))).toBe("正文里提到 Error: 不该被去掉");
  });

  it("多行 / 连续空白折成一个空格；最多 120 字", () => {
    expect(statusReadErrorText(new Error("第一行\n\n  第二行\t尾"))).toBe("第一行 第二行 尾");
    expect(statusReadErrorText(new Error("原因".repeat(100)))).toBe("原因".repeat(60));
  });

  it("不是 Error 的抛出值照字面用；什么信息都没有 → 「主进程没有回应」", () => {
    expect(statusReadErrorText("字符串原因")).toBe("字符串原因");
    for (const nothing of [undefined, null, "", "   ", new Error(""), new Error("Error: ")]) {
      expect(statusReadErrorText(nothing)).toBe("主进程没有回应");
    }
  });

  it("连续失败几次才开口：2（头一下不算）", () => {
    expect(STATUS_ERROR_AFTER_FAILURES).toBe(2);
  });
});

// 第三轮评审：状态快照跨进程而来（应用更新后没重启、开发时只重启了一边……），TS 类型只是编译期的承诺——
// 以前 getStatus 的返回值原样采纳，缺了 permissions / session 之类卡片无保护解引用的字段就是渲染时抛 TypeError、整张卡白屏
describe("isComputerUseStatus：状态快照的运行时校验（只查卡片会无保护解引用的字段）", () => {
  it("真实的快照都通过：基线（macOS / Windows）、带可选字段、主进程「不支持 / 装配失败」两种兜底快照", () => {
    expect(isComputerUseStatus(makeStatus())).toBe(true);
    expect(isComputerUseStatus(makeWinStatus())).toBe(true);
    expect(
      isComputerUseStatus(
        makeStatus({
          locked: null,
          lockedAccessNote: "x",
          driverError: "y",
          permissions: perms("denied", "unknown"),
          session: { active: true, unlockedByUs: true },
        }),
      ),
    ).toBe(true);
    // 主进程里真正产出这两份兜底快照的函数（不是手写的复制品）：它们一旦缺字段，界面会把它们当格式不对丢掉、永远「读不到状态」
    expect(isComputerUseStatus(unsupportedStatus())).toBe(true);
    for (const platform of ["darwin", "win32", "other", "linux"]) {
      expect(isComputerUseStatus(initFailedStatus(platform, "磁盘只读")), platform).toBe(true);
    }
  });

  it("向前兼容：多出来的字段、没见过的权限 / 会话取值都不拦（新版本主进程配旧界面不该整个读不了状态）", () => {
    expect(
      isComputerUseStatus({
        ...makeStatus(),
        someFutureField: { a: 1 },
        permissions: { accessibility: "restricted-by-mdm", screen: "granted", camera: "granted" },
        session: { active: false, unlockedByUs: false, mode: "teleport" },
      }),
    ).toBe(true);
  });

  it("不是对象：null / undefined / 数字 / 字符串 / 数组 / 函数 → 否", () => {
    for (const bad of [null, undefined, 0, 1, "", "status", true, [], [makeStatus()], () => makeStatus()]) {
      expect(isComputerUseStatus(bad), String(bad)).toBe(false);
    }
  });

  it("平台只认 darwin / win32 / other（缺 / 别的值 / 类型不对 → 否）", () => {
    for (const platform of [undefined, null, "linux", "", "Darwin", 1, {}]) {
      expect(isComputerUseStatus({ ...makeStatus(), platform }), String(platform)).toBe(false);
    }
    const noPlatform: Record<string, unknown> = { ...makeStatus() };
    delete noPlatform.platform;
    expect(isComputerUseStatus(noPlatform)).toBe(false);
  });

  it("7 个布尔字段：缺了、或者不是布尔（0 / 1 / 'true' / null）都 → 否，一个一个查（不能只查了几个）", () => {
    const keys = [
      "enabled",
      "lockedAccessEnabled",
      "supported",
      "lockedAccessSupported",
      "driverReady",
      "credentialSet",
      "lockedAccessReady",
    ] as const;
    for (const key of keys) {
      const missing: Record<string, unknown> = { ...makeStatus() };
      delete missing[key];
      expect(isComputerUseStatus(missing), `缺 ${key}`).toBe(false);
      for (const bad of [0, 1, "true", null, undefined, {}]) {
        expect(isComputerUseStatus({ ...makeStatus(), [key]: bad }), `${key}=${String(bad)}`).toBe(false);
      }
    }
  });

  it("permissions：缺 / null / 数组 / 只缺一项 / 值不是字符串 → 否", () => {
    const base = makeStatus();
    const without = (k: string) => {
      const o: Record<string, unknown> = { ...base };
      delete o[k];
      return o;
    };
    expect(isComputerUseStatus(without("permissions"))).toBe(false);
    for (const bad of [null, "granted", 1, [], ["granted", "granted"]]) {
      expect(isComputerUseStatus({ ...base, permissions: bad }), String(bad)).toBe(false);
    }
    expect(isComputerUseStatus({ ...base, permissions: { accessibility: "granted" } })).toBe(false);
    expect(isComputerUseStatus({ ...base, permissions: { screen: "granted" } })).toBe(false);
    expect(isComputerUseStatus({ ...base, permissions: { accessibility: true, screen: "granted" } })).toBe(false);
    expect(isComputerUseStatus({ ...base, permissions: { accessibility: "granted", screen: null } })).toBe(false);
  });

  it("session：缺 / null / 数组 / active 或 unlockedByUs 缺了或不是布尔 → 否", () => {
    const base = makeStatus();
    const without = (k: string) => {
      const o: Record<string, unknown> = { ...base };
      delete o[k];
      return o;
    };
    expect(isComputerUseStatus(without("session"))).toBe(false);
    for (const bad of [null, true, 1, "active", [], [true, false]]) {
      expect(isComputerUseStatus({ ...base, session: bad }), String(bad)).toBe(false);
    }
    expect(isComputerUseStatus({ ...base, session: { active: false } })).toBe(false);
    expect(isComputerUseStatus({ ...base, session: { unlockedByUs: false } })).toBe(false);
    expect(isComputerUseStatus({ ...base, session: { active: 1, unlockedByUs: false } })).toBe(false);
    expect(isComputerUseStatus({ ...base, session: { active: false, unlockedByUs: "no" } })).toBe(false);
  });
});

// 第三轮评审：操作失败的原因原样（`err.message`）拼进 toast——Electron 的 IPC 报错带着 `Error invoking remote method '…': Error: ` 前缀，
// 驱动 / 主进程抛的原因可能是多行长文。errText 没导出，经真实的出口（清除失败 / 导出失败 / 打开授权失败的 toast）观察
describe("操作失败的原因整理后再进 toast（errText）", () => {
  const IPC = (channel: string, msg: string) => new Error(`Error invoking remote method '${channel}': Error: ${msg}`);

  it("清除开机密码失败：toast 里没有 IPC 前缀、多行折成一行、限 120 字", async () => {
    const bridge = makeBridge();
    bridge.clearCredential.mockRejectedValueOnce(IPC("computer-use:clear-credential", "钥匙串被锁定\n请先解锁"));
    await disableLockedAccessFlow({ bridge, switchIsOn: false, hasCredential: true, writeLockedAccess: vi.fn(), refresh: vi.fn() });
    expect(h.toastError).toHaveBeenCalledExactlyOnceWith(
      "已关闭「锁屏时也能用」，但开机密码没能清除：钥匙串被锁定 请先解锁。可以稍后点「清除」再试",
    );

    h.toastError.mockReset();
    bridge.clearCredential.mockRejectedValueOnce(new Error("很长的原因".repeat(60)));
    await disableLockedAccessFlow({ bridge, switchIsOn: false, hasCredential: true, writeLockedAccess: vi.fn(), refresh: vi.fn() });
    const shown = String(h.toastError.mock.calls[0]?.[0]);
    expect(shown).toContain("很长的原因".repeat(24));
    expect(shown).not.toContain("很长的原因".repeat(25));
  });

  it("保存开机密码抛错：先抹密码再截断（密码落在 120 字边界附近也不会被截成认不出的半截），IPC 前缀同样去掉", async () => {
    const bridge = makeBridge();
    // 密码正好跨在第 120 字的边界上：先截断的话，被切成半截的密码就认不出来了
    const pw = "Zq9$kLm2#Xv8";
    bridge.setCredential.mockRejectedValueOnce(IPC("computer-use:set-credential", `${"填充".repeat(54)}入参 ${pw} 不合法`));
    const ok = await saveCredentialFlow({ bridge, password: pw, enableAfterSave: false, writeLockedAccess: vi.fn(), refresh: vi.fn() });
    expect(ok).toBe(false);
    const shown = String(h.toastError.mock.calls[0]?.[0]);
    expect(shown.startsWith("保存失败：")).toBe(true);
    expect(shown).not.toContain("invoking");
    // 密码的任何连续 5 个字符都不剩（含被截断后的残片）
    for (let i = 0; i + 5 <= pw.length; i += 1) expect(shown, pw.slice(i, i + 5)).not.toContain(pw.slice(i, i + 5));
  });
});

// 第三轮评审：脱敏只做精确子串匹配，密码含 `"` 或 `\` 时 JSON 转义版会漏。主进程（electron-app/desktop/redact-secret.mjs）已补，
// 渲染进程这一层（toast 展示前）同一份约定——两边各写一份（渲染进程不能 import 那个 .mjs），这里对拍
describe("scrubSecret / secretForms：与主进程的脱敏约定一致", () => {
  const PASSWORDS = ["hunter2", 'p"a\\ss', "it's\"a\\b", "p@ss word&x=1/#", "密码\t换行\n结束", "a\\", "\\", 'x"\ud800y', "'", "%"];

  it("secretForms 与主进程逐字一致（同样的写法、同样的顺序）", () => {
    for (const pw of PASSWORDS) expect(secretForms(pw), JSON.stringify(pw)).toEqual(mainSecretForms(pw));
  });

  it("每种写法出现在文字里都抹成 •••；原样的不在也抹（JSON 序列化后回显的场景）", () => {
    const pw = 'p"a\\ss';
    const echoed = `无法解析请求 ${JSON.stringify({ password: pw })}`;
    expect(echoed).not.toContain(pw);
    expect(scrubSecret(echoed, pw)).toBe('无法解析请求 {"password":"•••"}');
    expect(scrubSecret(`url ?pw=${encodeURIComponent(pw)}`, pw)).toBe("url ?pw=•••");
    expect(scrubSecret(`bad '${pw.replace(/[\\'"]/g, "\\$&")}'`, pw)).toBe("bad '•••'");
  });

  it("长的先抹：JSON 写法含着原样（密码以反斜杠结尾）也不留半截；空密码原样返回；畸形 UTF-16 不抛", () => {
    expect(scrubSecret(String.raw`{"pw":"a\\"}`, "a\\")).toBe('{"pw":"•••"}');
    expect(scrubSecret("原样文字", "")).toBe("原样文字");
    expect(() => scrubSecret("bad x\ud800y", "x\ud800y")).not.toThrow();
  });
});

// 第三轮评审：「关锁屏开关」没写进去、密码先留着 → 设置页自动重试成功后没人清密码。什么时候补清，是个纯判断
describe("deferredClearVerdict：关开关没写进去、密码先留着之后，什么时候补清密码", () => {
  it("主进程确认开关已关 + 设置草稿也是关 + 钥匙串里还有密码 → clear", () => {
    expect(deferredClearVerdict({ draftLocked: false, actualLocked: false, credentialSet: true })).toBe("clear");
  });

  it("主进程里还开着 / 读不到（自动重试还没成功、或还没推到主进程）→ wait（草稿是乐观更新，写盘失败时它早就是关了，不能据此清）", () => {
    expect(deferredClearVerdict({ draftLocked: false, actualLocked: true, credentialSet: true })).toBe("wait");
    expect(deferredClearVerdict({ draftLocked: false, actualLocked: undefined, credentialSet: true })).toBe("wait");
  });

  it("用户又把开关打开了（草稿重新是开）→ drop：不能在他刚开启之后把密码清了；钥匙串里已经没有密码 → drop", () => {
    expect(deferredClearVerdict({ draftLocked: true, actualLocked: false, credentialSet: true })).toBe("drop");
    expect(deferredClearVerdict({ draftLocked: true, actualLocked: true, credentialSet: true })).toBe("drop");
    expect(deferredClearVerdict({ draftLocked: false, actualLocked: false, credentialSet: false })).toBe("drop");
    expect(deferredClearVerdict({ draftLocked: false, actualLocked: true, credentialSet: false })).toBe("drop");
  });
});

// ===========================================================================
// 2. 渲染（SSR）：无桥冒烟 / 各状态
// ===========================================================================
describe("渲染 · 无桥环境（网页版 / pnpm dev:web）", () => {
  it("冒烟：ComputerUseSection 渲染出「仅桌面端可用」，总开关禁用", () => {
    const markup = renderToStaticMarkup(
      createElement(ComputerUseSection, {
        enabled: false,
        onEnabledChange: vi.fn(),
        lockedAccess: false,
        onLockedAccessChange: vi.fn(),
      }),
    );
    expect(markup).toContain("仅桌面端可用");
    expect(markup).toContain("电脑操作");
    expect(markup).toContain(MASTER_DESC);
    expect(isDisabled(switchTagAfter(markup, "电脑操作"))).toBe(true);
  });

  it("整块禁用：锁屏开关也禁用；没有权限行 / 开机密码行 / 测试按钮；导出诊断禁用", () => {
    const markup = html({ bridge: null, status: null });
    expect(isDisabled(switchTagAfter(markup, "锁屏时也能用"))).toBe(true);
    expect(markup).toContain(LOCKED_DESC);
    expect(markup).toContain(RISK_TEXT);
    for (const absent of ["辅助功能", "屏幕录制", "开机密码：", "测试锁屏可用"]) {
      expect(markup).not.toContain(absent);
    }
    expect(buttonDisabled(buttonAttrs(markup, "导出诊断信息"))).toBe(true);
  });

  it("开关位置照常显示设置里已存的值（不因无桥而丢）", () => {
    const markup = html({ bridge: null, status: null, enabled: true, lockedAccess: true });
    expect(isOn(switchTagAfter(markup, "电脑操作"))).toBe(true);
    expect(isOn(switchTagAfter(markup, "锁屏时也能用"))).toBe(true);
  });
});

describe("渲染 · 有桥", () => {
  it("有桥时不再提示「仅桌面端可用」；状态还没取回时总开关可用、锁屏开关禁用、没有状态相关区块", () => {
    const markup = html({ status: null });
    expect(markup).not.toContain("仅桌面端可用");
    expect(isDisabled(switchTagAfter(markup, "电脑操作"))).toBe(false);
    expect(isDisabled(switchTagAfter(markup, "锁屏时也能用"))).toBe(true);
    for (const absent of ["辅助功能", "开机密码：", "测试锁屏可用"]) {
      expect(markup).not.toContain(absent);
    }
    // 导出诊断只要有桥就能点（不依赖状态）
    expect(buttonDisabled(buttonAttrs(markup, "导出诊断信息"))).toBe(false);
  });

  it("固定文案：总开关说明 / 锁屏说明 / 风险提示原文", () => {
    const markup = html();
    expect(markup).toContain(MASTER_DESC);
    expect(markup).toContain(LOCKED_DESC);
    expect(markup).toContain(RISK_TEXT);
  });
});

describe("渲染 · 权限区（仅 darwin，状态始终展示）", () => {
  it("两项都已授权：两行都「已授权」，没有「去授权」", () => {
    const markup = html();
    expect(markup).toContain("辅助功能");
    expect(markup).toContain("屏幕录制");
    expect(markup.match(/已授权/g)).toHaveLength(2);
    expect(markup).not.toContain("未授权");
    expect(markup).not.toContain("去授权");
  });

  it("缺屏幕录制：该行「未授权」+「去授权」，辅助功能行仍「已授权」；辅助功能在前、屏幕录制在后", () => {
    const markup = html({ status: makeStatus({ permissions: perms("granted", "denied") }) });
    expect(markup.match(/已授权/g)).toHaveLength(1);
    expect(markup.match(/未授权/g)).toHaveLength(1);
    expect(markup.match(/去授权/g)).toHaveLength(1);
    expect(markup.indexOf("辅助功能")).toBeLessThan(markup.indexOf("屏幕录制"));
    // 授权行在总开关之后、锁屏区块之前
    expect(markup.indexOf("辅助功能")).toBeGreaterThan(markup.indexOf(MASTER_DESC));
    expect(markup.indexOf("屏幕录制")).toBeLessThan(markup.indexOf("锁屏时也能用"));
  });

  it("总开关没开也展示权限状态（先去授权再开）", () => {
    const markup = html({
      enabled: false,
      status: makeStatus({ enabled: false, permissions: perms("denied", "denied") }),
    });
    expect(markup.match(/未授权/g)).toHaveLength(2);
    expect(markup.match(/去授权/g)).toHaveLength(2);
  });

  it("not-determined / restricted / unknown 都按「未授权」展示", () => {
    for (const state of ["not-determined", "restricted", "unknown"] as const) {
      const markup = html({ status: makeStatus({ permissions: perms(state, state) }) });
      expect(markup.match(/未授权/g)).toHaveLength(2);
    }
  });

  it("非 darwin 不出权限区", () => {
    for (const platform of ["win32", "other"] as const) {
      const markup = html({ status: makeStatus({ platform }) });
      expect(markup).not.toContain("辅助功能");
      expect(markup).not.toContain("屏幕录制");
      expect(markup).not.toContain("去授权");
    }
  });
});

describe("渲染 · 「锁屏时也能用」", () => {
  it("门禁只拦「打开」：总开关没开 → 关着的锁屏开关禁用 + 原因；开着的仍可关（原因照给）", () => {
    const off = html({ enabled: false, lockedAccess: false, status: makeStatus({ enabled: false }) });
    expect(isDisabled(switchTagAfter(off, "锁屏时也能用"))).toBe(true);
    expect(off).toContain("需要先开启「电脑操作」");

    // 主进程里锁屏开关还开着（lockedAccessEnabled）：开关显示开，仍可关
    const on = html({
      enabled: false,
      lockedAccess: true,
      status: makeStatus({ enabled: false, lockedAccessEnabled: true }),
    });
    expect(isOn(switchTagAfter(on, "锁屏时也能用"))).toBe(true);
    expect(isDisabled(switchTagAfter(on, "锁屏时也能用"))).toBe(false);
    expect(on).toContain("需要先开启「电脑操作」");
  });

  it("macOS 权限不齐 → 关着的锁屏开关禁用 + 点名缺哪项", () => {
    const markup = html({
      status: makeStatus({ permissions: perms("granted", "denied") }),
    });
    expect(isDisabled(switchTagAfter(markup, "锁屏时也能用"))).toBe(true);
    expect(markup).toContain("需要先授予「屏幕录制」权限");
  });

  it("原生组件没就绪 → 锁屏开关禁用 + 显示主进程给的原因", () => {
    const markup = html({
      status: makeStatus({ driverReady: false, driverError: "原生组件加载失败：缺少 koffi" }),
    });
    expect(isDisabled(switchTagAfter(markup, "锁屏时也能用"))).toBe(true);
    expect(markup).toContain("原生组件加载失败：缺少 koffi");
  });

  it("条件都满足：锁屏开关可点，没有任何原因提示", () => {
    const markup = html();
    expect(isDisabled(switchTagAfter(markup, "锁屏时也能用"))).toBe(false);
    expect(markup).not.toContain("需要先");
  });

  it("本平台没实现锁屏解锁（如 Windows）：整块只给主进程的说明，没有锁屏开关 / 风险文案 / 密码行 / 测试按钮；总开关照常可用", () => {
    const markup = html({
      status: makeStatus({
        platform: "win32",
        lockedAccessSupported: false,
        lockedAccessNote: "Windows 暂不支持锁屏时使用电脑操作",
      }),
    });
    expect(markup).toContain("锁屏时也能用");
    expect(markup).toContain("Windows 暂不支持锁屏时使用电脑操作");
    expect(switchCount(markup)).toBe(1); // 只剩总开关
    expect(isDisabled(switchTagAfter(markup, "电脑操作"))).toBe(false);
    for (const absent of [LOCKED_DESC, RISK_TEXT, "开机密码：", "测试锁屏可用"]) {
      expect(markup).not.toContain(absent);
    }
  });

  it("没实现锁屏解锁且主进程没给说明 → 兜底「当前系统暂不支持」", () => {
    const markup = html({ status: makeStatus({ platform: "win32", lockedAccessSupported: false }) });
    expect(markup).toContain("当前系统暂不支持");
    expect(switchCount(markup)).toBe(1);
  });

  it("整个平台都没有桌面驱动（如 Linux）：总开关禁用并说明，锁屏区块不出现、也没有权限行", () => {
    const markup = html({
      enabled: false,
      status: makeStatus({ platform: "other", supported: false, lockedAccessSupported: false, enabled: false }),
    });
    expect(markup).toContain("当前系统暂不支持电脑操作");
    expect(isDisabled(switchTagAfter(markup, "电脑操作"))).toBe(true);
    expect(switchCount(markup)).toBe(1);
    for (const absent of ["锁屏时也能用", LOCKED_DESC, RISK_TEXT, "开机密码：", "测试锁屏可用", "辅助功能", "屏幕录制"]) {
      expect(markup).not.toContain(absent);
    }
  });

  describe("主进程装配失败（supported:false 且带 driverError）：整张卡不可用，说明里是具体原因", () => {
    const REASON = "电脑操作没能初始化（磁盘只读）。请重启 Flowship 再试；还不行就把应用日志发给开发者排查";
    const failed = (over: Partial<ComputerUseStatus> = {}) =>
      makeStatus({
        platform: "darwin",
        supported: false,
        lockedAccessSupported: false,
        driverReady: false,
        driverError: REASON,
        lockedAccessNote: REASON,
        enabled: false,
        // 和主进程 initFailedStatus 一致：权限读数是占位的「未知」（这时若还显示权限行，就是一排「未授权 / 去授权」，点了也只会撞上同一个错误）
        permissions: perms("unknown", "unknown"),
        ...over,
      });

    it("总开关禁用，说明是主进程给的原因——系统其实支持，不能说「暂不支持」；锁屏区块 / 权限行不出现", () => {
      const markup = html({ status: failed(), enabled: false });
      expect(markup).toContain(REASON);
      expect(markup).not.toContain("暂不支持");
      expect(isDisabled(switchTagAfter(markup, "电脑操作"))).toBe(true);
      expect(switchCount(markup)).toBe(1);
      // 原因只出现一次（锁屏区块被整个收起，不会再重复一遍）
      expect(markup.split(REASON)).toHaveLength(2);
      for (const absent of ["锁屏时也能用", LOCKED_DESC, RISK_TEXT, "开机密码：", "测试锁屏可用", "辅助功能", "屏幕录制"]) {
        expect(markup).not.toContain(absent);
      }
    });

    it("Windows 同样；原因只有空白 / 为空 → 兜底成「当前系统暂不支持电脑操作」", () => {
      expect(html({ status: failed({ platform: "win32" }), enabled: false })).toContain(REASON);
      for (const blank of ["", "   "]) {
        const markup = html({ status: failed({ platform: "other", driverError: blank }), enabled: false });
        expect(markup).toContain("当前系统暂不支持电脑操作");
        expect(markup).not.toContain(REASON);
      }
    });

    it("支持电脑操作的平台上 driverError 只是「原生组件没就绪」的原因，不会冒到总开关的说明里（只有 supported:false 才整卡替换）", () => {
      const markup = html({
        status: makeStatus({ driverReady: false, driverError: "原生组件加载失败：缺少 koffi" }),
        enabled: true,
      });
      expect(isDisabled(switchTagAfter(markup, "电脑操作"))).toBe(false);
      // 原因只在锁屏区块那一处出现（和以前一样），总开关的说明里没有
      expect(markup.split("原生组件加载失败：缺少 koffi")).toHaveLength(2);
    });
  });

  describe("一直读不到主进程状态（statusError）：明说，别让用户对着一张能点却不工作的卡片猜", () => {
    // 不带引号：SSR 输出会把 ' 转义成 &#x27;，和这里要钉的事无关
    const WHY = "No handler registered for computer-use:status";

    it("有桥、从没拿到过状态、hook 给了原因 → 总开关说明里显示（警示色），开关本身不动", () => {
      const markup = html({ status: null, statusError: WHY });
      expect(markup).toContain(`暂时读不到电脑操作的状态（${WHY}），会自动重试`);
      expect(markup).toContain("一直这样的话请重启 Flowship");
      expect(markup).toContain("text-warning");
      expect(isDisabled(switchTagAfter(markup, "电脑操作"))).toBe(false);
    });

    it("该沉默的时候沉默：没原因 / 原因为空 / 已经有快照 / 没有桥（网页版）都不显示", () => {
      for (const over of [
        { status: null, statusError: null },
        { status: null, statusError: "" },
        { status: null },
        { status: makeStatus(), statusError: WHY },
        { status: null, statusError: WHY, bridge: null },
      ] as Array<Partial<ViewProps>>) {
        expect(html(over), JSON.stringify(Object.keys(over))).not.toContain("暂时读不到");
      }
      // 没有桥时仍是原来的「仅桌面端可用」
      expect(html({ status: null, statusError: WHY, bridge: null })).toContain("仅桌面端可用");
    });
  });

  it("开机密码行：未保存 → 只有「保存」；已保存 → 「修改」+「清除」", () => {
    const unset = html({ status: makeStatus({ credentialSet: false }) });
    expect(unset).toContain("开机密码：未保存");
    expect(buttonAttrs(unset, "保存")).toBeDefined();
    expect(buttonAttrs(unset, "修改")).toBeUndefined();
    expect(buttonAttrs(unset, "清除")).toBeUndefined();

    const saved = html({ status: makeStatus({ credentialSet: true }) });
    expect(saved).toContain("开机密码：已保存");
    expect(buttonAttrs(saved, "修改")).toBeDefined();
    expect(buttonAttrs(saved, "清除")).toBeDefined();
    expect(buttonAttrs(saved, "保存")).toBeUndefined();
  });

  it("「测试锁屏可用」：仅「已存密码 + 开关开 + 无门禁原因」时可点，其余一律禁用", () => {
    // 稳态：设置里开着（lockedAccess）、主进程里也开着（lockedAccessEnabled）
    const ok = makeStatus({ credentialSet: true, lockedAccessEnabled: true });
    const enabledMarkup = html({ status: ok, lockedAccess: true });
    expect(buttonDisabled(buttonAttrs(enabledMarkup, "测试锁屏可用"))).toBe(false);

    const cases: Array<[string, Partial<ViewProps>]> = [
      ["没存密码", { status: makeStatus({ credentialSet: false, lockedAccessEnabled: true }), lockedAccess: true }],
      ["锁屏开关没开", { status: makeStatus({ credentialSet: true }), lockedAccess: false }],
      ["总开关没开", { status: { ...ok, enabled: false }, lockedAccess: true, enabled: false }],
      [
        "macOS 权限不齐",
        {
          status: makeStatus({ credentialSet: true, lockedAccessEnabled: true, permissions: perms("denied", "granted") }),
          lockedAccess: true,
        },
      ],
      [
        "原生组件没就绪",
        { status: makeStatus({ credentialSet: true, lockedAccessEnabled: true, driverReady: false }), lockedAccess: true },
      ],
    ];
    for (const [name, over] of cases) {
      const attrs = buttonAttrs(html(over), "测试锁屏可用");
      expect(attrs, `${name}：应该仍显示按钮`).toBeDefined();
      expect(buttonDisabled(attrs), `${name}：应该禁用`).toBe(true);
    }
  });

  it("底部有弱化的「导出诊断信息」按钮", () => {
    expect(buttonAttrs(html(), "导出诊断信息")).toContain("text-muted-foreground");
  });
});

describe("渲染 · Windows「锁屏时也能用」（锁屏后台模式 + 可选的解锁组件）", () => {
  const helperInstalled = { installed: true, canInstall: false } as const;

  it("Windows 专属文案：没有 macOS 的钥匙串 / 开机密码说明，也没有权限行", () => {
    const markup = html({ status: makeWinStatus() });
    expect(markup).toContain("锁屏时也能用");
    expect(markup).toContain(WIN_LOCKED_DESC);
    expect(markup).toContain(WIN_RISK_TEXT);
    for (const absent of [LOCKED_DESC, RISK_TEXT, "钥匙串", "辅助功能", "屏幕录制", "去授权"]) {
      expect(markup, `不该出现：${absent}`).not.toContain(absent);
    }
  });

  it("开启开关不要求先存开机密码：没存密码时开关照样可点，也没有任何「需要先」提示", () => {
    const markup = html({ status: makeWinStatus({ credentialSet: false }) });
    expect(isDisabled(switchTagAfter(markup, "锁屏时也能用"))).toBe(false);
    expect(markup).not.toContain("需要先");
  });

  it("门禁照旧只拦「打开」：总开关没开 → 关着的开关禁用 + 原因；开着的仍可关", () => {
    const off = html({ enabled: false, lockedAccess: false, status: makeWinStatus({ enabled: false }) });
    expect(isDisabled(switchTagAfter(off, "锁屏时也能用"))).toBe(true);
    expect(off).toContain("需要先开启「电脑操作」");
    const on = html({
      enabled: false,
      lockedAccess: true,
      status: makeWinStatus({ enabled: false, lockedAccessEnabled: true }),
    });
    expect(isOn(switchTagAfter(on, "锁屏时也能用"))).toBe(true);
    expect(isDisabled(switchTagAfter(on, "锁屏时也能用"))).toBe(false);
  });

  it("原生组件没就绪 → 开关禁用 + 主进程给的原因", () => {
    const markup = html({
      status: makeWinStatus({ driverReady: false, driverError: "原生组件加载失败：缺少 koffi" }),
    });
    expect(isDisabled(switchTagAfter(markup, "锁屏时也能用"))).toBe(true);
    expect(markup).toContain("原生组件加载失败：缺少 koffi");
  });

  it("后台组件没就绪：如实说原因，但开关不因此禁用（解锁组件那条路线可能是好的）；没给原因 → 兜底", () => {
    const markup = html({
      status: makeWinStatus({ backgroundReady: false, backgroundError: "缺少 user32 函数" }),
    });
    expect(markup).toContain("锁屏后台模式暂时用不了：缺少 user32 函数");
    expect(isDisabled(switchTagAfter(markup, "锁屏时也能用"))).toBe(false);
    expect(html({ status: makeWinStatus({ backgroundReady: false }) })).toContain(
      "锁屏后台模式暂时用不了：后台组件没有就绪",
    );
    // 后台组件好好的 → 没有这句
    expect(html({ status: makeWinStatus() })).not.toContain("暂时用不了");
  });

  it("门禁原因优先于后台问题（一次只报最靠前的一个）", () => {
    const markup = html({
      enabled: false,
      status: makeWinStatus({ enabled: false, backgroundReady: false, backgroundError: "缺少 user32" }),
    });
    expect(markup).toContain("需要先开启「电脑操作」");
    expect(markup).not.toContain("锁屏后台模式暂时用不了");
  });

  it("「测试后台操作」：仅「开关开 + 无门禁原因 + 后台组件就绪」时可点，不看开机密码，其余一律禁用", () => {
    // 稳态：设置里开着（lockedAccess）、主进程里也开着（lockedAccessEnabled）
    const on = { lockedAccessEnabled: true } as const;
    const enabledMarkup = html({ status: makeWinStatus({ credentialSet: false, ...on }), lockedAccess: true });
    expect(buttonDisabled(buttonAttrs(enabledMarkup, "测试后台操作"))).toBe(false);

    const cases: Array<[string, Partial<ViewProps>]> = [
      ["锁屏开关没开", { status: makeWinStatus(), lockedAccess: false }],
      ["总开关没开", { status: makeWinStatus({ ...on, enabled: false }), lockedAccess: true, enabled: false }],
      ["原生组件没就绪", { status: makeWinStatus({ ...on, driverReady: false }), lockedAccess: true }],
      [
        "后台组件没就绪",
        { status: makeWinStatus({ ...on, backgroundReady: false, backgroundError: "x" }), lockedAccess: true },
      ],
      ["主进程没说后台组件就绪", { status: makeWinStatus({ ...on, backgroundReady: undefined }), lockedAccess: true }],
    ];
    for (const [name, over] of cases) {
      const attrs = buttonAttrs(html(over), "测试后台操作");
      expect(attrs, `${name}：应该仍显示按钮`).toBeDefined();
      expect(buttonDisabled(attrs), `${name}：应该禁用`).toBe(true);
    }
  });

  it("主进程没给解锁组件信息（缺省 / null）：不出解锁组件行、密码行、自动解锁测试", () => {
    for (const unlockHelper of [undefined, null]) {
      const markup = html({ status: makeWinStatus({ unlockHelper }), lockedAccess: true });
      // 「开机密码：」是密码行的名字（开关说明里「不需要开机密码」那句是另一回事）
      for (const absent of ["解锁组件", "开机密码：", "测试自动解锁"]) {
        expect(markup, `unlockHelper=${String(unlockHelper)}：不该出现 ${absent}`).not.toContain(absent);
      }
      // 后台那条路线照常
      expect(buttonAttrs(markup, "测试后台操作")).toBeDefined();
    }
  });

  it("解锁组件没装：「未安装」+「安装」；没有密码行和自动解锁测试（密码存在组件里，没有组件就没有这回事）", () => {
    const markup = html({ status: makeWinStatus(), lockedAccess: true });
    expect(markup).toContain("解锁组件（可选）");
    expect(markup).toContain("未安装");
    expect(buttonDisabled(buttonAttrs(markup, "安装"))).toBe(false);
    expect(buttonAttrs(markup, "卸载")).toBeUndefined();
    for (const absent of ["开机密码：", "测试自动解锁"]) {
      expect(markup).not.toContain(absent);
    }
  });

  it("密码行下面「关开关会同时清掉这份开机密码」的提示：只在装了解锁组件且保存过密码时出现（第五轮评审：Windows 关开关同样会清，以前没交代）", () => {
    const NOTE = "会同时清除这里保存的开机密码";
    // 「开关开着」= 主进程里真的开着：卡片显示的开关取主进程的真实状态、不是草稿（见「开关显示取主进程真实状态」那组用例），
    // 所以只传草稿 lockedAccess: true 而 lockedAccessEnabled 还是 false，卡片眼里开关仍是关的
    const on = { lockedAccessEnabled: true } as const;
    // 装了 + 存过密码：有这句，而且排在密码行之后
    const withCred = html({ status: makeWinStatus({ unlockHelper: helperInstalled, credentialSet: true, ...on }), lockedAccess: true });
    expect(withCred).toContain(`关闭上面的「锁屏时也能用」${NOTE}`);
    expect(withCred.indexOf(NOTE)).toBeGreaterThan(withCred.indexOf("开机密码："));
    // 装了、没存过密码：没有密码可清，不说
    const noCred = html({ status: makeWinStatus({ unlockHelper: helperInstalled, credentialSet: false, ...on }), lockedAccess: true });
    expect(noCred).not.toContain(NOTE);
    // 没给组件信息：看不到任何解锁组件相关的字样，这句也不例外（即使 credentialSet 为真）
    for (const unlockHelper of [undefined, null]) {
      expect(html({ status: makeWinStatus({ unlockHelper, credentialSet: true, ...on }), lockedAccess: true }), String(unlockHelper)).not.toContain(NOTE);
    }
    // installed:false 而组件里存着密码 = 装着旧版组件（第六轮评审 P2-1）：出的是另一句（见下面「版本对不上」那条用例），不是这句
    const notInstalled = html({ status: makeWinStatus({ unlockHelper: { installed: false, canInstall: true }, credentialSet: true, ...on }), lockedAccess: true });
    expect(notInstalled).not.toContain(NOTE);
    // 开关已经关着、密码还留在组件里（关开关时没清掉 / 旧数据）：再说「关闭开关会清除」没意义——换成说明现状 + 指向「清除」（第六轮评审 P3）
    const switchOff = html({ status: makeWinStatus({ unlockHelper: helperInstalled, credentialSet: true }), lockedAccess: false });
    expect(switchOff).not.toContain(NOTE);
    expect(switchOff).toContain("「锁屏时也能用」现在是关着的，但解锁组件里还留着一份开机密码；不需要的话点上面的「清除」删掉");
    expect(switchOff, "密码行还在").toContain("开机密码：已保存");
    expect(buttonAttrs(switchOff, "清除"), "开关关着也要能清掉这份密码").toBeDefined();
    // 对照：开关开着时仍是原来那句、不出「现在是关着的」
    expect(withCred).not.toContain("现在是关着的");
    // 文案跟的是卡片显示的开关（主进程的真实状态），不是设置草稿：草稿开着、主进程里其实是关的 → 按「关着」说（否则会对着一个显示为关的开关说「关闭它会清除」）
    const draftOnActualOff = html({ status: makeWinStatus({ unlockHelper: helperInstalled, credentialSet: true, lockedAccessEnabled: false }), lockedAccess: true });
    expect(draftOnActualOff).toContain("现在是关着的");
    expect(draftOnActualOff).not.toContain(NOTE);
    // 没存密码时两句都不出
    const switchOffNoCred = html({ status: makeWinStatus({ unlockHelper: helperInstalled, credentialSet: false }), lockedAccess: false });
    expect(switchOffNoCred).not.toContain(NOTE);
    expect(switchOffNoCred).not.toContain("还留着一份开机密码");
  });

  // 第六轮评审 P2-1：装着旧版解锁组件、设置页提示「点安装升级」时，组件里存着的开机密码以前既看不到也清不掉
  // （整个密码行挂在 helper.installed 上，主进程的 credentialSet 也恒为 false）。现在 credentialSet 如实回答「存着没」，卡片给一行只带「清除」的密码行
  it("解锁组件装着但版本对不上（installed:false）且组件里存着密码：出「开机密码：已保存」+「清除」，不给保存 / 修改 / 自动解锁测试；升级提示照常", () => {
    const stale = { installed: false, canInstall: true, detail: "已装的解锁组件是 v3，和这版 Flowship 要的 v4 不一致。点「安装」升级一次" } as const;
    // 开关开着 = 主进程里真的开着（卡片显示取主进程的真实状态、不是草稿）
    const on = { lockedAccessEnabled: true } as const;
    const markup = html({ status: makeWinStatus({ unlockHelper: stale, credentialSet: true, ...on }), lockedAccess: true });
    // 升级提示照常：「安装」就是升级
    expect(markup).toContain("点「安装」升级一次");
    expect(buttonDisabled(buttonAttrs(markup, "安装"))).toBe(false);
    // 密码行只剩「清除」：组件版本不对，保存 / 修改会被组件那头拒掉，升级之前也不能自动解锁
    expect(markup).toContain("开机密码：已保存");
    expect(buttonAttrs(markup, "清除")).toBeDefined();
    for (const gone of ["修改", "保存", "测试自动解锁"]) {
      expect(buttonAttrs(markup, gone), `不该有「${gone}」`).toBeUndefined();
    }
    expect(markup).toContain("解锁组件还没升级到这一版");
    expect(markup).toContain("关闭上面的「锁屏时也能用」也会同时清除它");
    // 组件里没存着密码：一个字都不多出（没装 / 没存的人看不到任何密码字样）
    const none = html({ status: makeWinStatus({ unlockHelper: stale, credentialSet: false, ...on }), lockedAccess: true });
    for (const absent of ["开机密码：", "解锁组件还没升级到这一版", "测试自动解锁"]) {
      expect(none, `没存着密码：不该出现 ${absent}`).not.toContain(absent);
    }
    // 开关已经关着：「关闭开关也会清除它」没意义（已经关了），只留「升级之前不能自动解锁……可以点清除」（第六轮评审 P3）
    const switchOff = html({ status: makeWinStatus({ unlockHelper: stale, credentialSet: true }), lockedAccess: false });
    expect(switchOff).toContain("解锁组件还没升级到这一版");
    expect(switchOff).toContain("你可以随时点「清除」把它删掉。");
    expect(switchOff).not.toContain("关闭上面的「锁屏时也能用」也会同时清除它");
    expect(buttonAttrs(switchOff, "清除"), "开关关着也要能清掉这份密码").toBeDefined();
  });

  it("解锁组件暂时装不了（canInstall:false）：安装按钮禁用，并显示主进程给的原因", () => {
    const markup = html({
      status: makeWinStatus({
        unlockHelper: { installed: false, canInstall: false, detail: "当前账户不是管理员，无法安装" },
      }),
    });
    expect(buttonDisabled(buttonAttrs(markup, "安装"))).toBe(true);
    expect(markup).toContain("当前账户不是管理员，无法安装");
  });

  it("解锁组件已安装：「已安装」+「卸载」，出现开机密码行与「测试自动解锁」；没有「安装」", () => {
    const markup = html({ status: makeWinStatus({ unlockHelper: helperInstalled }), lockedAccess: true });
    expect(markup).toContain("已安装");
    expect(markup).not.toContain("未安装");
    expect(buttonAttrs(markup, "卸载")).toBeDefined();
    expect(buttonAttrs(markup, "安装")).toBeUndefined();
    expect(markup).toContain("开机密码：未保存");
    expect(buttonAttrs(markup, "保存")).toBeDefined();
    expect(buttonAttrs(markup, "测试自动解锁")).toBeDefined();
  });

  it("开机密码行（Windows）：未保存 → 只有「保存」；已保存 → 「修改」+「清除」", () => {
    const unset = html({ status: makeWinStatus({ unlockHelper: helperInstalled, credentialSet: false }) });
    expect(unset).toContain("开机密码：未保存");
    expect(buttonAttrs(unset, "修改")).toBeUndefined();
    expect(buttonAttrs(unset, "清除")).toBeUndefined();
    const saved = html({ status: makeWinStatus({ unlockHelper: helperInstalled, credentialSet: true }) });
    expect(saved).toContain("开机密码：已保存");
    expect(buttonAttrs(saved, "修改")).toBeDefined();
    expect(buttonAttrs(saved, "清除")).toBeDefined();
    expect(buttonAttrs(saved, "保存")).toBeUndefined();
  });

  it("「测试自动解锁」：仅「已装组件 + 已存密码 + 开关开 + 无门禁原因」时可点（不看后台组件）", () => {
    // 稳态：设置里开着（lockedAccess）、主进程里也开着（lockedAccessEnabled）
    const ok = makeWinStatus({ unlockHelper: helperInstalled, credentialSet: true, lockedAccessEnabled: true });
    expect(buttonDisabled(buttonAttrs(html({ status: ok, lockedAccess: true }), "测试自动解锁"))).toBe(false);
    // 后台组件坏了不影响自动解锁这条路线的测试
    const bgBroken = { ...ok, backgroundReady: false };
    expect(buttonDisabled(buttonAttrs(html({ status: bgBroken, lockedAccess: true }), "测试自动解锁"))).toBe(false);

    const cases: Array<[string, Partial<ViewProps>]> = [
      ["没存密码", { status: { ...ok, credentialSet: false }, lockedAccess: true }],
      ["锁屏开关没开", { status: { ...ok, lockedAccessEnabled: false }, lockedAccess: false }],
      ["总开关没开", { status: { ...ok, enabled: false }, lockedAccess: true, enabled: false }],
      ["原生组件没就绪", { status: { ...ok, driverReady: false }, lockedAccess: true }],
    ];
    for (const [name, over] of cases) {
      const attrs = buttonAttrs(html(over), "测试自动解锁");
      expect(attrs, `${name}：应该仍显示按钮`).toBeDefined();
      expect(buttonDisabled(attrs), `${name}：应该禁用`).toBe(true);
    }
  });

  it("macOS 的按钮名不出现在 Windows 区块里（「测试锁屏可用」是 macOS 专属）", () => {
    const markup = html({
      status: makeWinStatus({ unlockHelper: helperInstalled, credentialSet: true }),
      lockedAccess: true,
    });
    expect(markup).not.toContain("测试锁屏可用");
  });

  it("解锁没就绪的补充原因（冷却中 / 条件不够）：只在已存密码时显示——没存密码时「未保存」一行已经说明了", () => {
    const note = "刚刚自动解锁失败过，约 8 分钟后恢复";
    const saved = html({
      status: makeWinStatus({ unlockHelper: helperInstalled, credentialSet: true, unlockReady: false, unlockNote: note }),
    });
    expect(saved).toContain(note);
    const unset = html({
      status: makeWinStatus({ unlockHelper: helperInstalled, credentialSet: false, unlockReady: false, unlockNote: note }),
    });
    expect(unset).not.toContain(note);
    // 已经就绪就不再说
    const ready = html({
      status: makeWinStatus({ unlockHelper: helperInstalled, credentialSet: true, unlockReady: true, unlockNote: note }),
    });
    expect(ready).not.toContain(note);
  });

  it("本平台没有任何锁屏路线（lockedAccessSupported=false）：仍只给说明，不出 Windows 区块", () => {
    const markup = html({
      status: makeWinStatus({ lockedAccessSupported: false, lockedAccessNote: "锁屏后台组件不可用：缺少 koffi" }),
    });
    expect(markup).toContain("锁屏后台组件不可用：缺少 koffi");
    expect(switchCount(markup)).toBe(1);
    for (const absent of [WIN_LOCKED_DESC, "测试后台操作", "解锁组件", "开机密码："]) {
      expect(markup).not.toContain(absent);
    }
  });

  it("无桥环境 / 状态还没取回：Windows 区块不出现（没有 status 就不知道是哪个平台，只出禁用的开关）", () => {
    const markup = html({ bridge: null, status: null });
    expect(markup).not.toContain("测试后台操作");
    expect(markup).not.toContain("解锁组件");
    expect(isDisabled(switchTagAfter(markup, "锁屏时也能用"))).toBe(true);
  });
});

// ===========================================================================
// 2b. 开关显示以主进程实际状态为准（第二轮评审 #10）+ 装配失败后仍能关掉（修复引入的回归）
// ===========================================================================
describe("开关显示什么：actualSwitchState / shownSwitchState / getSwitchMismatchNote（纯函数）", () => {
  it("actualSwitchState：只有 supported:true 的快照才有「实际状态」；装配失败 / 没有驱动的占位快照（enabled 恒 false）、没有快照都是 undefined", () => {
    expect(actualSwitchState(makeStatus({ enabled: true }), "enabled")).toBe(true);
    expect(actualSwitchState(makeStatus({ enabled: false }), "enabled")).toBe(false);
    expect(actualSwitchState(makeStatus({ lockedAccessEnabled: true }), "lockedAccessEnabled")).toBe(true);
    expect(actualSwitchState(makeStatus({ lockedAccessEnabled: false }), "lockedAccessEnabled")).toBe(false);
    expect(actualSwitchState(makeStatus({ supported: false, enabled: false }), "enabled")).toBeUndefined();
    expect(actualSwitchState(makeStatus({ supported: false, lockedAccessEnabled: false }), "lockedAccessEnabled")).toBeUndefined();
    expect(actualSwitchState(null, "enabled")).toBeUndefined();
    expect(actualSwitchState(null, "lockedAccessEnabled")).toBeUndefined();
  });

  it("shownSwitchState：用户刚点的（pending）> 主进程实际状态 > 设置草稿", () => {
    const cases: Array<[boolean | null, boolean | undefined, boolean, boolean]> = [
      // [pending, actual, draft, 显示]
      [true, false, false, true],
      [false, true, true, false],
      [null, true, false, true], // 写盘失败后：草稿是乐观的「关」，实际还开着 → 显示开
      [null, false, true, false], // 草稿是「开」，主进程还没生效 → 显示关
      [null, undefined, true, true], // 拿不到实际状态：退回草稿
      [null, undefined, false, false],
      [null, true, true, true],
      [null, false, false, false],
    ];
    for (const [pending, actual, draft, shown] of cases) {
      expect(shownSwitchState({ pending, actual, draft }), JSON.stringify({ pending, actual, draft })).toBe(shown);
    }
  });

  it("getSwitchMismatchNote：一致 / 拿不到实际状态 / 还在同步（pending）→ null；对不上 → 常驻说明，且「界面关、实际开」明说 AI 目前仍可以操作", () => {
    expect(getSwitchMismatchNote({ kind: "enabled", draft: true, actual: true, pending: null })).toBeNull();
    expect(getSwitchMismatchNote({ kind: "enabled", draft: false, actual: false, pending: null })).toBeNull();
    expect(getSwitchMismatchNote({ kind: "enabled", draft: true, actual: undefined, pending: null })).toBeNull();
    expect(getSwitchMismatchNote({ kind: "enabled", draft: false, actual: true, pending: false })).toBeNull();
    expect(getSwitchMismatchNote({ kind: "lockedAccess", draft: true, actual: false, pending: true })).toBeNull();

    const stillOn = getSwitchMismatchNote({ kind: "enabled", draft: false, actual: true, pending: null });
    expect(stillOn).toContain("「电脑操作」还没有真正关掉");
    expect(stillOn).toContain("主进程里仍然开着");
    expect(stillOn).toContain("AI 目前仍可以操作这台电脑");
    expect(stillOn).toContain("请再点一次开关");

    const notYet = getSwitchMismatchNote({ kind: "enabled", draft: true, actual: false, pending: null });
    expect(notYet).toContain("「电脑操作」还没有真正开启");
    expect(notYet).toContain("AI 目前还不能操作这台电脑");

    const lockedStillOn = getSwitchMismatchNote({ kind: "lockedAccess", draft: false, actual: true, pending: null });
    expect(lockedStillOn).toContain("「锁屏时也能用」还没有真正关掉");
    expect(lockedStillOn).toContain("AI 目前仍可以在锁屏时使用这台电脑");
    // 说明里不承诺「会自动重试」（重试与否由 saveFieldValue 自己的 toast 说清楚）
    for (const note of [stillOn, notYet, lockedStillOn]) expect(note).not.toContain("自动重试");
  });
});

describe("渲染 · 开关显示以主进程实际状态为准（设置草稿只在拿不到实际状态时才用）", () => {
  it("稳态（设置与主进程一致）：不出任何对不上的说明", () => {
    for (const [enabled, lockedAccess] of [
      [true, false],
      [true, true],
      [false, false],
    ] as const) {
      const markup = html({
        enabled,
        lockedAccess,
        status: makeStatus({ enabled, lockedAccessEnabled: lockedAccess }),
      });
      expect(markup, `${enabled}/${lockedAccess}`).not.toContain("还没有真正");
    }
  });

  it("写盘失败的典型：设置草稿是「关」（乐观更新），主进程里仍然开着 → 总开关显示「开」+ 常驻说明（不再显示成已经关了）", () => {
    const markup = html({ enabled: false, status: makeStatus({ enabled: true }) });
    expect(isOn(switchTagAfter(markup, "电脑操作"))).toBe(true);
    expect(markup).toContain("「电脑操作」还没有真正关掉");
    expect(markup).toContain("AI 目前仍可以操作这台电脑");
    expect(markup).toContain("text-warning");
  });

  it("反过来：设置草稿是「开」，主进程还没生效 → 总开关显示「关」+ 说明（AI 目前还不能操作）", () => {
    const markup = html({ enabled: true, status: makeStatus({ enabled: false }) });
    expect(isOn(switchTagAfter(markup, "电脑操作"))).toBe(false);
    expect(markup).toContain("「电脑操作」还没有真正开启");
  });

  it("拿不到实际状态（还没读到 / 没有桥）：退回设置草稿显示，没有说明", () => {
    const loading = html({ enabled: true, status: null });
    expect(isOn(switchTagAfter(loading, "电脑操作"))).toBe(true);
    expect(loading).not.toContain("还没有真正");
    const web = html({ enabled: true, bridge: null, status: null });
    expect(isOn(switchTagAfter(web, "电脑操作"))).toBe(true);
    expect(web).not.toContain("还没有真正");
  });

  it("「锁屏时也能用」同理：草稿关、主进程里仍开 → 显示开 + 说明（macOS 与 Windows 区块都有）", () => {
    for (const [name, status] of [
      ["macOS", makeStatus({ lockedAccessEnabled: true, credentialSet: true })],
      ["Windows", makeWinStatus({ lockedAccessEnabled: true })],
    ] as const) {
      const markup = html({ lockedAccess: false, status });
      expect(isOn(switchTagAfter(markup, "锁屏时也能用")), name).toBe(true);
      expect(markup, name).toContain("「锁屏时也能用」还没有真正关掉");
      expect(markup, name).toContain("AI 目前仍可以在锁屏时使用这台电脑");
    }
  });

  it("「锁屏时也能用」草稿开、主进程里还没开 → 显示关 + 说明", () => {
    const markup = html({ lockedAccess: true, status: makeStatus({ lockedAccessEnabled: false, credentialSet: true }) });
    expect(isOn(switchTagAfter(markup, "锁屏时也能用"))).toBe(false);
    expect(markup).toContain("「锁屏时也能用」还没有真正开启");
  });

  it("锁屏开关的门禁看的是总开关「此刻显示的值」（主进程实际状态），不是草稿：草稿开、主进程里还没开 → 仍提示先开启", () => {
    const markup = html({ enabled: true, lockedAccess: false, status: makeStatus({ enabled: false }) });
    expect(markup).toContain("需要先开启「电脑操作」");
    expect(isDisabled(switchTagAfter(markup, "锁屏时也能用"))).toBe(true);
  });
});

describe("渲染 · 装配失败 / 没有驱动后：设置里已开着的开关仍能关掉（只拦打开）", () => {
  const REASON = "电脑操作没能初始化（磁盘只读）。请重启 Flowship 再试；还不行就把应用日志发给开发者排查";
  /** 和主进程 initFailedStatus 一致的占位快照：enabled / lockedAccessEnabled 恒 false，不是真读数 */
  const failed = (over: Partial<ComputerUseStatus> = {}) =>
    makeStatus({
      platform: "darwin",
      supported: false,
      lockedAccessSupported: false,
      driverReady: false,
      driverError: REASON,
      lockedAccessNote: REASON,
      enabled: false,
      lockedAccessEnabled: false,
      permissions: perms("unknown", "unknown"),
      ...over,
    });

  it("设置里「电脑操作」开着：总开关显示「开」且可点（只能关）；占位快照的 enabled:false 不当实际状态、不出对不上的说明", () => {
    const markup = html({ enabled: true, status: failed() });
    const tag = switchTagAfter(markup, "电脑操作");
    expect(isOn(tag)).toBe(true);
    expect(isDisabled(tag)).toBe(false);
    expect(markup).toContain(REASON);
    expect(markup).not.toContain("还没有真正");
  });

  it("设置里本来就是关的：总开关仍禁用（打开一律不行）", () => {
    const markup = html({ enabled: false, status: failed() });
    expect(isOn(switchTagAfter(markup, "电脑操作"))).toBe(false);
    expect(isDisabled(switchTagAfter(markup, "电脑操作"))).toBe(true);
  });

  it("「锁屏时也能用」在设置里还开着：整块锁屏区块仍不出（没有测试 / 密码行 / 风险文案），只留一行能关掉的开关 + 说明", () => {
    const markup = html({ enabled: true, lockedAccess: true, status: failed() });
    expect(switchCount(markup)).toBe(2); // 总开关 + 锁屏那一行
    const tag = switchTagAfter(markup, "锁屏时也能用");
    expect(isOn(tag)).toBe(true);
    expect(isDisabled(tag)).toBe(false);
    expect(markup).toContain(LOCKED_ACCESS_UNAVAILABLE_HINT);
    for (const absent of [LOCKED_DESC, RISK_TEXT, "开机密码：", "测试锁屏可用", "辅助功能", "屏幕录制"]) {
      expect(markup).not.toContain(absent);
    }
  });

  it("「锁屏时也能用」本来就关着：不出这一行（和以前一样整块不出现）", () => {
    for (const lockedAccess of [false]) {
      const markup = html({ enabled: true, lockedAccess, status: failed() });
      expect(switchCount(markup)).toBe(1);
      expect(markup).not.toContain("锁屏时也能用");
    }
  });

  it("没有桌面驱动的平台（Linux，platform: other）同口径：开着的能关、关着的禁用", () => {
    const linux = failed({ platform: "other", driverError: undefined, lockedAccessNote: "当前系统暂不支持电脑操作" });
    const on = html({ enabled: true, status: linux });
    expect(isDisabled(switchTagAfter(on, "电脑操作"))).toBe(false);
    expect(on).toContain("当前系统暂不支持电脑操作");
    const off = html({ enabled: false, status: linux });
    expect(isDisabled(switchTagAfter(off, "电脑操作"))).toBe(true);
  });

  // 第三轮评审：装配失败时 clearCredential 直接 reject、只能等功能恢复才清得掉那份能自动解锁电脑的密码；
  // 清除不需要驱动，所以这种状态下也留一个入口（主进程那边装配失败时仍能清，见 desktop-index.test.ts）
  it("有桌面驱动的平台装配失败（macOS / Windows）：多出「已保存的开机密码」一行 + 「清除」；读不出有没有存过，所以不说「已保存 / 未保存」", () => {
    for (const platform of ["darwin", "win32"] as const) {
      const markup = html({ enabled: true, status: failed({ platform }) });
      expect(markup, platform).toContain("已保存的开机密码");
      expect(markup, platform).toContain(UNAVAILABLE_CREDENTIAL_HINT);
      expect(buttonAttrs(markup, "清除"), platform).toBeDefined();
      expect(markup, platform).not.toContain("开机密码：");
    }
    // 设置里「锁屏时也能用」没开也一样有（密码可能是以前存的）
    expect(html({ enabled: false, lockedAccess: false, status: failed() })).toContain("已保存的开机密码");
  });

  it("没有桌面驱动的平台（Linux，platform: other）没有这一行（没有什么可清的）；没有桥（网页版）也没有", () => {
    const linux = failed({ platform: "other", driverError: undefined, lockedAccessNote: "当前系统暂不支持电脑操作" });
    const markup = html({ enabled: true, status: linux });
    expect(markup).not.toContain("已保存的开机密码");
    expect(buttonAttrs(markup, "清除")).toBeUndefined();
    const noBridge = html({ enabled: true, bridge: null, status: failed() });
    expect(noBridge).not.toContain("已保存的开机密码");
  });

  it("正常状态（supported:true）不出这一行：那里有自己的「开机密码：已保存 / 未保存」行", () => {
    expect(html({ status: makeStatus({ credentialSet: true }) })).not.toContain("已保存的开机密码");
  });

  it("锁屏那行的说明指路到这一行（不再说「等功能恢复后才能清」）", () => {
    expect(LOCKED_ACCESS_UNAVAILABLE_HINT).toContain("已保存的开机密码");
    expect(LOCKED_ACCESS_UNAVAILABLE_HINT).not.toContain("恢复正常后");
  });
});

// ===========================================================================
// 3. 小组件
// ===========================================================================
describe("PermissionGuide：点过「去授权」之后的行内提示", () => {
  it("辅助功能：只有「请在系统设置里勾选 Flowship」", () => {
    const markup = renderToStaticMarkup(createElement(PermissionGuide, { kind: "accessibility" }));
    expect(markup).toContain("请在系统设置里勾选 Flowship");
    expect(markup).not.toContain("重启");
  });

  it("屏幕录制：多一句「授权后需要重启 Flowship 才生效」", () => {
    const markup = renderToStaticMarkup(createElement(PermissionGuide, { kind: "screen" }));
    expect(markup).toContain("请在系统设置里勾选 Flowship");
    expect(markup).toContain("授权后需要重启 Flowship 才生效");
  });
});

describe("PermissionRow：单项权限行", () => {
  type RowProps = Parameters<typeof PermissionRow>[0];

  const mountRow = (over: Partial<RowProps> = {}) => {
    const bridge = makeBridge();
    const onStatus = vi.fn();
    const props: RowProps = {
      item: { kind: "screen", label: "屏幕录制" },
      granted: false,
      bridge,
      onStatus,
      ...over,
    };
    const harness = createHookHarness();
    const render = () => walk(harness.render(() => PermissionRow(props)));
    return { bridge, onStatus, render };
  };

  const rowHint = (els: El[]) =>
    pick(els, (el) => el.type === SettingRow, "权限行").props.hint;

  it("已授权：只有「已授权」徽标，没有按钮", () => {
    const markup = renderToStaticMarkup(
      createElement(PermissionRow, {
        item: { kind: "accessibility", label: "辅助功能" },
        granted: true,
        bridge: makeBridge(),
        onStatus: vi.fn(),
      }),
    );
    expect(markup).toContain("辅助功能");
    expect(markup).toContain("已授权");
    expect(markup).not.toContain("<button");
  });

  it("点「去授权」：调 bridge.requestPermission(kind)，用返回的最新状态通知父级，随后出现行内提示", async () => {
    const m = mountRow();
    expect(rowHint(m.render())).toBeUndefined();

    const latest = makeStatus({ permissions: perms("granted", "not-determined") });
    m.bridge.requestPermission.mockResolvedValueOnce(latest);
    call(pick(m.render(), isButton, "去授权"), "onClick");
    await flush();

    expect(m.bridge.requestPermission).toHaveBeenCalledExactlyOnceWith("screen");
    expect(m.onStatus).toHaveBeenCalledExactlyOnceWith(latest);
    const hint = rowHint(m.render()) as El;
    expect(hint.type).toBe(PermissionGuide);
    expect(hint.props.kind).toBe("screen");
  });

  it("请求进行中按钮禁用（防连点），结束后恢复", async () => {
    const m = mountRow();
    const gate = deferred<ComputerUseStatus>();
    m.bridge.requestPermission.mockReturnValueOnce(gate.promise);
    call(pick(m.render(), isButton, "去授权"), "onClick");
    expect(pick(m.render(), isButton, "去授权").props.disabled).toBe(true);
    gate.resolve(makeStatus());
    await flush();
    expect(pick(m.render(), isButton, "去授权").props.disabled).toBe(false);
  });

  it("请求失败：toast 报错，不通知父级、也不出现「已点过」的提示", async () => {
    const m = mountRow();
    m.bridge.requestPermission.mockRejectedValueOnce(new Error("系统设置打不开"));
    call(pick(m.render(), isButton, "去授权"), "onClick");
    await flush();
    expect(h.toastError).toHaveBeenCalledExactlyOnceWith("打开授权失败：系统设置打不开");
    expect(m.onStatus).not.toHaveBeenCalled();
    expect(rowHint(m.render())).toBeUndefined();
    expect(pick(m.render(), isButton, "去授权").props.disabled).toBe(false);
  });

  it("点过之后权限已被授上：提示随「已授权」一并消失", async () => {
    const m = mountRow();
    call(pick(m.render(), isButton, "去授权"), "onClick");
    await flush();
    expect(rowHint(m.render())).toBeDefined();

    // 父级拿到新状态后以 granted=true 重新渲染同一行
    const granted = mountRow({ granted: true });
    expect(rowHint(granted.render())).toBeUndefined();
  });
});

describe("LockedAccessTestReport：测试结果清单", () => {
  const steps: LockedAccessTestResult["steps"] = [
    { name: "锁屏", ok: true, ms: 120 },
    { name: "自动解锁", ok: false, ms: 3400, detail: "没有看到登录界面" },
  ];

  it("通过：总结果 + 逐步（✓ + 名称 + 耗时 + 详情）", () => {
    const markup = renderToStaticMarkup(
      createElement(LockedAccessTestReport, {
        result: { ok: true, steps: [{ name: "回到桌面", ok: true, ms: 120, detail: "用时很短" }] },
      }),
    );
    expect(markup).toContain("测试通过");
    expect(markup).not.toContain("测试失败");
    expect(markup).toContain("回到桌面");
    expect(markup).toContain("120 ms");
    expect(markup).toContain("用时很短");
    expect(markup).toContain('aria-label="通过"');
    expect(markup).toContain("✓");
    expect(markup).not.toContain("✗");
  });

  it("失败：总结果 + 原因 + 逐步（✗ 带详情）", () => {
    const markup = renderToStaticMarkup(
      createElement(LockedAccessTestReport, {
        result: { ok: false, steps, error: "解锁后仍是锁屏界面" },
      }),
    );
    expect(markup).toContain("测试失败");
    expect(markup).not.toContain("测试通过");
    expect(markup).toContain("解锁后仍是锁屏界面");
    expect(markup).toContain("3400 ms");
    expect(markup).toContain("没有看到登录界面");
    expect(markup).toContain('aria-label="失败"');
    expect(markup).toContain('aria-label="通过"'); // 第一步是成功的
    expect(markup).toContain("✗");
    expect(markup).toContain("✓");
  });

  it("没有步骤时不出清单；通过时不展示 error 字段", () => {
    const failed = renderToStaticMarkup(
      createElement(LockedAccessTestReport, {
        result: { ok: false, steps: [], error: "桥断开" },
      }),
    );
    expect(failed).toContain("桥断开");
    expect(failed).not.toContain("<ul");

    const passed = renderToStaticMarkup(
      createElement(LockedAccessTestReport, {
        result: { ok: true, steps: [], error: "不该被展示" },
      }),
    );
    expect(passed).not.toContain("不该被展示");
  });
});

describe("LockedAccessTest：「测试锁屏可用」", () => {
  const mountTest = (disabled = false) => {
    const bridge = makeBridge();
    const onFinished = vi.fn();
    const props = { bridge, disabled, onFinished };
    const harness = createHookHarness();
    const render = () => walk(harness.render(() => LockedAccessTest(props)));
    const button = () => pick(render(), isButton, "测试按钮");
    return { bridge, onFinished, render, button };
  };

  it("disabled 时按钮禁用", () => {
    expect(mountTest(true).button().props.disabled).toBe(true);
    expect(mountTest(false).button().props.disabled).toBe(false);
  });

  it("点击先弹确认（固定文案、默认聚焦取消）；取消 → 不锁屏、不刷新", async () => {
    const t = mountTest();
    h.confirm.mockResolvedValue(false);
    call(t.button(), "onClick");
    await flush();
    expect(h.confirm).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        title: "测试锁屏可用",
        description: TEST_CONFIRM_TEXT,
        defaultFocus: "cancel",
      }),
    );
    expect(t.bridge.testLockedAccess).not.toHaveBeenCalled();
    expect(t.onFinished).not.toHaveBeenCalled();
    expect(textOf(t.button())).toBe("测试锁屏可用");
  });

  it("确认后：按钮 loading（禁用 + 转圈 +「测试中…」）→ 结果清单；结束后立即刷新一次状态", async () => {
    const t = mountTest();
    const gate = deferred<LockedAccessTestResult>();
    t.bridge.testLockedAccess.mockReturnValueOnce(gate.promise);
    h.confirm.mockResolvedValue(true);

    call(t.button(), "onClick");
    await flush();

    const running = t.render();
    const runningButton = pick(running, isButton, "测试按钮");
    expect(runningButton.props.disabled).toBe(true);
    expect(textOf(runningButton)).toBe("测试中…");
    expect(running.some((el) => el.type === Loader2)).toBe(true);
    expect(running.some((el) => el.type === LockedAccessTestReport)).toBe(false);
    expect(t.onFinished).not.toHaveBeenCalled();

    const result: LockedAccessTestResult = {
      ok: true,
      steps: [{ name: "锁屏", ok: true, ms: 80 }],
    };
    gate.resolve(result);
    await flush();

    const done = t.render();
    expect(pick(done, (el) => el.type === LockedAccessTestReport, "结果").props.result).toBe(result);
    const doneButton = pick(done, isButton, "测试按钮");
    expect(doneButton.props.disabled).toBe(false);
    expect(textOf(doneButton)).toBe("测试锁屏可用");
    expect(t.onFinished).toHaveBeenCalledTimes(1);
  });

  it("桥抛错：折成失败结果（带原因）展示，不留未处理异常，同样刷新状态", async () => {
    const t = mountTest();
    t.bridge.testLockedAccess.mockRejectedValueOnce(new Error("IPC 超时"));
    h.confirm.mockResolvedValue(true);
    call(t.button(), "onClick");
    await flush();
    const report = pick(t.render(), (el) => el.type === LockedAccessTestReport, "结果");
    expect(report.props.result).toEqual({ ok: false, steps: [], error: "IPC 超时" });
    expect(t.onFinished).toHaveBeenCalledTimes(1);
  });
});

describe("LockedAccessTest：Windows 的「测试后台操作」/「测试自动解锁」", () => {
  const mountKind = (props: { kind?: "unlock" | "background"; label?: string } = {}) => {
    const bridge = makeBridge();
    const onFinished = vi.fn();
    const harness = createHookHarness();
    const render = () =>
      walk(harness.render(() => LockedAccessTest({ bridge, disabled: false, onFinished, ...props })));
    const button = () => pick(render(), isButton, "测试按钮");
    return { bridge, onFinished, render, button };
  };

  it("kind=background：按钮「测试后台操作」；确认文案说清「测完仍是锁屏、要自己解锁」，默认聚焦取消", async () => {
    const t = mountKind({ kind: "background" });
    expect(textOf(t.button())).toBe("测试后台操作");
    h.confirm.mockResolvedValue(false);
    call(t.button(), "onClick");
    await flush();
    expect(h.confirm).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        title: "测试后台操作",
        description: BG_TEST_CONFIRM_TEXT,
        defaultFocus: "cancel",
      }),
    );
    // 取消 → 什么都不跑
    expect(t.bridge.testBackground).not.toHaveBeenCalled();
    expect(t.bridge.testLockedAccess).not.toHaveBeenCalled();
    expect(t.onFinished).not.toHaveBeenCalled();
  });

  it("kind=background：确认后走 bridge.testBackground（不是 testLockedAccess）；结果用中文步骤名展示；结束后刷新状态", async () => {
    const t = mountKind({ kind: "background" });
    const result: LockedAccessTestResult = {
      ok: false,
      steps: [
        { name: "window", ok: true, ms: 120 },
        { name: "lock", ok: true, ms: 800 },
        { name: "capture", ok: true, ms: 300, detail: "2 个窗口，其中 1 个空白" },
        { name: "input", ok: false, ms: 50, detail: "窗口标题没有变化" },
      ],
      error: "锁屏时输入没有生效",
    };
    t.bridge.testBackground.mockResolvedValueOnce(result);
    h.confirm.mockResolvedValue(true);
    call(t.button(), "onClick");
    await flush();
    expect(t.bridge.testBackground).toHaveBeenCalledTimes(1);
    expect(t.bridge.testLockedAccess).not.toHaveBeenCalled();
    const report = pick(t.render(), (el) => el.type === LockedAccessTestReport, "结果");
    expect(report.props.result).toBe(result);
    expect(report.props.stepLabels).toBe(BACKGROUND_STEP_LABELS);
    expect(t.onFinished).toHaveBeenCalledTimes(1);
    expect(textOf(t.button())).toBe("测试后台操作");
  });

  it("kind=background：桥抛错 → 折成失败结果展示，同样刷新状态", async () => {
    const t = mountKind({ kind: "background" });
    t.bridge.testBackground.mockRejectedValueOnce(new Error("IPC 超时"));
    h.confirm.mockResolvedValue(true);
    call(t.button(), "onClick");
    await flush();
    const report = pick(t.render(), (el) => el.type === LockedAccessTestReport, "结果");
    expect(report.props.result).toEqual({ ok: false, steps: [], error: "IPC 超时" });
    expect(t.onFinished).toHaveBeenCalledTimes(1);
  });

  it("kind=unlock + label：按钮和确认框标题都用自定义名字，仍走 testLockedAccess、确认文案不变、步骤名原样", async () => {
    const t = mountKind({ label: "测试自动解锁" });
    expect(textOf(t.button())).toBe("测试自动解锁");
    h.confirm.mockResolvedValue(true);
    call(t.button(), "onClick");
    await flush();
    expect(h.confirm).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ title: "测试自动解锁", description: TEST_CONFIRM_TEXT, defaultFocus: "cancel" }),
    );
    expect(t.bridge.testLockedAccess).toHaveBeenCalledTimes(1);
    expect(t.bridge.testBackground).not.toHaveBeenCalled();
    const report = pick(t.render(), (el) => el.type === LockedAccessTestReport, "结果");
    expect(report.props.stepLabels).toBeUndefined();
  });

  it("测试进行中按钮 loading + 禁用（后台测试同样：只能点一次）", async () => {
    const t = mountKind({ kind: "background" });
    const gate = deferred<LockedAccessTestResult>();
    t.bridge.testBackground.mockReturnValueOnce(gate.promise);
    h.confirm.mockResolvedValue(true);
    call(t.button(), "onClick");
    await flush();
    const running = pick(t.render(), isButton, "测试按钮");
    expect(running.props.disabled).toBe(true);
    expect(textOf(running)).toBe("测试中…");
    gate.resolve({ ok: true, steps: [] });
    await flush();
    expect(pick(t.render(), isButton, "测试按钮").props.disabled).toBe(false);
  });
});

describe("LockedAccessTestReport：步骤中文名（stepLabels）", () => {
  it("有对应项的显示中文名，没有的原样显示；不传 stepLabels 一律原样", () => {
    const result: LockedAccessTestResult = {
      ok: true,
      steps: [
        { name: "countdown", ok: true, ms: 5000 },
        { name: "capture", ok: true, ms: 300 },
        { name: "something_new", ok: true, ms: 1 },
      ],
    };
    const labeled = renderToStaticMarkup(
      createElement(LockedAccessTestReport, { result, stepLabels: BACKGROUND_STEP_LABELS }),
    );
    expect(labeled).toContain("倒计时");
    expect(labeled).toContain("锁屏时截图");
    expect(labeled).toContain("something_new");
    expect(labeled).not.toContain(">countdown<");
    expect(labeled).not.toContain(">capture<");

    const raw = renderToStaticMarkup(createElement(LockedAccessTestReport, { result }));
    expect(raw).toContain(">countdown<");
    expect(raw).toContain(">capture<");
    expect(raw).not.toContain("倒计时");
  });

  it("BACKGROUND_STEP_LABELS 覆盖主进程探针的全部步骤名（步骤名以 background-probe.mjs 为准）", () => {
    const probe = read("electron-app/desktop/background-probe.mjs");
    // 探针里 add("xxx", …) 登记的步骤名都得有中文名，不然用户会在报告里看到英文标识
    const names = [...probe.matchAll(/\badd\(\s*"(\w+)"/g)].map((m) => m[1] ?? "");
    expect(names.length).toBeGreaterThan(0);
    for (const name of new Set(names)) {
      expect(BACKGROUND_STEP_LABELS[name], `步骤「${name}」缺中文名`).toBeTruthy();
    }
  });
});

describe("UnlockHelperRow：Windows 解锁组件的安装 / 卸载", () => {
  const mountRow = (helper: { installed: boolean; canInstall: boolean; detail?: string }) => {
    const bridge = makeBridge();
    const onFinished = vi.fn();
    const harness = createHookHarness();
    const render = () => walk(harness.render(() => UnlockHelperRow({ bridge, helper, onFinished })));
    /** 行里的按钮（安装 / 卸载只会出现一个）：SettingRow 的 control 里藏着元素，walk 会走进去 */
    const button = () => pick(render(), isButton, "安装 / 卸载按钮");
    return { bridge, onFinished, render, button };
  };
  const NOT_INSTALLED = { installed: false, canInstall: true } as const;
  const INSTALLED = { installed: true, canInstall: false } as const;

  it("没装：只有「安装」；装了：只有「卸载」；canInstall:false 时安装禁用", () => {
    expect(textOf(mountRow(NOT_INSTALLED).button())).toBe("安装");
    expect(mountRow(NOT_INSTALLED).button().props.disabled).toBe(false);
    expect(mountRow({ installed: false, canInstall: false }).button().props.disabled).toBe(true);
    const installed = mountRow(INSTALLED).button();
    expect(textOf(installed)).toBe("卸载");
    // canInstall 只管「安装」：已装的组件随时能卸载
    expect(installed.props.disabled).toBe(false);
  });

  it("安装：先弹确认（说明会弹管理员授权框、可随时卸载；默认聚焦取消）；取消 → 不碰系统", async () => {
    const t = mountRow(NOT_INSTALLED);
    h.confirm.mockResolvedValue(false);
    call(t.button(), "onClick");
    await flush();
    expect(h.confirm).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        title: "安装解锁组件",
        confirmLabel: "安装",
        defaultFocus: "cancel",
        description: expect.stringContaining("管理员授权"),
      }),
    );
    expect(t.bridge.installUnlockHelper).not.toHaveBeenCalled();
    expect(t.onFinished).not.toHaveBeenCalled();
    expect(h.toastSuccess).not.toHaveBeenCalled();
    expect(h.toastError).not.toHaveBeenCalled();
  });

  // 第二轮评审：旧文案写「只在 AI 需要解锁电脑时才会被 Flowship 调用」——不准确：组件是开机自启的常驻服务，
  // 且「只认你的账户」不等于「只有 Flowship 能联系它」，同一账户下的其他程序也能（威胁模型见 docs/COMPUTER-USE.md §5.4）。
  it("安装确认文案如实交代：常驻服务、保存开机密码、同账户下的其他程序也能联系它；不再说「只在 AI 需要解锁时才会被调用」", async () => {
    const t = mountRow(NOT_INSTALLED);
    h.confirm.mockResolvedValue(false);
    call(t.button(), "onClick");
    await flush();
    const description = String((h.confirm.mock.calls[0]![0] as { description: unknown }).description);
    expect(description).toContain("常驻运行");
    expect(description).toContain("开机自动启动");
    expect(description).toContain("加密保存你的开机密码");
    expect(description).toContain("这个账户下运行的其他程序也能联系到它");
    expect(description).toContain("可以随时在这里卸载");
    expect(description).not.toContain("只在 AI 需要解锁电脑时");
  });

  it("安装成功：进行中按钮 loading + 禁用 → toast 成功 → 立即刷新状态", async () => {
    const t = mountRow(NOT_INSTALLED);
    const gate = deferred<{ ok: boolean; error?: string }>();
    t.bridge.installUnlockHelper.mockReturnValueOnce(gate.promise);
    h.confirm.mockResolvedValue(true);
    call(t.button(), "onClick");
    await flush();

    const running = t.button();
    expect(running.props.disabled).toBe(true);
    expect(t.render().some((el) => el.type === Loader2)).toBe(true);
    expect(t.onFinished).not.toHaveBeenCalled();

    gate.resolve({ ok: true });
    await flush();
    expect(h.toastSuccess).toHaveBeenCalledExactlyOnceWith("解锁组件已安装");
    expect(t.onFinished).toHaveBeenCalledTimes(1);
    expect(t.button().props.disabled).toBe(false);
    expect(t.render().some((el) => el.type === Loader2)).toBe(false);
  });

  it("安装失败：toast 主进程给的原因（没给 → 「原因未知」）；桥抛错 → toast 错误信息；都会刷新状态", async () => {
    const t = mountRow(NOT_INSTALLED);
    h.confirm.mockResolvedValue(true);

    t.bridge.installUnlockHelper.mockResolvedValueOnce({ ok: false, error: " 你拒绝了管理员授权 " });
    call(t.button(), "onClick");
    await flush();
    expect(h.toastError).toHaveBeenLastCalledWith("安装失败：你拒绝了管理员授权");

    t.bridge.installUnlockHelper.mockResolvedValueOnce({ ok: false });
    call(t.button(), "onClick");
    await flush();
    expect(h.toastError).toHaveBeenLastCalledWith("安装失败：原因未知");

    t.bridge.installUnlockHelper.mockRejectedValueOnce(new Error("IPC 超时"));
    call(t.button(), "onClick");
    await flush();
    expect(h.toastError).toHaveBeenLastCalledWith("安装失败：IPC 超时");

    expect(h.toastSuccess).not.toHaveBeenCalled();
    expect(t.onFinished).toHaveBeenCalledTimes(3);
  });

  it("卸载：确认是破坏性的、说明会清掉保存的开机密码；确认后走 uninstallUnlockHelper → toast → 刷新", async () => {
    const t = mountRow(INSTALLED);
    h.confirm.mockResolvedValue(true);
    call(t.button(), "onClick");
    await flush();
    expect(h.confirm).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        title: "卸载解锁组件",
        confirmLabel: "卸载",
        destructive: true,
        defaultFocus: "cancel",
        description: expect.stringContaining("清除它保存的开机密码"),
      }),
    );
    expect(t.bridge.uninstallUnlockHelper).toHaveBeenCalledTimes(1);
    expect(t.bridge.installUnlockHelper).not.toHaveBeenCalled();
    expect(h.toastSuccess).toHaveBeenCalledExactlyOnceWith("解锁组件已卸载");
    expect(t.onFinished).toHaveBeenCalledTimes(1);
  });

  it("卸载取消 → 不碰系统；卸载失败 → toast 原因", async () => {
    const t = mountRow(INSTALLED);
    h.confirm.mockResolvedValueOnce(false);
    call(t.button(), "onClick");
    await flush();
    expect(t.bridge.uninstallUnlockHelper).not.toHaveBeenCalled();
    expect(t.onFinished).not.toHaveBeenCalled();

    h.confirm.mockResolvedValueOnce(true);
    t.bridge.uninstallUnlockHelper.mockResolvedValueOnce({ ok: false, error: "AI 正在使用电脑，等它结束后再卸载解锁组件" });
    call(t.button(), "onClick");
    await flush();
    expect(h.toastError).toHaveBeenCalledExactlyOnceWith("卸载失败：AI 正在使用电脑，等它结束后再卸载解锁组件");
    expect(t.onFinished).toHaveBeenCalledTimes(1);
  });

  it("主进程的补充说明（detail）显示在行里；没有 detail 就没有这一句", () => {
    const withDetail = renderToStaticMarkup(
      createElement(UnlockHelperRow, {
        bridge: makeBridge(),
        helper: { installed: false, canInstall: false, detail: "当前账户不是管理员" },
        onFinished: vi.fn(),
      }),
    );
    expect(withDetail).toContain("当前账户不是管理员");
    const without = renderToStaticMarkup(
      createElement(UnlockHelperRow, { bridge: makeBridge(), helper: NOT_INSTALLED, onFinished: vi.fn() }),
    );
    // 补充说明那一行的样式（「未安装」徽标自己也带 text-warning，所以认整行的 class）
    expect(without).not.toContain("mt-1 block text-warning");
    expect(withDetail).toContain("mt-1 block text-warning");
  });
});

describe("ExportDiagnosticsButton：导出诊断信息", () => {
  const mountExport = (bridge: ComputerUseBridge | null) => {
    const harness = createHookHarness();
    return () => harness.render(() => ExportDiagnosticsButton({ bridge })) as El;
  };

  it("导出成功：toast 给出文件路径", async () => {
    const bridge = makeBridge();
    call(mountExport(bridge)(), "onClick");
    await flush();
    expect(bridge.exportDiagnostics).toHaveBeenCalledTimes(1);
    expect(h.toastSuccess).toHaveBeenCalledExactlyOnceWith("诊断信息已导出", {
      description: "/tmp/cu-diag.json",
    });
  });

  it("导出失败：toast 报错原因", async () => {
    const bridge = makeBridge();
    bridge.exportDiagnostics.mockRejectedValueOnce(new Error("磁盘已满"));
    call(mountExport(bridge)(), "onClick");
    await flush();
    expect(h.toastError).toHaveBeenCalledExactlyOnceWith("导出失败：磁盘已满");
    expect(h.toastSuccess).not.toHaveBeenCalled();
  });

  it("无桥：按钮禁用，点了也什么都不发生", async () => {
    const button = mountExport(null)();
    expect(button.props.disabled).toBe(true);
    call(button, "onClick");
    await flush();
    expect(h.toastSuccess).not.toHaveBeenCalled();
    expect(h.toastError).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 4. 开机密码：保存流程 / 与开关、对话框的联动
// ===========================================================================

// ---- 开机密码泄漏探测 ----
// 密码只许经 bridge.setCredential 单向交出去。「没泄漏」的断言要有意义，得同时满足两条：
//  1. 出口收全：toast（成功 / 失败）、确认框、console.*、桥上除 setCredential 之外的每个方法、调用方传进来的每个回调、渲染出来的文字 / 属性。
//     以前只盯 refresh / writeLockedAccess 这几个根本不会收到密码的回调——成功路径上连 toast 都没有，等于什么都没测；
//  2. 探测器自己可靠：往每一类出口里真塞一次密码，都能被抓出来（见「泄漏探测器自检」）。

/** 测试用的开机密码：中文 + 符号，输出里一眼认得出；不含 JSON 会转义的字符（引号 / 反斜杠 / 控制字符），不然序列化后就搜不到原文（自检里守着） */
const SECRET = "S3cret-密码-9f3a";

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;

/** 装上 console 的 spy：既不污染测试输出，也让 console.* 成为被盯着的出口（还原在文件级 afterEach） */
const watchConsole = (): Record<string, unknown> =>
  Object.fromEntries(
    CONSOLE_METHODS.map((method) => [`console.${method}`, vi.spyOn(console, method).mockImplementation(() => {})]),
  );

/** 渲染出来的元素树里所有看得见的字符串：文字 + 字符串 / 数字属性（value、aria-label、placeholder……） */
const renderedStrings = (tree: unknown): string[] => [
  textOf(tree),
  ...walk(tree).flatMap((el) =>
    Object.values(el.props)
      .flat()
      .filter((v): v is string | number => typeof v === "string" || typeof v === "number")
      .map(String),
  ),
];

/**
 * 所有出口收到过的东西，摊成「出口名 → 调用参数」的一张表。
 * 桥上只收除 setCredential 之外的方法：setCredential 是唯一被允许收到密码的出口，另行断言「恰好一次、恰好 { password }」。
 */
const collectExits = (parts: {
  console: Record<string, unknown>;
  bridge?: MockBridge | null;
  callbacks?: Record<string, unknown>;
  rendered?: unknown;
}): Record<string, unknown> => {
  const mocks: Record<string, unknown> = {
    "toast.error": h.toastError,
    "toast.success": h.toastSuccess,
    "toast.warning": h.toastWarning,
    confirm: h.confirm,
    ...parts.console,
    ...parts.callbacks,
  };
  for (const [name, fn] of Object.entries(parts.bridge ?? {})) {
    if (name !== "setCredential") mocks[`bridge.${name}`] = fn;
  }
  const exits: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(mocks)) {
    // 不是 mock 就没法看它收到过什么：直接报错，别悄悄当成「没泄漏」
    if (!vi.isMockFunction(fn)) throw new Error(`出口「${name}」不是 mock，没法检查它收到过什么`);
    exits[name] = fn.mock.calls;
  }
  if (parts.rendered !== undefined) exits["渲染出来的界面"] = renderedStrings(parts.rendered);
  return exits;
};

/** 每个出口都不能出现密码；报错里带出口名，一眼看出漏在哪 */
const expectNoLeak = (exits: Record<string, unknown>): void => {
  for (const [name, received] of Object.entries(exits)) {
    expect(JSON.stringify(received) ?? "", `开机密码泄漏到了「${name}」`).not.toContain(SECRET);
  }
};

describe("泄漏探测器自检：往每一类出口里真塞一次密码，都能被抓出来（探测器失灵的话，其它「没泄漏」的断言全是空的）", () => {
  let watched: Record<string, unknown> = {};
  beforeEach(() => {
    watched = watchConsole();
  });

  const exitsOf = (bridge: MockBridge, callbacks: Record<string, unknown> = {}, rendered?: unknown) =>
    collectExits({ console: watched, bridge, callbacks, rendered });

  it("SECRET 里没有 JSON 会转义的字符：序列化之后原文还在", () => {
    expect(JSON.stringify(SECRET)).toBe(`"${SECRET}"`);
    expect(JSON.stringify([[{ deep: `x${SECRET}y` }]])).toContain(SECRET);
  });

  it("干净的现场：什么都没发生 → 不报泄漏；setCredential 收到密码是被允许的，不算泄漏", () => {
    const bridge = makeBridge();
    void bridge.setCredential({ password: SECRET });
    expect(() => expectNoLeak(exitsOf(bridge))).not.toThrow();
  });

  it.each([
    ["toast.error", () => h.toastError(`保存失败：${SECRET}`)],
    ["toast.success", () => h.toastSuccess(`已保存 ${SECRET}`)],
    ["toast.warning", () => h.toastWarning(`已保存，但 ${SECRET}`)],
    ["confirm", () => h.confirm({ title: "确认", description: SECRET })],
    ["嵌套在对象 / 数组深处", () => h.toastError({ a: [[{ b: `前缀${SECRET}后缀` }]] })],
    ...CONSOLE_METHODS.map((method) => [`console.${method}`, () => console[method]("saving", SECRET)] as const),
  ] as Array<readonly [string, () => unknown]>)("出口 %s 收到密码 → 被抓出来，并指明是哪个出口", (name, plant) => {
    plant();
    const expected = name === "嵌套在对象 / 数组深处" ? "toast.error" : name;
    expect(() => expectNoLeak(exitsOf(makeBridge()))).toThrow(`开机密码泄漏到了「${expected}」`);
  });

  it("桥上除 setCredential 之外的每个方法收到密码 → 都被抓出来（逐个方法试，不是只试一个）", async () => {
    const names = Object.keys(makeBridge()).filter((name) => name !== "setCredential");
    expect(names.length).toBeGreaterThanOrEqual(9);
    for (const name of names) {
      const bridge = makeBridge();
      await (bridge as unknown as Record<string, (...a: unknown[]) => unknown>)[name]?.({ password: SECRET });
      expect(() => expectNoLeak(exitsOf(bridge)), name).toThrow(`开机密码泄漏到了「bridge.${name}」`);
    }
  });

  it("调用方传进来的回调收到密码 → 被抓出来", () => {
    const refresh = vi.fn<(secret: string) => void>();
    refresh(SECRET);
    expect(() => expectNoLeak(exitsOf(makeBridge(), { refresh }))).toThrow("开机密码泄漏到了「refresh」");
  });

  it("渲染出来的界面（文字 / 字符串属性，含嵌在数组里的）里出现密码 → 被抓出来", () => {
    const leakyText = createElement("p", null, `密码是 ${SECRET}`);
    const leakyProp = createElement("input", { value: SECRET });
    const leakyInArray = createElement("div", { items: ["a", SECRET] });
    for (const tree of [leakyText, leakyProp, leakyInArray]) {
      expect(() => expectNoLeak(exitsOf(makeBridge(), {}, tree))).toThrow("开机密码泄漏到了「渲染出来的界面」");
    }
    expect(() => expectNoLeak(exitsOf(makeBridge(), {}, createElement("p", null, "没有密码")))).not.toThrow();
  });

  it("出口不是 mock → 直接报错，不当成「没泄漏」", () => {
    expect(() => collectExits({ console: watched, callbacks: { plain: () => undefined } })).toThrow("不是 mock");
  });
});

describe("saveCredentialFlow：保存开机密码", () => {
  let watched: Record<string, unknown> = {};
  beforeEach(() => {
    watched = watchConsole();
  });

  const run = (over: Partial<Parameters<typeof saveCredentialFlow>[0]> = {}) => {
    const bridge = makeBridge();
    const writeLockedAccess = vi.fn<(next: boolean) => Promise<void>>(async () => undefined);
    const refresh = vi.fn<() => Promise<void>>(async () => undefined);
    const args = {
      bridge,
      password: SECRET,
      enableAfterSave: false,
      writeLockedAccess,
      refresh,
      ...over,
    };
    return {
      bridge,
      writeLockedAccess,
      refresh,
      done: saveCredentialFlow(args),
      /** 此刻所有出口收到过的东西（桥取实际传给流程的那一个：用例可能换了桥） */
      exits: () =>
        collectExits({
          console: watched,
          bridge: args.bridge as MockBridge | null,
          callbacks: { writeLockedAccess: args.writeLockedAccess, refresh: args.refresh },
        }),
    };
  };

  it("成功（开启流程）：密码只经 setCredential 单向交出 → 再写开关 → 刷新；返回 true", async () => {
    const r = run({ enableAfterSave: true });
    expect(await r.done).toBe(true);
    expect(r.bridge.setCredential).toHaveBeenCalledExactlyOnceWith({ password: SECRET });
    expect(r.writeLockedAccess).toHaveBeenCalledExactlyOnceWith(true);
    expect(r.refresh).toHaveBeenCalledTimes(1);
    // 顺序：先保存密码，保存成功才写开关，最后刷新
    const order = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0];
    expect(order(r.bridge.setCredential)).toBeLessThan(order(r.writeLockedAccess));
    expect(order(r.writeLockedAccess)).toBeLessThan(order(r.refresh));
    expectNoLeak(r.exits());
  });

  it("成功（单纯保存 / 修改）：不动开关，只刷新", async () => {
    const r = run({ enableAfterSave: false });
    expect(await r.done).toBe(true);
    expect(r.bridge.setCredential).toHaveBeenCalledExactlyOnceWith({ password: SECRET });
    expect(r.writeLockedAccess).not.toHaveBeenCalled();
    expect(r.refresh).toHaveBeenCalledTimes(1);
    expectNoLeak(r.exits());
  });

  it("主进程返回 ok:false：toast 原因，开关一个字不动、不刷新；返回 false", async () => {
    const bridge = makeBridge();
    bridge.setCredential.mockResolvedValueOnce({ ok: false, error: "钥匙串写入失败" });
    const r = run({ bridge, enableAfterSave: true });
    expect(await r.done).toBe(false);
    expect(h.toastError).toHaveBeenCalledExactlyOnceWith("钥匙串写入失败");
    expect(r.writeLockedAccess).not.toHaveBeenCalled();
    expect(r.refresh).not.toHaveBeenCalled();
    expectNoLeak(r.exits());
  });

  it("主进程返回 ok:false 但没带原因 → 兜底「保存失败」", async () => {
    const bridge = makeBridge();
    bridge.setCredential.mockResolvedValueOnce({ ok: false, error: "  " });
    const r = run({ bridge });
    expect(await r.done).toBe(false);
    expect(h.toastError).toHaveBeenCalledExactlyOnceWith("保存失败");
    expectNoLeak(r.exits());
  });

  it("桥抛错：toast「保存失败：原因」，开关不动；返回 false，原因里不带密码", async () => {
    const bridge = makeBridge();
    bridge.setCredential.mockRejectedValueOnce(new Error("IPC 断开"));
    const r = run({ bridge, enableAfterSave: true });
    expect(await r.done).toBe(false);
    expect(h.toastError).toHaveBeenCalledExactlyOnceWith("保存失败：IPC 断开");
    expect(r.writeLockedAccess).not.toHaveBeenCalled();
    expectNoLeak(r.exits());
  });

  it("报错文字里万一回显了密码（主进程 ok:false 的 error / 桥抛的 Error / 出现好几次）：toast 里抹成「•••」，原文不出现在任何出口", async () => {
    // 主进程 / IPC 层的报错本不该带密码；这条守的是「万一哪天带了」——toast 会被截图 / 录屏，这是整台电脑的登录密码
    const cases: Array<[string, (bridge: MockBridge) => void, string]> = [
      ["ok:false 的 error", (b) => b.setCredential.mockResolvedValueOnce({ ok: false, error: `密码 ${SECRET} 里有不支持的字符` }), "密码 ••• 里有不支持的字符"],
      ["桥抛的 Error", (b) => b.setCredential.mockRejectedValueOnce(new Error(`IPC 报错，入参 ${SECRET}`)), "保存失败：IPC 报错，入参 •••"],
      ["同一条里出现两次", (b) => b.setCredential.mockResolvedValueOnce({ ok: false, error: `${SECRET} 不合法（${SECRET}）` }), "••• 不合法（•••）"],
    ];
    for (const [name, arrange, expected] of cases) {
      h.toastError.mockReset();
      const bridge = makeBridge();
      arrange(bridge);
      const r = run({ bridge, enableAfterSave: true });
      expect(await r.done, name).toBe(false);
      expect(h.toastError, name).toHaveBeenCalledExactlyOnceWith(expected);
      expect(r.writeLockedAccess, name).not.toHaveBeenCalled();
      expectNoLeak(r.exits());
    }
  });

  it("没有桥：直接 false，什么都不做", async () => {
    const r = run({ bridge: null });
    expect(await r.done).toBe(false);
    expect(h.toastError).not.toHaveBeenCalled();
    expect(r.writeLockedAccess).not.toHaveBeenCalled();
    expectNoLeak(r.exits());
  });

  it("密码存好了但开关没写进去（写开关返回 false）：返回 false（对话框因此留着、用户能再点「保存」重试），明说「密码已保存、开关没打开」；仍刷新让状态里看到「已保存」", async () => {
    const write = vi.fn<(next: boolean) => Promise<unknown>>(async () => false);
    const r = run({ enableAfterSave: true, writeLockedAccess: write });
    expect(await r.done).toBe(false);
    expect(r.bridge.setCredential).toHaveBeenCalledExactlyOnceWith({ password: SECRET });
    expect(write).toHaveBeenCalledExactlyOnceWith(true);
    expect(h.toastError).toHaveBeenCalledExactlyOnceWith(CREDENTIAL_SAVED_SWITCH_FAILED);
    expect(r.refresh).toHaveBeenCalledTimes(1);
    expectNoLeak(r.exits());
  });

  it("写开关的回调抛错（不是返回 false）：同样当作没写进去——不往外抛、返回 false、说明照给、仍刷新（否则对话框的「保存中」永远复位不了）", async () => {
    const write = vi.fn<(next: boolean) => Promise<unknown>>(async () => {
      throw new Error("写盘炸了");
    });
    const r = run({ enableAfterSave: true, writeLockedAccess: write });
    await expect(r.done).resolves.toBe(false);
    expect(write).toHaveBeenCalledExactlyOnceWith(true);
    expect(h.toastError).toHaveBeenCalledExactlyOnceWith(CREDENTIAL_SAVED_SWITCH_FAILED);
    expect(r.refresh).toHaveBeenCalledTimes(1);
    expectNoLeak(r.exits());
  });

  it("刷新抛错也不外抛（刷新失败不影响已经做完的保存）：成功路径与开关没写进去的路径都一样", async () => {
    const boom = vi.fn<() => Promise<void>>(async () => {
      throw new Error("刷新炸了");
    });
    await expect(run({ enableAfterSave: false, refresh: boom }).done).resolves.toBe(true);
    await expect(run({ enableAfterSave: true, refresh: boom, writeLockedAccess: vi.fn(async () => false) }).done).resolves.toBe(false);
    expect(boom).toHaveBeenCalledTimes(2);
  });

  it("只有明确的 false 才算没写进去：没有返回值 / true / 别的值都按成功（写开关的回调不一定是 saveFieldValue）", async () => {
    for (const ret of [undefined, true, "ok", 0, null]) {
      h.toastError.mockReset();
      const r = run({ enableAfterSave: true, writeLockedAccess: vi.fn(async () => ret) });
      expect(await r.done, String(ret)).toBe(true);
      expect(h.toastError, String(ret)).not.toHaveBeenCalled();
      expectNoLeak(r.exits());
    }
  });

  it("单纯保存 / 修改（不写开关）：用不着开关的结果，写开关的回调根本不会被调用", async () => {
    const write = vi.fn<(next: boolean) => Promise<unknown>>(async () => false);
    const r = run({ enableAfterSave: false, writeLockedAccess: write });
    expect(await r.done).toBe(true);
    expect(write).not.toHaveBeenCalled();
    expect(h.toastError).not.toHaveBeenCalled();
    expectNoLeak(r.exits());
  });

  // 第四轮评审（B1）：Windows 保存开机密码时，上一次自动解锁失败留下的冷却记录没清掉 → 主进程回 { ok:false, saved:true, error }：
  // 密码其实已经存好了。当「保存失败」处理的话，对话框不关、用户以为没存上、又输一遍
  describe("主进程说「密码已经存好了」（ok:false + saved:true）：按已保存处理，error 当提示、不当失败", () => {
    /** 主进程真实产出的那句话（含分钟数）：展示的就是它，前端不截断、不改写 */
    const NOTE = describeSetFailure({ code: "COOLDOWN_NOT_CLEARED", fields: { wait: "540" } }, "兜底");
    const SAVED_NOTE_FALLBACK = "开机密码已经保存好了，但保存后还有一步收尾没做成，自动解锁可能暂时用不了";
    const savedWith = (error?: string) => {
      const bridge = makeBridge();
      bridge.setCredential.mockResolvedValueOnce({ ok: false, saved: true, ...(error === undefined ? {} : { error }) });
      return bridge;
    };
    const order = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0];

    it("前提：真实文案确实写明「已经保存好了」和要等多久（别拿一句空话当测试数据）", () => {
      expect(NOTE).toContain("开机密码已经保存好了");
      expect(NOTE).toContain("约 9 分钟后恢复");
    });

    it("单纯保存：返回 true（对话框因此关闭）、刷新；error 作警告展示（长文案留 10 秒），不弹「保存失败」", async () => {
      const r = run({ bridge: savedWith(NOTE), enableAfterSave: false });
      expect(await r.done).toBe(true);
      expect(h.toastWarning).toHaveBeenCalledExactlyOnceWith(NOTE, { duration: 10_000 });
      expect(h.toastError).not.toHaveBeenCalled();
      expect(r.writeLockedAccess).not.toHaveBeenCalled();
      expect(r.refresh).toHaveBeenCalledTimes(1);
      expectNoLeak(r.exits());
    });

    it("开启流程：密码已存好，照样写开关（不能因为附带提示就让用户再点一次）；顺序：先保存、再写开关、最后刷新", async () => {
      const bridge = savedWith(NOTE); // run() 返回的 bridge 是它内部新建的那个，顺序要对着传进去的桥看
      const r = run({ bridge, enableAfterSave: true });
      expect(await r.done).toBe(true);
      expect(r.writeLockedAccess).toHaveBeenCalledExactlyOnceWith(true);
      expect(h.toastWarning).toHaveBeenCalledExactlyOnceWith(NOTE, { duration: 10_000 });
      expect(h.toastError).not.toHaveBeenCalled();
      expect(r.refresh).toHaveBeenCalledTimes(1);
      expect(order(bridge.setCredential)).toBeLessThan(order(r.writeLockedAccess));
      expect(order(r.writeLockedAccess)).toBeLessThan(order(r.refresh));
      expectNoLeak(r.exits());
    });

    it("开启流程里开关没写进去：返回 false（对话框留着、可重试）；「密码已存好」的警告与「开关没打开」的说明都给，仍刷新", async () => {
      const write = vi.fn<(next: boolean) => Promise<unknown>>(async () => false);
      const r = run({ bridge: savedWith(NOTE), enableAfterSave: true, writeLockedAccess: write });
      expect(await r.done).toBe(false);
      expect(h.toastWarning).toHaveBeenCalledExactlyOnceWith(NOTE, { duration: 10_000 });
      expect(h.toastError).toHaveBeenCalledExactlyOnceWith(CREDENTIAL_SAVED_SWITCH_FAILED);
      expect(r.refresh).toHaveBeenCalledTimes(1);
      expectNoLeak(r.exits());
    });

    it("没带原因（error 缺省 / 空白）：兜底成一句「已保存」的警告，不是空白 toast、更不是「保存失败」", async () => {
      for (const error of [undefined, "", "   "]) {
        h.toastWarning.mockReset();
        const r = run({ bridge: savedWith(error) });
        expect(await r.done, String(error)).toBe(true);
        expect(h.toastWarning, String(error)).toHaveBeenCalledExactlyOnceWith(SAVED_NOTE_FALLBACK, { duration: 10_000 });
        expect(h.toastError, String(error)).not.toHaveBeenCalled();
      }
    });

    it("error 里万一回显了密码：警告里抹成「•••」，原文不出现在任何出口（toast 会被截图 / 录屏）", async () => {
      const r = run({ bridge: savedWith(`已保存 ${SECRET}，但收尾没做成（${SECRET}）`), enableAfterSave: true });
      expect(await r.done).toBe(true);
      expect(h.toastWarning).toHaveBeenCalledExactlyOnceWith("已保存 •••，但收尾没做成（•••）", { duration: 10_000 });
      expectNoLeak(r.exits());
    });

    it("只有 saved === true 才算「已存好」：false / 缺省 / \"true\" / 1 仍按失败处理——error toast、开关不动、不刷新、返回 false", async () => {
      const cases: Array<[string, unknown]> = [
        ["false", false],
        ["缺省", undefined],
        ['"true"', "true"],
        ["1", 1],
      ];
      for (const [name, saved] of cases) {
        h.toastError.mockReset();
        h.toastWarning.mockReset();
        const bridge = makeBridge();
        bridge.setCredential.mockResolvedValueOnce({ ok: false, saved, error: "钥匙串写入失败" } as never);
        const r = run({ bridge, enableAfterSave: true });
        expect(await r.done, name).toBe(false);
        expect(h.toastError, name).toHaveBeenCalledExactlyOnceWith("钥匙串写入失败");
        expect(h.toastWarning, name).not.toHaveBeenCalled();
        expect(r.writeLockedAccess, name).not.toHaveBeenCalled();
        expect(r.refresh, name).not.toHaveBeenCalled();
        expectNoLeak(r.exits());
      }
    });
  });
});

describe("disableLockedAccessFlow：关掉「锁屏时也能用」并清掉钥匙串里的开机密码", () => {
  const run = (over: Partial<Parameters<typeof disableLockedAccessFlow>[0]> = {}) => {
    const bridge = makeBridge();
    const writeLockedAccess = vi.fn<(next: boolean) => Promise<unknown>>(async () => true);
    const refresh = vi.fn<() => Promise<void>>(async () => undefined);
    const args = { bridge, switchIsOn: true, hasCredential: true, writeLockedAccess, refresh, ...over };
    return { bridge: args.bridge as MockBridge | null, writeLockedAccess, refresh, done: disableLockedAccessFlow(args) };
  };
  const ord = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0] ?? Number.NaN;

  it("正常：先写开关为关，再清钥匙串，提示已清除，最后刷新", async () => {
    const r = run();
    await r.done;
    expect(r.writeLockedAccess).toHaveBeenCalledExactlyOnceWith(false);
    expect(r.bridge?.clearCredential).toHaveBeenCalledTimes(1);
    expect(h.toastSuccess).toHaveBeenCalledExactlyOnceWith("已清除保存的开机密码");
    expect(h.toastError).not.toHaveBeenCalled();
    expect(r.refresh).toHaveBeenCalledTimes(1);
    expect(ord(r.writeLockedAccess)).toBeLessThan(ord(r.bridge!.clearCredential));
    expect(ord(r.bridge!.clearCredential)).toBeLessThan(ord(r.refresh));
  });

  it("开关写不进去（saveFieldValue 返回 false）：落盘的开关还开着，所以不清密码、不报成功；明说「还没有关掉」（界面上开关已被乐观地显示成关），再刷新", async () => {
    const r = run({ writeLockedAccess: vi.fn(async () => false) });
    await r.done;
    expect(r.bridge?.clearCredential).not.toHaveBeenCalled();
    expect(h.toastSuccess).not.toHaveBeenCalled();
    // 通用的「保存失败」是 saveFieldValue 自己弹的；这里补的是后果——写入成功之前它仍然有效、密码为什么还留着
    expect(h.toastError).toHaveBeenCalledExactlyOnceWith(LOCKED_OFF_FAILED);
    expect(r.refresh).toHaveBeenCalledTimes(1);
  });

  it("写开关的回调抛错同样当没写进去：不往外抛、不清密码、说明照给、仍刷新", async () => {
    const r = run({
      writeLockedAccess: vi.fn(async () => {
        throw new Error("写盘炸了");
      }),
    });
    await expect(r.done).resolves.toBeUndefined();
    expect(r.bridge?.clearCredential).not.toHaveBeenCalled();
    expect(h.toastSuccess).not.toHaveBeenCalled();
    expect(h.toastError).toHaveBeenCalledExactlyOnceWith(LOCKED_OFF_FAILED);
    expect(r.refresh).toHaveBeenCalledTimes(1);
  });

  it("刷新抛错也不往外抛（开关已经写成关、密码已经清了，刷新只是让界面跟上）", async () => {
    const r = run({
      refresh: vi.fn(async () => {
        throw new Error("刷新炸了");
      }),
    });
    await expect(r.done).resolves.toBeUndefined();
    expect(r.bridge?.clearCredential).toHaveBeenCalledTimes(1);
  });

  it("写开关返回 undefined / true 都按成功处理（只有明确的 false 才算失败）", async () => {
    for (const ret of [undefined, true, "ok"]) {
      h.toastSuccess.mockReset();
      const r = run({ writeLockedAccess: vi.fn(async () => ret) });
      await r.done;
      expect(r.bridge?.clearCredential, String(ret)).toHaveBeenCalledTimes(1);
    }
  });

  it("没存密码：只关开关，不碰钥匙串、不提示", async () => {
    const r = run({ hasCredential: false });
    await r.done;
    expect(r.writeLockedAccess).toHaveBeenCalledExactlyOnceWith(false);
    expect(r.bridge?.clearCredential).not.toHaveBeenCalled();
    expect(h.toastSuccess).not.toHaveBeenCalled();
    expect(r.refresh).toHaveBeenCalledTimes(1);
  });

  it("开关本来就关着（switchIsOn=false，总开关关闭时的情形）：不写设置，只清密码", async () => {
    const r = run({ switchIsOn: false });
    await r.done;
    expect(r.writeLockedAccess).not.toHaveBeenCalled();
    expect(r.bridge?.clearCredential).toHaveBeenCalledTimes(1);
    expect(h.toastSuccess).toHaveBeenCalledExactlyOnceWith("已清除保存的开机密码");
  });

  it("清钥匙串失败（主进程回 ok:false）：开关已经关了不回滚，如实告诉用户密码还留着以及怎么处理，不报成功", async () => {
    const bridge = makeBridge();
    bridge.clearCredential.mockResolvedValueOnce({ ok: false, error: "钥匙串被锁定" });
    const r = run({ bridge });
    await r.done;
    expect(r.writeLockedAccess).toHaveBeenCalledExactlyOnceWith(false); // 只写过那一次关
    expect(h.toastSuccess).not.toHaveBeenCalled();
    expect(h.toastError).toHaveBeenCalledExactlyOnceWith(
      "已关闭「锁屏时也能用」，但开机密码没能清除：钥匙串被锁定。可以稍后点「清除」再试",
    );
    expect(r.refresh).toHaveBeenCalledTimes(1);
  });

  it("清钥匙串时桥抛错：同样如实报告（带原因）", async () => {
    const bridge = makeBridge();
    bridge.clearCredential.mockRejectedValueOnce(new Error("IPC 断开"));
    const r = run({ bridge });
    await r.done;
    expect(h.toastError).toHaveBeenCalledTimes(1);
    expect(h.toastError.mock.calls[0]?.[0]).toContain("IPC 断开");
    expect(h.toastSuccess).not.toHaveBeenCalled();
    expect(r.refresh).toHaveBeenCalledTimes(1);
  });

  it("没有桥（网页版）：只写开关，没法清也不报错", async () => {
    const r = run({ bridge: null });
    await r.done;
    expect(r.writeLockedAccess).toHaveBeenCalledExactlyOnceWith(false);
    expect(h.toastError).not.toHaveBeenCalled();
    expect(h.toastSuccess).not.toHaveBeenCalled();
    expect(r.refresh).toHaveBeenCalledTimes(1);
  });

  // 第四轮评审（B2）：写开关要等落盘（慢时秒级、失败还会重试），清密码排在它后面——期间用户的新动作不能被这次清除碾过去
  it("shouldClear：写开关等了一阵，回来时用户已经又动过（返回 false）→ 不清密码、不报「已清除」，仍刷新；放行（true）照清", async () => {
    // 守卫在写盘「之后」才被问到：写盘还在路上时翻转它，回来的那一刻读到的才是新值（在写盘之前问就测不出时机）
    const slow = deferred<boolean>();
    const write = vi.fn<(next: boolean) => Promise<unknown>>(() => slow.promise);
    let stale = false;
    const r = run({ writeLockedAccess: write, shouldClear: () => !stale });
    await flush();
    expect(r.bridge?.clearCredential, "写盘还没回来：还没轮到清").not.toHaveBeenCalled();
    stale = true; // 写盘期间用户又开了开关 / 存了新密码
    slow.resolve(true);
    await r.done;
    expect(write).toHaveBeenCalledExactlyOnceWith(false);
    expect(r.bridge?.clearCredential).not.toHaveBeenCalled();
    expect(h.toastSuccess).not.toHaveBeenCalled();
    expect(h.toastError).not.toHaveBeenCalled();
    expect(r.refresh).toHaveBeenCalledTimes(1);

    // 对照：守卫放行 → 照清
    const ok = run({ shouldClear: () => true });
    await ok.done;
    expect(ok.bridge?.clearCredential).toHaveBeenCalledTimes(1);
  });
});

describe("ComputerUseView 交互接线", () => {
  let watched: Record<string, unknown> = {};
  beforeEach(() => {
    watched = watchConsole();
  });

  /** 用槽位桩渲染 View：setState（如打开对话框）之后再 render 一次就能看到 */
  const mountView = (over: Partial<Omit<ViewProps, "bridge">> = {}) => {
    const bridge = makeBridge();
    const props = viewProps({ bridge, ...over });
    const harness = createHookHarness();
    const render = () => walk(harness.render(() => ComputerUseView(props)));
    const master = () => pick(render(), (el) => el.type === Switch, "总开关");
    // LockedAccessBlock 没导出：靠它独有的 onToggle prop 认出来
    const block = () => pick(render(), (el) => typeof el.props.onToggle === "function", "锁屏区块");
    // CredentialDialog 同理：靠 onSubmit + onClose
    const dialogs = () =>
      render().filter(
        (el) => typeof el.props.onSubmit === "function" && typeof el.props.onClose === "function",
      );
    /** 此刻所有出口收到过的东西：toast / 确认框 / console / 桥（除 setCredential）/ 四个回调 / 当前渲染出来的界面 */
    const exits = () =>
      collectExits({
        console: watched,
        bridge,
        callbacks: {
          onEnabledChange: props.onEnabledChange,
          onLockedAccessChange: props.onLockedAccessChange,
          onStatus: props.onStatus,
          onRefresh: props.onRefresh,
        },
        rendered: render(),
      });
    /** 跑登记的 effect（开关暂存的「主进程追上来了就收起 / 宽限到点收起」都靠它们）；换状态要先改 props.status 再 render + flushEffects */
    const flushEffects = () => harness.flushEffects();
    return { bridge, props, render, master, block, dialogs, exits, flushEffects, unmount: () => harness.unmount() };
  };

  const order = (fn: { mock: { invocationCallOrder: number[] } }) =>
    fn.mock.invocationCallOrder[0] ?? Number.NaN;

  it("总开关（关 → 开）：先弹风险确认（固定文案，默认聚焦取消）；确认后写设置（等落盘结束），再刷新主进程状态", async () => {
    const gate = deferred();
    const onEnabledChange = vi.fn<(next: boolean) => Promise<void>>(() => gate.promise);
    const onRefresh = vi.fn();
    const v = mountView({ enabled: false, onEnabledChange, onRefresh });
    h.confirm.mockResolvedValue(true);

    call(v.master(), "onCheckedChange", true);
    await flush();
    expect(h.confirm).toHaveBeenCalledExactlyOnceWith({
      title: "开启电脑操作",
      description: ENABLE_CONFIRM_TEXT,
      confirmLabel: "开启",
      defaultFocus: "cancel",
    });
    expect(onEnabledChange).toHaveBeenCalledExactlyOnceWith(true);
    expect(onRefresh).not.toHaveBeenCalled(); // 落盘还没结束，主进程拿到的还是旧设置

    gate.resolve();
    await flush();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("总开关（关 → 开）：确认框点取消 → 开关一个字不动、不刷新", async () => {
    const onEnabledChange = vi.fn<(next: boolean) => Promise<void>>(async () => undefined);
    const onRefresh = vi.fn();
    const v = mountView({ enabled: false, onEnabledChange, onRefresh });
    h.confirm.mockResolvedValue(false);

    call(v.master(), "onCheckedChange", true);
    await flush();
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(onEnabledChange).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("总开关（开 → 关）：不弹确认，直接写 false 再刷新；锁屏开关本来就关着 → 不动密码", async () => {
    const onEnabledChange = vi.fn<(next: boolean) => Promise<void>>(async () => undefined);
    const onLockedAccessChange = vi.fn<(next: boolean) => Promise<void>>(async () => undefined);
    const onRefresh = vi.fn();
    // 密码是用户自己存的（锁屏开关没开）：关总开关不该替他删
    const v = mountView({
      enabled: true,
      lockedAccess: false,
      status: makeStatus({ credentialSet: true }),
      onEnabledChange,
      onLockedAccessChange,
      onRefresh,
    });

    call(v.master(), "onCheckedChange", false);
    await flush();
    expect(h.confirm).not.toHaveBeenCalled();
    expect(onEnabledChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(onLockedAccessChange).not.toHaveBeenCalled();
    expect(v.bridge.clearCredential).not.toHaveBeenCalled();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("总开关（开 → 关）且「锁屏时也能用」开着：总开关先关 → 锁屏开关一并关 → 钥匙串里的开机密码清掉 → 刷新", async () => {
    const onEnabledChange = vi.fn<(next: boolean) => Promise<void>>(async () => undefined);
    const onLockedAccessChange = vi.fn<(next: boolean) => Promise<void>>(async () => undefined);
    const onRefresh = vi.fn();
    const v = mountView({
      enabled: true,
      lockedAccess: true,
      status: makeStatus({ credentialSet: true, lockedAccessEnabled: true }),
      onEnabledChange,
      onLockedAccessChange,
      onRefresh,
    });

    call(v.master(), "onCheckedChange", false);
    await flush();
    expect(onEnabledChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(onLockedAccessChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(v.bridge.clearCredential).toHaveBeenCalledTimes(1);
    expect(h.toastSuccess).toHaveBeenCalledExactlyOnceWith("已清除保存的开机密码");
    expect(order(onEnabledChange)).toBeLessThan(order(onLockedAccessChange));
    expect(order(onLockedAccessChange)).toBeLessThan(order(v.bridge.clearCredential));
    // 总开关写完刷新一次，锁屏收尾又刷新一次：最后一次刷新在清密码之后
    expect(onRefresh).toHaveBeenCalledTimes(2);
    expect(order(v.bridge.clearCredential)).toBeLessThan(onRefresh.mock.invocationCallOrder.at(-1) ?? Number.NaN);
  });

  it("总开关（开 → 关）且锁屏开关开着但没存密码：只关开关，不碰钥匙串", async () => {
    const onLockedAccessChange = vi.fn<(next: boolean) => Promise<void>>(async () => undefined);
    const v = mountView({
      enabled: true,
      lockedAccess: true,
      status: makeStatus({ credentialSet: false }),
      onLockedAccessChange,
    });
    call(v.master(), "onCheckedChange", false);
    await flush();
    expect(onLockedAccessChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(v.bridge.clearCredential).not.toHaveBeenCalled();
    expect(h.toastSuccess).not.toHaveBeenCalled();
  });

  describe("设置写不进去（saveFieldValue 失败返回 false）：它是乐观更新——界面开关已是用户想要的样子，落盘的仍是旧值，要明说实际状态", () => {
    it("总开关（开 → 关）没写进去：明说「还没有关掉、AI 仍可操作」；联动清理照做（只收窄权限）——锁屏开关关掉、密码清掉", async () => {
      const onEnabledChange = vi.fn<(next: boolean) => Promise<unknown>>(async () => false);
      const onLockedAccessChange = vi.fn<(next: boolean) => Promise<unknown>>(async () => true);
      const v = mountView({
        enabled: true,
        lockedAccess: true,
        status: makeStatus({ credentialSet: true, lockedAccessEnabled: true }),
        onEnabledChange,
        onLockedAccessChange,
      });
      call(v.master(), "onCheckedChange", false);
      await flush();
      expect(h.toastError).toHaveBeenCalledExactlyOnceWith(ENABLED_OFF_FAILED);
      expect(onLockedAccessChange).toHaveBeenCalledExactlyOnceWith(false);
      expect(v.bridge.clearCredential).toHaveBeenCalledTimes(1);
      expect(h.toastSuccess).toHaveBeenCalledExactlyOnceWith("已清除保存的开机密码");
      // 先说总开关没关成，再做联动（顺序：说明在前、清理在后）
      expect(h.toastError.mock.invocationCallOrder[0]).toBeLessThan(order(onLockedAccessChange));
    });

    it("总开关、锁屏开关都没写进去：两条各自的说明，密码留着（落盘的锁屏开关还开着，清了会出「开着但没密码」）", async () => {
      const onEnabledChange = vi.fn<(next: boolean) => Promise<unknown>>(async () => false);
      const onLockedAccessChange = vi.fn<(next: boolean) => Promise<unknown>>(async () => false);
      const v = mountView({
        enabled: true,
        lockedAccess: true,
        status: makeStatus({ credentialSet: true, lockedAccessEnabled: true }),
        onEnabledChange,
        onLockedAccessChange,
      });
      call(v.master(), "onCheckedChange", false);
      await flush();
      expect(h.toastError.mock.calls.map((c) => c[0])).toEqual([ENABLED_OFF_FAILED, LOCKED_OFF_FAILED]);
      expect(v.bridge.clearCredential).not.toHaveBeenCalled();
      expect(h.toastSuccess).not.toHaveBeenCalled();
    });

    it("总开关写成功（含没有返回值）：不说「没关掉」", async () => {
      for (const ret of [undefined, true]) {
        h.toastError.mockReset();
        const v = mountView({ enabled: true, onEnabledChange: vi.fn(async () => ret) });
        call(v.master(), "onCheckedChange", false);
        await flush();
        expect(h.toastError, String(ret)).not.toHaveBeenCalled();
      }
    });

    it("锁屏开关（开 → 关）没写进去：说明还没关、密码不清；开启方向没写进去只有通用的「保存失败」（功能没生效是安全方向），这里不重复说", async () => {
      const onLockedAccessChange = vi.fn<(next: boolean) => Promise<unknown>>(async () => false);
      const onRefresh = vi.fn();
      const v = mountView({
        lockedAccess: true,
        status: makeStatus({ credentialSet: true, lockedAccessEnabled: true }),
        onLockedAccessChange,
        onRefresh,
      });
      call(v.block(), "onToggle", false);
      await flush();
      expect(h.toastError).toHaveBeenCalledExactlyOnceWith(LOCKED_OFF_FAILED);
      expect(v.bridge.clearCredential).not.toHaveBeenCalled();
      expect(onRefresh).toHaveBeenCalledTimes(1);

      h.toastError.mockReset();
      call(v.block(), "onToggle", true);
      await flush();
      expect(onLockedAccessChange).toHaveBeenLastCalledWith(true);
      expect(h.toastError).not.toHaveBeenCalled();
      expect(onRefresh).toHaveBeenCalledTimes(2); // 开启方向也照常刷新
    });

    it("总开关（关 → 开）没写进去：只有通用的「保存失败」，卡片不重复说，照常刷新", async () => {
      const onEnabledChange = vi.fn<(next: boolean) => Promise<unknown>>(async () => false);
      const onRefresh = vi.fn();
      const v = mountView({ enabled: false, onEnabledChange, onRefresh });
      h.confirm.mockResolvedValue(true);
      call(v.master(), "onCheckedChange", true);
      await flush();
      expect(onEnabledChange).toHaveBeenCalledExactlyOnceWith(true);
      expect(h.toastError).not.toHaveBeenCalled();
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it("开启流程里密码存好了、开关没写进去：onSubmit 返回 false（对话框不关），明说原因；密码不进任何出口", async () => {
      const onLockedAccessChange = vi.fn<(next: boolean) => Promise<unknown>>(async () => false);
      const v = mountView({ status: makeStatus({ credentialSet: false }), onLockedAccessChange });
      call(v.block(), "onToggle", true);
      const dialog = pick(v.dialogs(), () => true, "对话框");
      expect(await call(dialog, "onSubmit", SECRET)).toBe(false);
      expect(v.bridge.setCredential).toHaveBeenCalledExactlyOnceWith({ password: SECRET });
      expect(onLockedAccessChange).toHaveBeenCalledExactlyOnceWith(true);
      expect(h.toastError).toHaveBeenCalledTimes(1);
      expect(h.toastError.mock.calls[0]?.[0]).toContain("开机密码已保存，但「锁屏时也能用」没能打开");
      expect(v.dialogs()).toHaveLength(1); // 流程没叫关对话框（对话框自己只在 onSubmit 返回 true 时才关）
      expectNoLeak(v.exits());
      // 用户按提示再点一次「保存」：这次写成功 → true
      onLockedAccessChange.mockResolvedValueOnce(true);
      expect(await call(pick(v.dialogs(), () => true, "对话框"), "onSubmit", SECRET)).toBe(true);
    });
  });

  describe("开关暂存（pending）：点完先按目标值显示；主进程追上来 / 写盘失败 / 宽限到点后按实际状态显示（第二轮评审 #10）", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** 总开关所在的「电脑操作」行里的说明文字（常驻的对不上说明就在这里） */
    const masterHint = (v: ReturnType<typeof mountView>): string =>
      textOf(pick(v.render(), (el) => el.type === SettingRow && el.props.label === "电脑操作", "电脑操作行").props.hint);

    it("关 → 开：写盘期间显示目标值（主进程状态还是旧的也不弹回）；写盘成功、主进程追上来之后暂存收起（之后按实际状态显示）", async () => {
      const gate = deferred();
      const onEnabledChange = vi.fn<(next: boolean) => Promise<void>>(() => gate.promise);
      const v = mountView({ enabled: false, status: makeStatus({ enabled: false }), onEnabledChange });
      h.confirm.mockResolvedValue(true);

      expect(v.master().props.checked).toBe(false);
      call(v.master(), "onCheckedChange", true);
      await flush();
      expect(onEnabledChange).toHaveBeenCalledExactlyOnceWith(true);
      expect(v.master().props.checked, "写盘还没结束：按用户想要的样子显示").toBe(true);
      expect(masterHint(v)).not.toContain("还没有真正");

      gate.resolve();
      await flush();
      v.props.enabled = true; // 页面的草稿（乐观更新）此刻也是开
      expect(v.master().props.checked, "写盘成功但主进程还没收到：仍按目标值显示（同步这一拍里不弹回）").toBe(true);
      expect(masterHint(v)).not.toContain("还没有真正");

      // 主进程追上来了 → 暂存收起，开关从此显示实际状态
      v.props.status = makeStatus({ enabled: true });
      v.render();
      v.flushEffects();
      expect(v.master().props.checked).toBe(true);
      v.props.status = makeStatus({ enabled: false }); // 之后主进程里被关掉（断连 fail-closed 之类）
      expect(v.master().props.checked, "暂存已收起：不会再卡在「开」").toBe(false);
      expect(masterHint(v)).toContain("「电脑操作」还没有真正开启");
      v.unmount();
    });

    it("开 → 关写盘失败：暂存立刻收起，开关弹回「开」（主进程里确实还开着）+ 常驻说明 + toast；不再显示成已经关了", async () => {
      // 回调先于 mountView 的返回值创建，所以用一个对象引用把挂载结果带回回调里（不用 let：既没有重新赋值，也不提前引用 v）
      const holder: { view?: ReturnType<typeof mountView> } = {};
      const onEnabledChange = vi.fn<(next: boolean) => Promise<unknown>>(async () => {
        if (holder.view) holder.view.props.enabled = false; // saveFieldValue 乐观更新：草稿先变成用户想要的「关」，落盘失败返回 false
        return false;
      });
      const v = mountView({ enabled: true, status: makeStatus({ enabled: true }), onEnabledChange });
      holder.view = v;

      call(v.master(), "onCheckedChange", false);
      await flush();
      expect(h.toastError).toHaveBeenCalledExactlyOnceWith(ENABLED_OFF_FAILED);
      expect(v.master().props.checked, "实际仍开：不能显示成关").toBe(true);
      expect(masterHint(v)).toContain("「电脑操作」还没有真正关掉");
      expect(masterHint(v)).toContain("AI 目前仍可以操作这台电脑");
    });

    it("写开关的回调抛错：同样收起暂存、不产生未处理的异常；按没写进去处理", async () => {
      const onEnabledChange = vi.fn<(next: boolean) => Promise<unknown>>(async () => {
        throw new Error("写盘炸了");
      });
      const v = mountView({ enabled: true, status: makeStatus({ enabled: true }), onEnabledChange });
      call(v.master(), "onCheckedChange", false);
      await flush();
      expect(h.toastError).toHaveBeenCalledExactlyOnceWith(ENABLED_OFF_FAILED);
      expect(v.master().props.checked).toBe(true);
    });

    it("宽限到点（SWITCH_SYNC_GRACE_MS）主进程仍没追上：暂存收起，改按实际状态显示 + 说明；没到点前一直按目标值显示", async () => {
      vi.useFakeTimers();
      const onEnabledChange = vi.fn<(next: boolean) => Promise<void>>(async () => undefined);
      const v = mountView({ enabled: false, status: makeStatus({ enabled: false }), onEnabledChange });
      h.confirm.mockResolvedValue(true);
      call(v.master(), "onCheckedChange", true);
      await vi.advanceTimersByTimeAsync(0);
      expect(onEnabledChange).toHaveBeenCalledExactlyOnceWith(true);
      v.props.enabled = true;
      v.render();
      v.flushEffects(); // 登记宽限定时器
      expect(v.master().props.checked).toBe(true);

      await vi.advanceTimersByTimeAsync(SWITCH_SYNC_GRACE_MS - 1);
      expect(v.master().props.checked, "还没到点").toBe(true);
      expect(masterHint(v)).not.toContain("还没有真正");

      await vi.advanceTimersByTimeAsync(1);
      expect(v.master().props.checked, "到点：按主进程实际状态显示").toBe(false);
      expect(masterHint(v)).toContain("「电脑操作」还没有真正开启");
      v.unmount();
    });

    it("卸载时清掉宽限定时器（不留悬空 timer）", async () => {
      vi.useFakeTimers();
      const v = mountView({ enabled: false, status: makeStatus({ enabled: false }), onEnabledChange: vi.fn(async () => undefined) });
      h.confirm.mockResolvedValue(true);
      call(v.master(), "onCheckedChange", true);
      await vi.advanceTimersByTimeAsync(0);
      v.render();
      v.flushEffects();
      expect(vi.getTimerCount()).toBe(1);
      v.unmount();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("锁屏开关同理：开 → 关写盘失败 → 弹回「开」（主进程里确实还开着），密码不清，toast 照给", async () => {
      const holder: { view?: ReturnType<typeof mountView> } = {};
      const onLockedAccessChange = vi.fn<(next: boolean) => Promise<unknown>>(async () => {
        if (holder.view) holder.view.props.lockedAccess = false;
        return false;
      });
      const v = mountView({
        lockedAccess: true,
        status: makeStatus({ lockedAccessEnabled: true, credentialSet: true }),
        onLockedAccessChange,
      });
      holder.view = v;
      call(v.block(), "onToggle", false);
      await flush();
      expect(h.toastError).toHaveBeenCalledExactlyOnceWith(LOCKED_OFF_FAILED);
      expect(v.bridge.clearCredential).not.toHaveBeenCalled();
      expect(v.block().props.lockedAccess, "实际仍开").toBe(true);
      expect(v.block().props.syncNote).toContain("「锁屏时也能用」还没有真正关掉");
    });

    // 第三轮评审：关锁屏开关没写进去、密码先留着；设置页对 5xx / 网络错误会自动重试，重试成功时开关是在没人经手的情况下关掉的，密码没人清
    describe("关锁屏开关没写进去、密码先留着 → 自动重试成功（主进程确认已关）之后补清密码", () => {
      /** 写开关的回调：saveFieldValue 乐观更新（草稿先变成用户想要的值），落盘失败返回 false */
      const mountOffFailed = (over: Partial<Omit<ViewProps, "bridge">> = {}) => {
        const holder: { view?: ReturnType<typeof mountView> } = {};
        const onLockedAccessChange = vi.fn<(next: boolean) => Promise<unknown>>(async (next) => {
          if (holder.view) holder.view.props.lockedAccess = next;
          return next ? true : false;
        });
        const v = mountView({
          enabled: true,
          lockedAccess: true,
          status: makeStatus({ enabled: true, lockedAccessEnabled: true, credentialSet: true }),
          onLockedAccessChange,
          ...over,
        });
        holder.view = v;
        return { v, onLockedAccessChange };
      };
      /** 让组件按当前 props 重新渲染一轮、跑登记的 effect、等异步的清除结束 */
      const settle = async (v: ReturnType<typeof mountView>) => {
        v.render();
        v.flushEffects();
        await flush();
      };

      it("等主进程确认：草稿已是关、主进程里还开着 → 不清；主进程里关了、密码还在 → 清一次、提示已清除、刷新", async () => {
        const { v } = mountOffFailed();
        call(v.block(), "onToggle", false);
        await flush();
        expect(h.toastError).toHaveBeenCalledExactlyOnceWith(LOCKED_OFF_FAILED);
        expect(v.bridge.clearCredential).not.toHaveBeenCalled();

        await settle(v); // 草稿是关（乐观更新）、主进程里还开着：继续等
        expect(v.bridge.clearCredential).not.toHaveBeenCalled();

        const refreshed = vi.mocked(v.props.onRefresh).mock.calls.length;
        v.props.status = makeStatus({ enabled: true, lockedAccessEnabled: false, credentialSet: true }); // 自动重试成功、已推到主进程
        await settle(v);
        expect(v.bridge.clearCredential).toHaveBeenCalledTimes(1);
        expect(h.toastSuccess).toHaveBeenCalledExactlyOnceWith("已清除保存的开机密码");
        expect(vi.mocked(v.props.onRefresh).mock.calls.length).toBeGreaterThan(refreshed);

        // 只清一次：意图用完即丢，之后又读到「密码还在」（比如用户另外存了一个）也不会再清
        v.props.status = makeStatus({ enabled: true, lockedAccessEnabled: false, credentialSet: true });
        await settle(v);
        expect(v.bridge.clearCredential).toHaveBeenCalledTimes(1);
        v.unmount();
      });

      it("清除这一步失败：如实说密码还留着、怎么处理（不静默）；也只试一次", async () => {
        const { v } = mountOffFailed();
        v.bridge.clearCredential.mockResolvedValueOnce({ ok: false, error: "钥匙串被锁定" });
        call(v.block(), "onToggle", false);
        await flush();
        h.toastError.mockReset();
        v.props.status = makeStatus({ enabled: true, lockedAccessEnabled: false, credentialSet: true });
        await settle(v);
        expect(v.bridge.clearCredential).toHaveBeenCalledTimes(1);
        expect(h.toastSuccess).not.toHaveBeenCalled();
        expect(h.toastError).toHaveBeenCalledExactlyOnceWith(
          "已关闭「锁屏时也能用」，但开机密码没能清除：钥匙串被锁定。可以稍后点「清除」再试",
        );
        await settle(v);
        expect(v.bridge.clearCredential).toHaveBeenCalledTimes(1);
        v.unmount();
      });

      it("自动重试成功之前用户又把开关打开了：意图作废，之后主进程里关掉（比如旧的重试才成功）也不会替他清密码", async () => {
        const { v, onLockedAccessChange } = mountOffFailed();
        call(v.block(), "onToggle", false);
        await flush();
        expect(v.bridge.clearCredential).not.toHaveBeenCalled();

        call(v.block(), "onToggle", true); // 用户改主意：又点开（回调里草稿变成开、写成功）
        await flush();
        expect(onLockedAccessChange).toHaveBeenLastCalledWith(true);
        v.props.status = makeStatus({ enabled: true, lockedAccessEnabled: false, credentialSet: true });
        await settle(v);
        expect(v.bridge.clearCredential).not.toHaveBeenCalled();
        expect(h.toastSuccess).not.toHaveBeenCalled();
        v.unmount();
      });

      it("等的过程中密码已经没了（用户手动清了 / 另一处清了）：意图作废，之后新存的密码不会被清", async () => {
        const { v } = mountOffFailed();
        call(v.block(), "onToggle", false);
        await flush();
        v.props.status = makeStatus({ enabled: true, lockedAccessEnabled: true, credentialSet: false });
        await settle(v);
        v.props.status = makeStatus({ enabled: true, lockedAccessEnabled: false, credentialSet: true }); // 之后又存了一个密码
        await settle(v);
        expect(v.bridge.clearCredential).not.toHaveBeenCalled();
        v.unmount();
      });

      it("关总开关带出的联动（锁屏开关没写进去）同样登记：之后主进程里关了 → 补清密码", async () => {
        const { v } = mountOffFailed({ onEnabledChange: vi.fn(async () => true) });
        call(v.master(), "onCheckedChange", false);
        await flush();
        expect(h.toastError).toHaveBeenCalledExactlyOnceWith(LOCKED_OFF_FAILED);
        expect(v.bridge.clearCredential).not.toHaveBeenCalled();
        v.props.status = makeStatus({ enabled: false, lockedAccessEnabled: false, credentialSet: true });
        await settle(v);
        expect(v.bridge.clearCredential).toHaveBeenCalledTimes(1);
        v.unmount();
      });

      it("本来就没存密码时写失败：不登记（之后用户自己存的密码不会被清）；开关写成功的正常路径也不登记", async () => {
        const { v } = mountOffFailed({ status: makeStatus({ enabled: true, lockedAccessEnabled: true, credentialSet: false }) });
        call(v.block(), "onToggle", false);
        await flush();
        v.props.status = makeStatus({ enabled: true, lockedAccessEnabled: false, credentialSet: true });
        await settle(v);
        expect(v.bridge.clearCredential).not.toHaveBeenCalled();
        v.unmount();

        const ok = mountOffFailed({ onLockedAccessChange: vi.fn(async () => true) });
        call(ok.v.block(), "onToggle", false);
        await flush();
        expect(ok.v.bridge.clearCredential).toHaveBeenCalledTimes(1); // 写成功：当场清（原有行为）
        ok.v.props.status = makeStatus({ enabled: true, lockedAccessEnabled: false, credentialSet: true });
        await settle(ok.v);
        expect(ok.v.bridge.clearCredential).toHaveBeenCalledTimes(1); // 没有第二次
        ok.v.unmount();
      });

      // 第四轮评审（B2）：补清意图悬挂的时间不短——自动重试的退避是 2 秒 / 8 秒 / 30 秒（save-retry.ts 的 DEFAULT_RETRY_DELAYS_MS），最长约 40 秒。
      // 开关关着时「修改」开机密码是正常操作：这期间存下的新密码，不能被稍后才到的补清清掉
      it("等的过程中用户又存了新密码（开关保持关）：补清作废——主进程之后确认已关，也不能把刚存的密码清掉", async () => {
        const { v } = mountOffFailed();
        call(v.block(), "onToggle", false); // 关：写盘失败 → 登记补清（旧密码先留着）
        await flush();
        expect(h.toastError).toHaveBeenCalledExactlyOnceWith(LOCKED_OFF_FAILED);

        call(v.block(), "onEditCredential"); // 用户点「修改」存一个新密码（开关关着，没有要开的意思）
        expect(await call(pick(v.dialogs(), () => true, "对话框"), "onSubmit", SECRET)).toBe(true);
        expect(v.bridge.setCredential).toHaveBeenCalledExactlyOnceWith({ password: SECRET });

        v.props.status = makeStatus({ enabled: true, lockedAccessEnabled: false, credentialSet: true }); // 自动重试成功、已推到主进程
        await settle(v);
        expect(v.bridge.clearCredential, "刚存的密码不能被补清清掉").not.toHaveBeenCalled();
        expect(h.toastSuccess).not.toHaveBeenCalled();
        expectNoLeak(v.exits());
        v.unmount();
      });

    });

    // 第四轮评审（B2）：「关」要等写盘才去清密码——写盘慢（或失败后等重试）的这段时间里，用户的新动作不能被它碾过去
    describe("「关」的清除排在写盘之后：期间用户又开了开关 / 存了新密码，这次清除作废（不能清掉他刚存的密码）", () => {
      /** 关锁屏开关的写盘卡在 slowOff 上；之后的写盘（开）都很快 */
      const mountSlowOff = () => {
        const slowOff = deferred<boolean>();
        const onLockedAccessChange = vi
          .fn<(next: boolean) => Promise<unknown>>()
          .mockImplementationOnce(() => slowOff.promise)
          .mockImplementation(async () => true);
        const v = mountView({
          lockedAccess: true,
          status: makeStatus({ lockedAccessEnabled: true, credentialSet: true }),
          onLockedAccessChange,
        });
        return { v, slowOff, onLockedAccessChange };
      };
      /** 用户在对话框里存一个新密码（单纯保存 / 修改，不写开关）：返回对话框 onSubmit 的结果 */
      const saveNewPassword = (v: ReturnType<typeof mountView>): unknown => {
        call(v.block(), "onEditCredential");
        return call(pick(v.dialogs(), () => true, "对话框"), "onSubmit", SECRET);
      };

      it("对照：没有后续动作 → 写盘回来照清（原有行为不变）", async () => {
        const { v, slowOff } = mountSlowOff();
        call(v.block(), "onToggle", false);
        await flush();
        expect(v.bridge.clearCredential).not.toHaveBeenCalled(); // 写盘还没回来：先不清
        slowOff.resolve(true);
        await flush();
        expect(v.bridge.clearCredential).toHaveBeenCalledTimes(1);
        expect(h.toastSuccess).toHaveBeenCalledExactlyOnceWith("已清除保存的开机密码");
        v.unmount();
      });

      it("关（写盘还没回来）→ 又点开：写盘回来后不清密码（开着的功能要留着密码，不能落到「开着、但密码没了」）", async () => {
        const { v, slowOff, onLockedAccessChange } = mountSlowOff();
        call(v.block(), "onToggle", false);
        await flush();
        call(v.block(), "onToggle", true); // 密码还在、所以不弹对话框，直接写开
        await flush();
        expect(onLockedAccessChange).toHaveBeenLastCalledWith(true);
        slowOff.resolve(true);
        await flush();
        expect(v.bridge.clearCredential).not.toHaveBeenCalled();
        expect(h.toastSuccess).not.toHaveBeenCalled();
        v.unmount();
      });

      it("关（写盘还没回来）→ 存了新密码：写盘回来后不清它（评审说的「先关、再开并存密码」，开关此刻是什么都一样）", async () => {
        const { v, slowOff } = mountSlowOff();
        call(v.block(), "onToggle", false);
        await flush();
        expect(await saveNewPassword(v)).toBe(true);
        slowOff.resolve(true);
        await flush();
        expect(v.bridge.setCredential).toHaveBeenCalledExactlyOnceWith({ password: SECRET });
        expect(v.bridge.clearCredential, "刚存的密码不能被之前那次「关」清掉").not.toHaveBeenCalled();
        expect(h.toastSuccess).not.toHaveBeenCalled();
        expectNoLeak(v.exits());
        v.unmount();
      });

      it("关总开关（写盘还没回来）→ 存了新密码：联动照样把锁屏开关关掉（收窄方向），但不清刚存的密码", async () => {
        const slowMaster = deferred<boolean>();
        const onEnabledChange = vi.fn<(next: boolean) => Promise<unknown>>(() => slowMaster.promise);
        const onLockedAccessChange = vi.fn<(next: boolean) => Promise<unknown>>(async () => true);
        const v = mountView({
          enabled: true,
          lockedAccess: true,
          status: makeStatus({ enabled: true, lockedAccessEnabled: true, credentialSet: true }),
          onEnabledChange,
          onLockedAccessChange,
        });
        call(v.master(), "onCheckedChange", false);
        await flush();
        expect(onEnabledChange).toHaveBeenCalledExactlyOnceWith(false);
        expect(await saveNewPassword(v)).toBe(true); // 总开关还在等写盘，用户存了新密码
        slowMaster.resolve(true);
        await flush();
        expect(onLockedAccessChange).toHaveBeenCalledExactlyOnceWith(false);
        expect(v.bridge.clearCredential, "刚存的密码不能被联动的清除清掉").not.toHaveBeenCalled();
        v.unmount();
      });
    });

    // 第三轮评审：writeVia 失败后无条件清暂存，可能清掉别人的
    it("连点：先发的那次写盘晚失败，只收起自己登记的那一份——后一次还在等写盘的暂存不能被它顺手清掉（开关不能中途弹回）", async () => {
      const gateA = deferred<boolean>();
      const gateB = deferred<boolean>();
      const onLockedAccessChange = vi
        .fn<(next: boolean) => Promise<unknown>>()
        .mockImplementationOnce(() => gateA.promise)
        .mockImplementationOnce(() => gateB.promise);
      const v = mountView({
        enabled: true,
        lockedAccess: true,
        status: makeStatus({ enabled: true, lockedAccessEnabled: true, credentialSet: false }),
        onLockedAccessChange,
        onEnabledChange: vi.fn(async () => true),
      });
      call(v.block(), "onToggle", false); // A：关锁屏开关（等写盘）
      await flush();
      expect(onLockedAccessChange).toHaveBeenCalledTimes(1);
      expect(v.block().props.lockedAccess, "A 在路上：按目标值显示").toBe(false);

      call(v.master(), "onCheckedChange", false); // B：关总开关，联动再写一次锁屏开关（与 A 同一个目标值，又登记了一份暂存）
      await flush();
      expect(onLockedAccessChange).toHaveBeenCalledTimes(2);

      gateA.resolve(false); // A 晚失败
      await flush();
      expect(v.block().props.lockedAccess, "B 还在等写盘：显示不能被 A 的失败弹回「开」").toBe(false);

      gateB.resolve(false); // B 也失败了才轮到它收起 → 回到实际状态（主进程里确实还开着）
      await flush();
      expect(v.block().props.lockedAccess).toBe(true);
      v.unmount();
    });

    it("锁屏开关：关 → 开写盘期间显示目标值，传给区块的 enabled / lockedAccess 是「此刻显示的值」", async () => {
      const gate = deferred();
      const onLockedAccessChange = vi.fn<(next: boolean) => Promise<void>>(() => gate.promise);
      const v = mountView({
        lockedAccess: false,
        status: makeStatus({ credentialSet: true, lockedAccessEnabled: false }),
        onLockedAccessChange,
      });
      call(v.block(), "onToggle", true);
      await flush();
      expect(onLockedAccessChange).toHaveBeenCalledExactlyOnceWith(true);
      expect(v.block().props.lockedAccess).toBe(true);
      expect(v.block().props.syncNote).toBeNull();
      gate.resolve();
      await flush();
    });

    it("联动收窄看「设置里 或 主进程里」任何一边还开着：草稿已是关、主进程里锁屏仍开 → 关总开关时照样关锁屏开关并清密码", async () => {
      const onLockedAccessChange = vi.fn<(next: boolean) => Promise<unknown>>(async () => true);
      const v = mountView({
        enabled: true,
        lockedAccess: false,
        status: makeStatus({ enabled: true, lockedAccessEnabled: true, credentialSet: true }),
        onLockedAccessChange,
      });
      call(v.master(), "onCheckedChange", false);
      await flush();
      expect(onLockedAccessChange).toHaveBeenCalledExactlyOnceWith(false);
      expect(v.bridge.clearCredential).toHaveBeenCalledTimes(1);
    });

    it("联动收窄：草稿还开、主进程里还没生效 → 关总开关时同样关锁屏开关（收窄永远是安全方向）", async () => {
      const onLockedAccessChange = vi.fn<(next: boolean) => Promise<unknown>>(async () => true);
      const v = mountView({
        enabled: true,
        lockedAccess: true,
        status: makeStatus({ enabled: true, lockedAccessEnabled: false, credentialSet: false }),
        onLockedAccessChange,
      });
      call(v.master(), "onCheckedChange", false);
      await flush();
      expect(onLockedAccessChange).toHaveBeenCalledExactlyOnceWith(false);
      expect(v.bridge.clearCredential).not.toHaveBeenCalled();
    });

    it("清除开机密码：主进程里锁屏仍开（草稿已关）→ 确认文案说会一并关闭，并真的把开关写成关", async () => {
      const onLockedAccessChange = vi.fn<(next: boolean) => Promise<unknown>>(async () => true);
      const v = mountView({
        lockedAccess: false,
        status: makeStatus({ lockedAccessEnabled: true, credentialSet: true }),
        onLockedAccessChange,
      });
      h.confirm.mockResolvedValue(true);
      call(v.block(), "onClearCredential");
      await flush();
      expect(h.confirm).toHaveBeenCalledWith(
        expect.objectContaining({ description: "清除后「锁屏时也能用」会一并关闭，需要重新保存密码才能再次开启。" }),
      );
      expect(v.bridge.clearCredential).toHaveBeenCalledTimes(1);
      expect(onLockedAccessChange).toHaveBeenCalledExactlyOnceWith(false);
    });

    it("刷新抛错不产生未处理的异常（开关已经写好了，刷新只是让界面跟上）", async () => {
      const onRefresh = vi.fn(async () => {
        throw new Error("刷新炸了");
      });
      const v = mountView({ enabled: false, status: makeStatus({ enabled: false }), onEnabledChange: vi.fn(async () => undefined), onRefresh });
      h.confirm.mockResolvedValue(true);
      call(v.master(), "onCheckedChange", true);
      await flush();
      expect(onRefresh).toHaveBeenCalledTimes(1);
      expect(h.toastError).not.toHaveBeenCalled();
    });
  });

  describe("装配失败 / 没有驱动：设置里已开着的开关能关掉（只拦打开），不再被卡死（修复「状态卡死」时引入的回归）", () => {
    const REASON = "电脑操作没能初始化（磁盘只读）。请重启 Flowship 再试；还不行就把应用日志发给开发者排查";
    const failed = (over: Partial<ComputerUseStatus> = {}) =>
      makeStatus({
        supported: false,
        lockedAccessSupported: false,
        driverReady: false,
        driverError: REASON,
        lockedAccessNote: REASON,
        enabled: false,
        lockedAccessEnabled: false,
        permissions: perms("unknown", "unknown"),
        ...over,
      });
    const switches = (v: ReturnType<typeof mountView>) => v.render().filter((el) => el.type === Switch);

    it("总开关（设置里开着）：能关——写 false，不弹确认；锁屏开关也开着就一并关掉；读不到钥匙串状态所以不碰钥匙串", async () => {
      const onEnabledChange = vi.fn<(next: boolean) => Promise<unknown>>(async () => true);
      const onLockedAccessChange = vi.fn<(next: boolean) => Promise<unknown>>(async () => true);
      const v = mountView({ enabled: true, lockedAccess: true, status: failed(), onEnabledChange, onLockedAccessChange });
      const [master] = switches(v);
      expect(master?.props.disabled).toBe(false);
      expect(master?.props.checked).toBe(true);
      call(master as El, "onCheckedChange", false);
      await flush();
      expect(h.confirm).not.toHaveBeenCalled();
      expect(onEnabledChange).toHaveBeenCalledExactlyOnceWith(false);
      expect(onLockedAccessChange).toHaveBeenCalledExactlyOnceWith(false);
      expect(v.bridge.clearCredential).not.toHaveBeenCalled();
    });

    it("总开关：打开一律不行（即使有人绕过禁用态直接触发）——不弹确认、不写设置", async () => {
      const onEnabledChange = vi.fn<(next: boolean) => Promise<unknown>>(async () => true);
      const v = mountView({ enabled: false, status: failed(), onEnabledChange });
      const [master] = switches(v);
      expect(master?.props.disabled).toBe(true);
      call(master as El, "onCheckedChange", true);
      await flush();
      expect(h.confirm).not.toHaveBeenCalled();
      expect(onEnabledChange).not.toHaveBeenCalled();
    });

    it("「锁屏时也能用」在设置里还开着：只留一行能关的开关——关 → 写 false，不碰钥匙串；想打开（绕过）不行", async () => {
      const onLockedAccessChange = vi.fn<(next: boolean) => Promise<unknown>>(async () => true);
      const v = mountView({ enabled: true, lockedAccess: true, status: failed(), onLockedAccessChange });
      const row = switches(v)[1] as El;
      expect(row).toBeDefined();
      expect(row.props.checked).toBe(true);
      expect(row.props.disabled).not.toBe(true);
      call(row, "onCheckedChange", true);
      await flush();
      expect(onLockedAccessChange).not.toHaveBeenCalled();
      expect(v.dialogs(), "也不能借这一行弹出「保存开机密码」对话框").toHaveLength(0);
      call(row, "onCheckedChange", false);
      await flush();
      expect(onLockedAccessChange).toHaveBeenCalledExactlyOnceWith(false);
      expect(v.bridge.clearCredential).not.toHaveBeenCalled();
      expect(h.confirm).not.toHaveBeenCalled();
    });

    it("写开关失败：说明照给；这一行不会因为占位快照而「看起来已经关了」（拿不到实际状态时按设置草稿显示）", async () => {
      const onEnabledChange = vi.fn<(next: boolean) => Promise<unknown>>(async () => false);
      const v = mountView({ enabled: true, status: failed(), onEnabledChange });
      call(switches(v)[0] as El, "onCheckedChange", false);
      await flush();
      expect(h.toastError).toHaveBeenCalledExactlyOnceWith(ENABLED_OFF_FAILED);
      expect(switches(v)[0]?.props.checked, "草稿没变（测试里没有乐观更新），占位快照不当实际状态").toBe(true);
    });

    describe("「已保存的开机密码」一行的「清除」（装配失败时的唯一入口；主进程那边装配失败也能清）", () => {
      const clearButton = (v: ReturnType<typeof mountView>) => {
        const row = pick(v.render(), (el) => el.type === SettingRow && el.props.label === "已保存的开机密码", "清除行");
        return pick(walk(row.props.control), isButton, "清除按钮");
      };

      it("确认后调桥的 clearCredential：成功 → 说一声（这一行本身不会变）；取消 → 什么都不动", async () => {
        const v = mountView({ enabled: false, lockedAccess: false, status: failed() });
        h.confirm.mockResolvedValueOnce(false);
        call(clearButton(v), "onClick");
        await flush();
        expect(h.confirm).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ title: "清除开机密码", confirmLabel: "清除", destructive: true }),
        );
        expect(v.bridge.clearCredential).not.toHaveBeenCalled();

        h.confirm.mockResolvedValueOnce(true);
        call(clearButton(v), "onClick");
        await flush();
        expect(v.bridge.clearCredential).toHaveBeenCalledTimes(1);
        expect(h.toastSuccess).toHaveBeenCalledExactlyOnceWith("已清除保存的开机密码");
        expect(h.toastError).not.toHaveBeenCalled();
        expect(v.props.onRefresh).toHaveBeenCalledTimes(1);
      });

      it("清除失败（主进程如实回 ok:false / 桥抛错）：如实说原因，不报成功；IPC 前缀不进 toast", async () => {
        const v = mountView({ enabled: false, lockedAccess: false, status: failed() });
        h.confirm.mockResolvedValue(true);
        v.bridge.clearCredential.mockResolvedValueOnce({ ok: false, error: "钥匙串被占用" });
        call(clearButton(v), "onClick");
        await flush();
        expect(h.toastError).toHaveBeenCalledExactlyOnceWith("清除失败：钥匙串被占用");
        expect(h.toastSuccess).not.toHaveBeenCalled();

        h.toastError.mockReset();
        v.bridge.clearCredential.mockRejectedValueOnce(
          new Error("Error invoking remote method 'computer-use:clear-credential': Error: 没能清除保存的开机密码（钥匙串 被锁定了）"),
        );
        call(clearButton(v), "onClick");
        await flush();
        expect(h.toastError).toHaveBeenCalledExactlyOnceWith("清除失败：没能清除保存的开机密码（钥匙串 被锁定了）");
        expect(h.toastSuccess).not.toHaveBeenCalled();
      });
    });
  });

  describe("保存开机密码对话框：不管 onSubmit 出什么事，「保存中」都能复位（修复引入的回归：写开关抛错 → saving 永真）", () => {
    /** 开「锁屏时也能用」要先存密码 → 弹出对话框；用槽位桩把它真渲染出来，拿到里面的输入框 / 按钮 */
    const openDialog = (over: Partial<Omit<ViewProps, "bridge">> = {}) => {
      const v = mountView({ status: makeStatus({ credentialSet: false }), ...over });
      call(v.block(), "onToggle", true);
      const element = pick(v.dialogs(), () => true, "对话框");
      const harness = createHookHarness();
      const renderDialog = (props: Record<string, unknown> = element.props) =>
        walk(harness.render(() => (element.type as (p: unknown) => unknown)(props)));
      const typePassword = (props?: Record<string, unknown>) =>
        call(pick(renderDialog(props), (el) => el.type === PasswordInput, "密码框"), "onChange", { target: { value: SECRET } });
      const saveButton = (props?: Record<string, unknown>) =>
        pick(renderDialog(props), (el) => isButton(el) && textOf(el.props.children) === "保存", "保存按钮");
      const cancelButton = (props?: Record<string, unknown>) =>
        pick(renderDialog(props), (el) => isButton(el) && textOf(el.props.children) === "取消", "取消按钮");
      const dialogRoot = (props?: Record<string, unknown>) => pick(renderDialog(props), (el) => el.type === Dialog, "对话框根");
      return { v, element, typePassword, saveButton, cancelButton, dialogRoot };
    };

    it("写开关回调抛错（经完整的 View → saveCredentialFlow）：对话框留着、保存按钮恢复可点、说明照给、密码不外泄", async () => {
      const onLockedAccessChange = vi.fn<(next: boolean) => Promise<unknown>>(async () => {
        throw new Error(`写盘炸了 ${SECRET}`);
      });
      const d = openDialog({ onLockedAccessChange });
      const onClose = vi.fn();
      const props = { ...d.element.props, onClose };
      d.typePassword(props);
      expect(d.saveButton(props).props.disabled).toBe(false);
      call(d.saveButton(props), "onClick");
      await flush();
      expect(d.v.bridge.setCredential).toHaveBeenCalledExactlyOnceWith({ password: SECRET });
      expect(onLockedAccessChange).toHaveBeenCalledExactlyOnceWith(true);
      expect(h.toastError).toHaveBeenCalledExactlyOnceWith(CREDENTIAL_SAVED_SWITCH_FAILED);
      expect(onClose).not.toHaveBeenCalled();
      // 复位：按钮可点、取消可点、Esc / 点遮罩能关
      expect(d.saveButton(props).props.disabled).toBe(false);
      expect(d.cancelButton(props).props.disabled).toBe(false);
      call(d.dialogRoot(props), "onOpenChange", false);
      expect(onClose).toHaveBeenCalledTimes(1);
      expectNoLeak(d.v.exits());
    });

    it("onSubmit 本身抛错（流程之外的意外）：最后一道兜底——保存按钮复位、toast 里抹掉密码、对话框不关", async () => {
      const d = openDialog();
      const onClose = vi.fn();
      const props = {
        ...d.element.props,
        onClose,
        onSubmit: vi.fn(async () => {
          throw new Error(`意外：入参 ${SECRET} 不合法`);
        }),
      };
      d.typePassword(props);
      call(d.saveButton(props), "onClick");
      await flush();
      expect(h.toastError).toHaveBeenCalledExactlyOnceWith("保存失败：意外：入参 ••• 不合法");
      expect(onClose).not.toHaveBeenCalled();
      expect(d.saveButton(props).props.disabled, "保存按钮复位").toBe(false);
      expect(d.cancelButton(props).props.disabled).toBe(false);
      call(d.dialogRoot(props), "onOpenChange", false);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("保存中（onSubmit 还没返回）：按钮禁用、Esc / 点遮罩关不掉；成功后才关", async () => {
      const gate = deferred<boolean>();
      const d = openDialog();
      const onClose = vi.fn();
      const props = { ...d.element.props, onClose, onSubmit: vi.fn(() => gate.promise) };
      d.typePassword(props);
      call(d.saveButton(props), "onClick");
      await flush();
      expect(d.saveButton(props).props.disabled).toBe(true);
      expect(d.cancelButton(props).props.disabled).toBe(true);
      call(d.dialogRoot(props), "onOpenChange", false);
      expect(onClose, "保存中关不掉").not.toHaveBeenCalled();
      gate.resolve(true);
      await flush();
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    // 第四轮评审（B1）：主进程说「密码已经存好了」（ok:false + saved:true），对话框得按「已保存」处理——关掉、不是留着让用户再输一遍
    it("主进程说「密码已存好」（ok:false + saved:true，Windows 冷却记录没清掉）：对话框关闭、开关照开、状态刷新、error 作警告展示，不弹「保存失败」", async () => {
      const note = describeSetFailure({ code: "COOLDOWN_NOT_CLEARED", fields: { wait: "540" } }, "兜底");
      const onLockedAccessChange = vi.fn<(next: boolean) => Promise<unknown>>(async () => undefined);
      const d = openDialog({ onLockedAccessChange });
      d.v.bridge.setCredential.mockResolvedValueOnce({ ok: false, saved: true, error: note });
      const onClose = vi.fn();
      const props = { ...d.element.props, onClose };
      d.typePassword(props);
      call(d.saveButton(props), "onClick");
      await flush();
      expect(d.v.bridge.setCredential).toHaveBeenCalledExactlyOnceWith({ password: SECRET });
      expect(onLockedAccessChange).toHaveBeenCalledExactlyOnceWith(true);
      expect(h.toastWarning).toHaveBeenCalledExactlyOnceWith(note, { duration: 10_000 });
      expect(h.toastError).not.toHaveBeenCalled();
      expect(onClose, "密码已经存好了：对话框要关，不能留着让用户再输一遍").toHaveBeenCalledTimes(1);
      expect(d.v.props.onRefresh).toHaveBeenCalled();
      expectNoLeak(d.v.exits());
    });

    // 第四轮评审（B4）：对话框里是输了一半的开机密码，点一下遮罩就整个丢掉太伤——和项目里其它带表单草稿的 dialog 一样关掉「点外面关闭」
    it("点遮罩关不掉（disablePointerDismissal，对话框里是输了一半的密码）；Esc 与「取消」仍是出路", async () => {
      const d = openDialog();
      const onClose = vi.fn();
      const props = { ...d.element.props, onClose };
      d.typePassword(props);
      // 「点遮罩」由 Base UI 的 outsidePress 处理，开关就是根上的这个 prop（Esc 走 escapeKey，不受它影响）
      expect(d.dialogRoot(props).props.disablePointerDismissal).toBe(true);
      // 出路没被堵死：Esc（onOpenChange(false)）与「取消」按钮都能关
      call(d.dialogRoot(props), "onOpenChange", false);
      expect(onClose).toHaveBeenCalledTimes(1);
      call(d.cancelButton(props), "onClick");
      expect(onClose).toHaveBeenCalledTimes(2);
    });
  });

  it("总开关：无桥时禁用；有桥时可用", () => {
    expect(pick(walk(createHookHarness().render(() => ComputerUseView(viewProps({ bridge: null, status: null })))), (el) => el.type === Switch, "总开关").props.disabled).toBe(true);
    expect(mountView().master().props.disabled).toBe(false);
  });

  it("锁屏开关（已存密码）：开 → 写设置 + 刷新（不动钥匙串）；关 → 写 false → 钥匙串里的开机密码一并清掉 → 刷新", async () => {
    const onLockedAccessChange = vi.fn<(next: boolean) => Promise<void>>(async () => undefined);
    const onRefresh = vi.fn();
    const v = mountView({
      status: makeStatus({ credentialSet: true }),
      onLockedAccessChange,
      onRefresh,
    });

    call(v.block(), "onToggle", true);
    await flush();
    expect(onLockedAccessChange).toHaveBeenLastCalledWith(true);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(v.dialogs()).toHaveLength(0);
    expect(v.bridge.clearCredential).not.toHaveBeenCalled();

    call(v.block(), "onToggle", false);
    await flush();
    expect(onLockedAccessChange).toHaveBeenLastCalledWith(false);
    expect(onLockedAccessChange).toHaveBeenCalledTimes(2);
    expect(v.bridge.clearCredential).toHaveBeenCalledTimes(1);
    expect(h.confirm).not.toHaveBeenCalled(); // 关闭不弹确认：关本来就是用户要的，说明写在开关下面的文案里
    expect(h.toastSuccess).toHaveBeenCalledExactlyOnceWith("已清除保存的开机密码");
    expect(onRefresh).toHaveBeenCalledTimes(2);
    expect(order(onLockedAccessChange)).toBeLessThan(order(v.bridge.clearCredential));
  });

  it("锁屏开关关闭不需要密码：没存密码时关也直接写 false，不碰钥匙串", async () => {
    const onLockedAccessChange = vi.fn<(next: boolean) => Promise<void>>(async () => undefined);
    const v = mountView({
      status: makeStatus({ credentialSet: false }),
      lockedAccess: true,
      onLockedAccessChange,
    });
    call(v.block(), "onToggle", false);
    await flush();
    expect(onLockedAccessChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(v.bridge.clearCredential).not.toHaveBeenCalled();
    expect(v.dialogs()).toHaveLength(0);
  });

  it("锁屏开关（没存密码）开启：不写设置，先弹「保存开机密码」对话框；取消 → 开关保持关、什么都没保存", async () => {
    const onLockedAccessChange = vi.fn<(next: boolean) => Promise<void>>(async () => undefined);
    const onRefresh = vi.fn();
    const v = mountView({
      status: makeStatus({ credentialSet: false }),
      onLockedAccessChange,
      onRefresh,
    });
    expect(v.dialogs()).toHaveLength(0);

    call(v.block(), "onToggle", true);
    await flush();
    expect(v.dialogs()).toHaveLength(1);
    expect(onLockedAccessChange).not.toHaveBeenCalled();

    call(pick(v.dialogs(), () => true, "对话框"), "onClose");
    await flush();
    expect(v.dialogs()).toHaveLength(0); // 关闭 = 卸载，输入框里的密码随之丢弃
    expect(onLockedAccessChange).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
    expect(v.bridge.setCredential).not.toHaveBeenCalled();
  });

  it("开启流程里保存成功：密码交给 setCredential → 才写开关 → 刷新；密码不进任何其它出口", async () => {
    const onLockedAccessChange = vi.fn<(next: boolean) => Promise<void>>(async () => undefined);
    const onRefresh = vi.fn();
    const onEnabledChange = vi.fn();
    const onStatus = vi.fn();
    const v = mountView({
      status: makeStatus({ credentialSet: false }),
      onLockedAccessChange,
      onRefresh,
      onEnabledChange,
      onStatus,
    });
    call(v.block(), "onToggle", true);
    const dialog = pick(v.dialogs(), () => true, "对话框");

    expect(await call(dialog, "onSubmit", SECRET)).toBe(true);
    expect(v.bridge.setCredential).toHaveBeenCalledExactlyOnceWith({ password: SECRET });
    expect(onLockedAccessChange).toHaveBeenCalledExactlyOnceWith(true);
    expect(order(v.bridge.setCredential)).toBeLessThan(order(onLockedAccessChange));
    expect(onRefresh).toHaveBeenCalled();

    // 出口收全：toast / 确认框 / console / 桥上除 setCredential 之外的方法 / 四个回调 / 保存完之后渲染出来的界面
    expectNoLeak(v.exits());
  });

  it("开启流程里保存失败：toast 原因、开关一个字不动、对话框留着让用户改了重试", async () => {
    const onLockedAccessChange = vi.fn<(next: boolean) => Promise<void>>(async () => undefined);
    const v = mountView({ status: makeStatus({ credentialSet: false }), onLockedAccessChange });
    v.bridge.setCredential.mockResolvedValueOnce({ ok: false, error: "钥匙串被锁定" });
    call(v.block(), "onToggle", true);

    expect(await call(pick(v.dialogs(), () => true, "对话框"), "onSubmit", SECRET)).toBe(false);
    expect(h.toastError).toHaveBeenCalledExactlyOnceWith("钥匙串被锁定");
    expect(onLockedAccessChange).not.toHaveBeenCalled();
    expect(v.dialogs()).toHaveLength(1);
    expectNoLeak(v.exits());
  });

  it("「修改」/「保存」按钮走单纯保存流程：保存新密码，不动开关", async () => {
    const onLockedAccessChange = vi.fn<(next: boolean) => Promise<void>>(async () => undefined);
    const v = mountView({
      status: makeStatus({ credentialSet: true }),
      lockedAccess: true,
      onLockedAccessChange,
    });
    call(v.block(), "onEditCredential");
    expect(v.dialogs()).toHaveLength(1);
    expect(await call(pick(v.dialogs(), () => true, "对话框"), "onSubmit", SECRET)).toBe(true);
    expect(v.bridge.setCredential).toHaveBeenCalledExactlyOnceWith({ password: SECRET });
    expect(onLockedAccessChange).not.toHaveBeenCalled();
    expectNoLeak(v.exits());
  });

  describe("清除开机密码", () => {
    const mountClear = (lockedAccess: boolean) => {
      const onLockedAccessChange = vi.fn<(next: boolean) => Promise<unknown>>(async () => undefined);
      const onRefresh = vi.fn();
      const v = mountView({
        status: makeStatus({ credentialSet: true }),
        lockedAccess,
        onLockedAccessChange,
        onRefresh,
      });
      return { ...v, onLockedAccessChange, onRefresh };
    };

    it("先确认（破坏性）；取消 → 什么都不清", async () => {
      const v = mountClear(true);
      h.confirm.mockResolvedValue(false);
      call(v.block(), "onClearCredential");
      await flush();
      expect(h.confirm).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ title: "清除开机密码", confirmLabel: "清除", destructive: true }),
      );
      expect(v.bridge.clearCredential).not.toHaveBeenCalled();
      expect(v.onLockedAccessChange).not.toHaveBeenCalled();
      expect(v.onRefresh).not.toHaveBeenCalled();
    });

    it("确认后：清密码 → 开关开着就一并关掉 → 刷新；确认文案告知会一并关闭", async () => {
      const v = mountClear(true);
      h.confirm.mockResolvedValue(true);
      call(v.block(), "onClearCredential");
      await flush();
      expect(h.confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "清除后「锁屏时也能用」会一并关闭，需要重新保存密码才能再次开启。",
        }),
      );
      expect(v.bridge.clearCredential).toHaveBeenCalledTimes(1);
      expect(v.onLockedAccessChange).toHaveBeenCalledExactlyOnceWith(false);
      expect(v.onRefresh).toHaveBeenCalledTimes(1);
      expect(order(v.bridge.clearCredential)).toBeLessThan(order(v.onLockedAccessChange));
      expect(order(v.onLockedAccessChange)).toBeLessThan(order(v.onRefresh));
    });

    it("密码清了但开关没写进去（onLockedAccessChange 返回 false）：密码不回滚；明说开关没关掉（没有密码它自动解锁不了）；仍刷新", async () => {
      const v = mountClear(true);
      v.onLockedAccessChange.mockResolvedValueOnce(false);
      h.confirm.mockResolvedValue(true);
      call(v.block(), "onClearCredential");
      await flush();
      expect(v.bridge.clearCredential).toHaveBeenCalledTimes(1);
      expect(v.onLockedAccessChange).toHaveBeenCalledExactlyOnceWith(false);
      expect(h.toastError).toHaveBeenCalledExactlyOnceWith(CLEAR_SWITCH_FAILED);
      expect(h.toastSuccess).not.toHaveBeenCalled();
      expect(v.onRefresh).toHaveBeenCalledTimes(1);
    });

    it("开关写成功（含没有返回值 / true）：清除流程不弹任何错误", async () => {
      for (const ret of [undefined, true]) {
        h.toastError.mockReset();
        const v = mountClear(true);
        v.onLockedAccessChange.mockResolvedValueOnce(ret);
        h.confirm.mockResolvedValue(true);
        call(v.block(), "onClearCredential");
        await flush();
        expect(v.onLockedAccessChange, String(ret)).toHaveBeenCalledTimes(1);
        expect(h.toastError, String(ret)).not.toHaveBeenCalled();
      }
    });

    it("开关本来就关着：清了密码不去动开关", async () => {
      const v = mountClear(false);
      h.confirm.mockResolvedValue(true);
      call(v.block(), "onClearCredential");
      await flush();
      expect(h.confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "清除后，再次开启「锁屏时也能用」需要重新保存密码。",
        }),
      );
      expect(v.bridge.clearCredential).toHaveBeenCalledTimes(1);
      expect(v.onLockedAccessChange).not.toHaveBeenCalled();
      expect(v.onRefresh).toHaveBeenCalledTimes(1);
    });

    it("清除失败（桥抛错）：toast 原因，开关不动、不刷新", async () => {
      const v = mountClear(true);
      v.bridge.clearCredential.mockRejectedValueOnce(new Error("钥匙串拒绝访问"));
      h.confirm.mockResolvedValue(true);
      call(v.block(), "onClearCredential");
      await flush();
      expect(h.toastError).toHaveBeenCalledExactlyOnceWith("清除失败：钥匙串拒绝访问");
      expect(v.onLockedAccessChange).not.toHaveBeenCalled();
      expect(v.onRefresh).not.toHaveBeenCalled();
    });

    it("清除失败（主进程如实回 ok:false：钥匙串里没删掉）：toast 原因，开关不动、不刷新——不能让用户以为已经清掉了", async () => {
      const v = mountClear(true);
      v.bridge.clearCredential.mockResolvedValueOnce({ ok: false, error: "钥匙串被锁定，删不了" });
      h.confirm.mockResolvedValue(true);
      call(v.block(), "onClearCredential");
      await flush();
      expect(h.toastError).toHaveBeenCalledExactlyOnceWith("清除失败：钥匙串被锁定，删不了");
      expect(v.onLockedAccessChange).not.toHaveBeenCalled();
      expect(v.onRefresh).not.toHaveBeenCalled();
    });

    it("清除失败且主进程没给原因：兜底文案", async () => {
      const v = mountClear(false);
      v.bridge.clearCredential.mockResolvedValueOnce({ ok: false, error: "  " });
      h.confirm.mockResolvedValue(true);
      call(v.block(), "onClearCredential");
      await flush();
      expect(h.toastError).toHaveBeenCalledExactlyOnceWith("清除失败：钥匙串里的开机密码没有删掉");
    });
  });

  it("测试结束后的刷新直通父级 onRefresh", () => {
    const v = mountView({ status: makeStatus({ credentialSet: true }) });
    call(v.block(), "onRefresh");
    expect(v.props.onRefresh).toHaveBeenCalledTimes(1);
  });

  describe("Windows（锁屏后台模式不需要开机密码）", () => {
    const helperInstalled = { installed: true, canInstall: false } as const;
    const mountWin = (over: Partial<Omit<ViewProps, "bridge">> = {}) =>
      mountView({ status: makeWinStatus(), ...over });

    it("开启开关：不要求保存开机密码——不弹对话框，直接写设置 + 刷新（macOS 同样的操作会先弹对话框）", async () => {
      const onLockedAccessChange = vi.fn<(next: boolean) => Promise<void>>(async () => undefined);
      const onRefresh = vi.fn();
      const v = mountWin({ status: makeWinStatus({ credentialSet: false }), onLockedAccessChange, onRefresh });
      call(v.block(), "onToggle", true);
      await flush();
      expect(v.dialogs()).toHaveLength(0);
      expect(onLockedAccessChange).toHaveBeenCalledExactlyOnceWith(true);
      expect(onRefresh).toHaveBeenCalledTimes(1);
      expect(v.bridge.setCredential).not.toHaveBeenCalled();

      // 对照：macOS 没存密码就开 → 先弹对话框、不写设置
      const onMacChange = vi.fn<(next: boolean) => Promise<void>>(async () => undefined);
      const mac = mountView({ status: makeStatus({ credentialSet: false }), onLockedAccessChange: onMacChange });
      call(mac.block(), "onToggle", true);
      expect(mac.dialogs()).toHaveLength(1);
      expect(onMacChange).not.toHaveBeenCalled();
    });

    it("关闭开关：写 false 之后把组件里保存的开机密码一并清掉（关掉的功能不留能自动解锁的密码）", async () => {
      const onLockedAccessChange = vi.fn<(next: boolean) => Promise<void>>(async () => undefined);
      const v = mountWin({
        status: makeWinStatus({ unlockHelper: helperInstalled, credentialSet: true }),
        lockedAccess: true,
        onLockedAccessChange,
      });
      call(v.block(), "onToggle", false);
      await flush();
      expect(onLockedAccessChange).toHaveBeenCalledExactlyOnceWith(false);
      expect(v.bridge.clearCredential).toHaveBeenCalledTimes(1);
      expect(order(onLockedAccessChange)).toBeLessThan(order(v.bridge.clearCredential));
      expect(h.toastSuccess).toHaveBeenCalledExactlyOnceWith("已清除保存的开机密码");
    });

    it("关闭开关而没存密码：只写 false，不碰组件", async () => {
      const onLockedAccessChange = vi.fn<(next: boolean) => Promise<void>>(async () => undefined);
      const v = mountWin({ lockedAccess: true, onLockedAccessChange });
      call(v.block(), "onToggle", false);
      await flush();
      expect(onLockedAccessChange).toHaveBeenCalledExactlyOnceWith(false);
      expect(v.bridge.clearCredential).not.toHaveBeenCalled();
    });

    it("「保存 / 修改」开机密码：弹对话框，并告诉它是 Windows（说明措辞随平台：组件加密保存 vs 钥匙串）；不动开关", async () => {
      const onLockedAccessChange = vi.fn<(next: boolean) => Promise<void>>(async () => undefined);
      const v = mountWin({
        status: makeWinStatus({ unlockHelper: helperInstalled }),
        lockedAccess: true,
        onLockedAccessChange,
      });
      call(v.block(), "onEditCredential");
      const dialog = pick(v.dialogs(), () => true, "对话框");
      expect(dialog.props.platform).toBe("win32");
      expect(await call(dialog, "onSubmit", SECRET)).toBe(true);
      expect(v.bridge.setCredential).toHaveBeenCalledExactlyOnceWith({ password: SECRET });
      expect(onLockedAccessChange).not.toHaveBeenCalled();

      const mac = mountView();
      call(mac.block(), "onEditCredential");
      expect(pick(mac.dialogs(), () => true, "对话框").props.platform).toBe("darwin");
    });

    it("清除开机密码：确认文案说明「后台模式不受影响」；清完不关开关（后台模式用不着密码）", async () => {
      const onLockedAccessChange = vi.fn<(next: boolean) => Promise<void>>(async () => undefined);
      const onRefresh = vi.fn();
      const v = mountWin({
        status: makeWinStatus({ unlockHelper: helperInstalled, credentialSet: true }),
        lockedAccess: true,
        onLockedAccessChange,
        onRefresh,
      });
      h.confirm.mockResolvedValue(true);
      call(v.block(), "onClearCredential");
      await flush();
      expect(h.confirm).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          title: "清除开机密码",
          description: "清除后，AI 锁屏时不能再自动解锁了（「锁屏后台模式」不受影响）。需要时可以重新保存。",
          confirmLabel: "清除",
          destructive: true,
        }),
      );
      expect(v.bridge.clearCredential).toHaveBeenCalledTimes(1);
      expect(onLockedAccessChange).not.toHaveBeenCalled(); // 开关保持开
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it("清除失败：同样 toast 原因、不刷新", async () => {
      const onRefresh = vi.fn();
      const v = mountWin({
        status: makeWinStatus({ unlockHelper: helperInstalled, credentialSet: true }),
        lockedAccess: true,
        onRefresh,
      });
      v.bridge.clearCredential.mockResolvedValueOnce({ ok: false, error: "解锁组件没有响应" });
      h.confirm.mockResolvedValue(true);
      call(v.block(), "onClearCredential");
      await flush();
      expect(h.toastError).toHaveBeenCalledExactlyOnceWith("清除失败：解锁组件没有响应");
      expect(onRefresh).not.toHaveBeenCalled();
    });

    it("总开关（开 → 关）且锁屏开关开着：和 macOS 一样先关总开关、再关锁屏开关、再清密码", async () => {
      const onEnabledChange = vi.fn<(next: boolean) => Promise<void>>(async () => undefined);
      const onLockedAccessChange = vi.fn<(next: boolean) => Promise<void>>(async () => undefined);
      const v = mountWin({
        status: makeWinStatus({ unlockHelper: helperInstalled, credentialSet: true }),
        lockedAccess: true,
        onEnabledChange,
        onLockedAccessChange,
      });
      call(v.master(), "onCheckedChange", false);
      await flush();
      expect(onEnabledChange).toHaveBeenCalledExactlyOnceWith(false);
      expect(onLockedAccessChange).toHaveBeenCalledExactlyOnceWith(false);
      expect(v.bridge.clearCredential).toHaveBeenCalledTimes(1);
      expect(order(onEnabledChange)).toBeLessThan(order(onLockedAccessChange));
      expect(order(onLockedAccessChange)).toBeLessThan(order(v.bridge.clearCredential));
    });
  });
});

// ===========================================================================
// 5. 状态轮询 hook
// ===========================================================================
describe("useComputerUseStatus：取桥 + 取状态 + 轮询", () => {
  let visibility: "visible" | "hidden";
  let bridge: MockBridge;
  let harness: ReturnType<typeof createHookHarness>;

  const read = () => harness.render(() => useComputerUseStatus());
  const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

  /** 挂载：首帧（bridge=null，同 SSR / 水合）→ effect 取桥 → 拿到桥的一帧 → effect 首次取状态 + 起 timer */
  const mount = () => {
    read();
    harness.flushEffects();
    const api = read();
    harness.flushEffects();
    return api;
  };

  /** 让 getStatus 的每次调用都挂起，由测试手动放行（返回「第 n 次调用的 resolve」） */
  const holdStatusCalls = () => {
    const pending: Array<(s: ComputerUseStatus) => void> = [];
    bridge.getStatus.mockImplementation(
      () =>
        new Promise<ComputerUseStatus>((resolve) => {
          pending.push(resolve);
        }),
    );
    return pending;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    visibility = "visible";
    bridge = makeBridge();
    harness = createHookHarness();
    vi.stubGlobal("window", {
      __computerUse: bridge,
      // 包一层：fake timers 装好之后才解析全局的 setInterval
      setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
      clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
    });
    vi.stubGlobal("document", {
      get visibilityState() {
        return visibility;
      },
    });
  });

  afterEach(() => {
    harness.unmount();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("挂载后才取桥：首帧（SSR / 水合）bridge 为 null，effect 之后拿到 window.__computerUse", () => {
    expect(read().bridge).toBeNull();
    harness.flushEffects();
    expect(read().bridge).toBe(bridge);
  });

  it("拿到桥立刻取一次状态并采纳", async () => {
    bridge.getStatus.mockResolvedValue(makeStatus({ credentialSet: true }));
    mount();
    await advance(0);
    expect(bridge.getStatus).toHaveBeenCalledTimes(1);
    expect(read().status?.credentialSet).toBe(true);
  });

  it("此后每 3 秒轮询一次", async () => {
    mount();
    await advance(0);
    expect(bridge.getStatus).toHaveBeenCalledTimes(1);
    await advance(2999);
    expect(bridge.getStatus).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(bridge.getStatus).toHaveBeenCalledTimes(2);
    await advance(3000);
    expect(bridge.getStatus).toHaveBeenCalledTimes(3);
  });

  it("页面不可见时跳过轮询，重新可见后的下一个 tick 恢复", async () => {
    mount();
    await advance(0);
    visibility = "hidden";
    await advance(9000);
    expect(bridge.getStatus).toHaveBeenCalledTimes(1);
    visibility = "visible";
    await advance(3000);
    expect(bridge.getStatus).toHaveBeenCalledTimes(2);
  });

  it("上一次轮询还没回来就跳过下一个 tick（主进程慢时不叠请求），回来之后恢复", async () => {
    const pending = holdStatusCalls();
    mount();
    await advance(0); // 挂载时那次（不走轮询的在途标记）
    expect(pending).toHaveLength(1);
    await advance(3000); // tick 1：发起第 2 次，挂起
    expect(pending).toHaveLength(2);
    await advance(9000); // tick 2~4：第 2 次还在途 → 全部跳过
    expect(pending).toHaveLength(2);

    pending[1]?.(makeStatus());
    await advance(0);
    await advance(3000);
    expect(pending).toHaveLength(3);
  });

  it("旧响应不盖新快照：慢响应迟到时，操作后采纳的最新状态保持不变", async () => {
    const pending = holdStatusCalls();
    const api = mount();
    await advance(0); // 挂载那次（序号 1）挂起
    api.adopt(makeStatus({ credentialSet: true })); // 用户操作返回的最新状态（序号 2）
    expect(read().status?.credentialSet).toBe(true);

    pending[0]?.(makeStatus({ credentialSet: false })); // 序号 1 的旧响应迟到
    await advance(0);
    expect(read().status?.credentialSet).toBe(true);
  });

  it("两次 refresh 乱序返回：后发出的那次胜出", async () => {
    const pending = holdStatusCalls();
    const api = mount();
    await advance(0); // 序号 1
    void api.refresh(); // 序号 2
    await advance(0);
    expect(pending).toHaveLength(2);

    pending[1]?.(makeStatus({ credentialSet: true })); // 新的先回来
    await advance(0);
    pending[0]?.(makeStatus({ credentialSet: false })); // 旧的后回来
    await advance(0);
    expect(read().status?.credentialSet).toBe(true);
  });

  it("refresh()：用户操作后立即重取一次并采纳（不等下一轮轮询）", async () => {
    const api = mount();
    await advance(0);
    expect(bridge.getStatus).toHaveBeenCalledTimes(1);
    bridge.getStatus.mockResolvedValueOnce(makeStatus({ credentialSet: true }));
    await api.refresh();
    expect(bridge.getStatus).toHaveBeenCalledTimes(2);
    expect(read().status?.credentialSet).toBe(true);
  });

  it("读失败静默：保留旧快照、不弹错，下一轮恢复", async () => {
    bridge.getStatus.mockResolvedValueOnce(makeStatus({ credentialSet: true }));
    mount();
    await advance(0);
    expect(read().status?.credentialSet).toBe(true);

    bridge.getStatus.mockRejectedValueOnce(new Error("ipc 断了"));
    await advance(3000);
    expect(read().status?.credentialSet).toBe(true);
    expect(h.toastError).not.toHaveBeenCalled();

    bridge.getStatus.mockResolvedValueOnce(makeStatus({ credentialSet: false }));
    await advance(3000);
    expect(read().status?.credentialSet).toBe(false);
  });

  it("一直读不到状态：头一次失败不吭声（启动瞬间主进程可能忙），连续第二次才给原因；读成功就清掉；始终不弹 toast", async () => {
    bridge.getStatus.mockRejectedValue(
      new Error("Error invoking remote method 'computer-use:status': Error: No handler registered for 'computer-use:status'"),
    );
    mount();
    await advance(0);
    expect(read().status).toBeNull();
    expect(read().statusError).toBeNull();

    await advance(3000);
    expect(read().statusError).toBe("No handler registered for 'computer-use:status'");
    await advance(3000);
    expect(read().statusError).toBe("No handler registered for 'computer-use:status'");
    expect(h.toastError).not.toHaveBeenCalled();

    // 主进程好了：状态来了，原因清掉
    bridge.getStatus.mockReset();
    bridge.getStatus.mockResolvedValue(makeStatus());
    await advance(3000);
    expect(read().status).not.toBeNull();
    expect(read().statusError).toBeNull();
  });

  it("失败不连续就不说：失败 → 成功 → 失败，计数被成功清零，始终没有 statusError", async () => {
    bridge.getStatus.mockRejectedValueOnce(new Error("忙"));
    mount();
    await advance(0);
    bridge.getStatus.mockResolvedValueOnce(makeStatus());
    await advance(3000);
    bridge.getStatus.mockRejectedValueOnce(new Error("忙"));
    await advance(3000);
    expect(read().statusError).toBeNull();
    // 这时再失败一次才算「连续两次」
    bridge.getStatus.mockRejectedValueOnce(new Error("还是忙"));
    await advance(3000);
    expect(read().statusError).toBe("还是忙");
    // 已有快照：View 不会显示它（见渲染测试），hook 如实暴露；读成功即清
    expect(read().status).not.toBeNull();
    bridge.getStatus.mockResolvedValueOnce(makeStatus());
    await advance(3000);
    expect(read().statusError).toBeNull();
  });

  // 第三轮评审：getStatus 的返回值以前原样采纳（TS 类型只是编译期的承诺），残缺的快照会让 View 渲染时抛 TypeError
  it("格式不对的快照 = 读失败：保留旧快照；连续第二次起给出原因（不弹 toast）；之后读到正常快照就恢复、清掉原因", async () => {
    bridge.getStatus.mockResolvedValueOnce(makeStatus({ credentialSet: true }));
    mount();
    await advance(0);
    expect(read().status?.credentialSet).toBe(true);

    // 界面和主进程版本不一致：缺 permissions / session
    bridge.getStatus.mockResolvedValue({ platform: "darwin", enabled: true } as unknown as ComputerUseStatus);
    await advance(3000); // 头一次：不吭声
    expect(read().status?.credentialSet).toBe(true);
    expect(read().statusError).toBeNull();
    await advance(3000); // 连续第二次：给原因
    expect(read().status?.credentialSet).toBe(true); // 旧快照还在
    expect(read().statusError).toContain("格式不对");
    expect(h.toastError).not.toHaveBeenCalled();

    bridge.getStatus.mockReset();
    bridge.getStatus.mockResolvedValue(makeStatus({ credentialSet: false }));
    await advance(3000);
    expect(read().status?.credentialSet).toBe(false);
    expect(read().statusError).toBeNull();
  });

  it("一上来就读到格式不对的快照：status 保持 null（残缺对象不会交给 View 去渲染），原因照样给", async () => {
    bridge.getStatus.mockResolvedValue({ platform: "win32" } as unknown as ComputerUseStatus);
    mount();
    await advance(0);
    expect(read().status).toBeNull();
    expect(read().statusError).toBeNull(); // 头一次
    await advance(3000);
    expect(read().status).toBeNull();
    expect(read().statusError).toContain("格式不对");
  });

  it("adopt()（用户操作返回的快照）同样不采纳格式不对的：旧快照留着，之后正常的快照照常采纳", async () => {
    const api = mount();
    await advance(0);
    api.adopt(makeStatus({ credentialSet: true }));
    api.adopt({ nope: 1 } as unknown as ComputerUseStatus);
    api.adopt(null as unknown as ComputerUseStatus);
    expect(read().status?.credentialSet).toBe(true);
    api.adopt(makeStatus({ credentialSet: false }));
    expect(read().status?.credentialSet).toBe(false);
  });

  it("ComputerUseSection 把 hook 的 statusError 原样交给 View", async () => {
    bridge.getStatus.mockRejectedValue(new Error("没有回应"));
    const section = () => harness.render(() => ComputerUseSection({ enabled: false, onEnabledChange: vi.fn(), lockedAccess: false, onLockedAccessChange: vi.fn() }));
    section();
    harness.flushEffects();
    section();
    harness.flushEffects();
    await advance(0);
    await advance(3000);
    const view = section() as ReactElement<Record<string, unknown>>;
    expect(view.type).toBe(ComputerUseView);
    expect(view.props.statusError).toBe("没有回应");
    expect(view.props.status).toBeNull();
  });

  it("卸载清 timer：之后不再轮询；卸载后才回来的响应不再 setState", async () => {
    const pending = holdStatusCalls();
    mount();
    await advance(0);
    expect(vi.getTimerCount()).toBe(1);

    harness.unmount();
    expect(vi.getTimerCount()).toBe(0);
    await advance(9000);
    expect(pending).toHaveLength(1);

    pending[0]?.(makeStatus({ credentialSet: true }));
    await advance(0);
    expect(read().status).toBeNull();
  });

  it("无桥（网页版）：不取状态、不起 timer，状态恒为 null", async () => {
    vi.stubGlobal("window", {});
    mount();
    await advance(9000);
    expect(bridge.getStatus).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(read().bridge).toBeNull();
    expect(read().status).toBeNull();
  });
});

// ===========================================================================
// 6. 桥取用 / 接线 / 契约
// ===========================================================================
describe("getComputerUseBridge：SSR 安全地取 window.__computerUse", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("没有 window（SSR / 水合前）→ null，不抛", () => {
    vi.stubGlobal("window", undefined);
    expect(getComputerUseBridge()).toBeNull();
  });

  it("网页版：有 window 但没有 __computerUse → null", () => {
    vi.stubGlobal("window", {});
    expect(getComputerUseBridge()).toBeNull();
  });

  it("桌面端：返回 preload 暴露的那个桥", () => {
    const bridge = makeBridge();
    vi.stubGlobal("window", { __computerUse: bridge });
    expect(getComputerUseBridge()).toBe(bridge);
  });
});

// 第三轮评审：开关旁边的文字和开关本身没有 DOM 关联（SettingRow 只是把它们并排放），读屏只念「开关」——授权类开关必须自己带名字；
// 动态冒出来的提醒（对不上 / 读不到 / 门禁原因）用 role=status 通知读屏；开机密码框不该被浏览器当登录表单去自动填充
describe("无障碍：开关有名字 / 动态提醒是 status 区域 / 开机密码框", () => {
  const switchTags = (markup: string): string[] => markup.match(/<span [^>]*role="switch"[^>]*>/g) ?? [];
  /** 所有 role=status 的 span 的内文（SSR 里文本里没有嵌套标签） */
  const statusTexts = (markup: string): string[] =>
    [...markup.matchAll(/<span role="status"[^>]*>([\s\S]*?)<\/span>/g)].map((m) => m[1] ?? "");
  const hasStatus = (markup: string, text: string): boolean => statusTexts(markup).some((t) => t.includes(text));

  it("Switch 组件把 aria-label / aria-labelledby / aria-describedby 透传到 role=switch 节点；没传就不带", () => {
    const tag =
      switchTags(
        renderToStaticMarkup(
          createElement(Switch, {
            checked: true,
            onCheckedChange: () => {},
            "aria-label": "名字",
            "aria-labelledby": "lbl",
            "aria-describedby": "desc",
          }),
        ),
      )[0] ?? "";
    expect(tag).toContain('aria-label="名字"');
    expect(tag).toContain('aria-labelledby="lbl"');
    expect(tag).toContain('aria-describedby="desc"');
    const bare =
      switchTags(renderToStaticMarkup(createElement(Switch, { checked: false, onCheckedChange: () => {} })))[0] ?? "";
    expect(bare).toContain('role="switch"');
    expect(bare).not.toContain("aria-label");
  });

  it("macOS：总开关叫「电脑操作」、锁屏那一行叫「锁屏时也能用」，role=switch 节点都带 aria-label", () => {
    const tags = switchTags(html());
    expect(tags).toHaveLength(2);
    expect(tags[0]).toContain('aria-label="电脑操作"');
    expect(tags[1]).toContain('aria-label="锁屏时也能用"');
  });

  it("Windows：两个开关同样有名字", () => {
    const tags = switchTags(html({ status: makeWinStatus() }));
    expect(tags).toHaveLength(2);
    expect(tags[0]).toContain('aria-label="电脑操作"');
    expect(tags[1]).toContain('aria-label="锁屏时也能用"');
  });

  // R20-13：S-8f 的注释说「锁屏时也能用」的两个开关也会把安全披露念出来，但风险说明是开关下面另起的一段 <p>、不在 hint 里，
  // 以前读屏聚焦开关只念 hint——风险段（「AI 能看到并操作你已经打开的应用」/「建议只在个人电脑上开启」）听不到。现在开关用 extraDescribedBy 指向它。
  describe("R20-13「锁屏时也能用」开关：读屏聚焦时 hint 与行外的风险说明一起念", () => {
    const describedIds = (tag: string): string[] => (/\saria-describedby="([^"]*)"/.exec(tag)?.[1] ?? "").split(" ").filter(Boolean);
    /** 带 id=<id> 的元素内文（hint 里没有嵌套标签时是纯文字；风险段是纯文字 <p>） */
    const textOf = (markup: string, id: string): string | undefined =>
      new RegExp(`id="${id.replace(/[.*+?^${}()|[\]\\:]/g, "\\$&")}"[^>]*>([^<]*)<`).exec(markup)?.[1];
    const unescape = (s: string | undefined) => (s ?? "").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

    it("macOS：describedby = [行的 hint, 风险段]，风险段的 id 与 <p> 对得上，原文就是 RISK_TEXT", () => {
      const markup = html();
      const [hintId, riskId, ...rest] = describedIds(switchTags(markup)[1]!);
      expect(rest).toEqual([]);
      expect(hintId).toBeTruthy();
      expect(riskId).toBeTruthy();
      expect(hintId).not.toBe(riskId);
      expect(unescape(textOf(markup, hintId!))).toBe(LOCKED_DESC);
      expect(unescape(textOf(markup, riskId!))).toBe(RISK_TEXT);
      expect(markup.split(`id="${riskId}"`).length - 1).toBe(1);
    });

    it("Windows：同样 [hint, 风险段]，风险段原文就是 WIN_RISK_TEXT", () => {
      const markup = html({ status: makeWinStatus() });
      const [hintId, riskId, ...rest] = describedIds(switchTags(markup)[1]!);
      expect(rest).toEqual([]);
      expect(hintId).not.toBe(riskId);
      expect(unescape(textOf(markup, hintId!))).toBe(WIN_LOCKED_DESC);
      expect(unescape(textOf(markup, riskId!))).toBe(WIN_RISK_TEXT);
    });

    it("总开关「电脑操作」没有行外风险段：describedby 只有它自己那一行的 hint（没被误接上锁屏的风险段）", () => {
      for (const markup of [html(), html({ status: makeWinStatus() })]) {
        const ids = describedIds(switchTags(markup)[0]!);
        expect(ids).toHaveLength(1);
        expect(unescape(textOf(markup, ids[0]!))).toContain("让 AI 操作这台电脑上的任何应用");
      }
    });

    it("风险段不依赖状态：开着 / 关着、有门禁原因时开关的 describedby 都带着它", () => {
      const variants = [
        html({ lockedAccess: true }),
        html({ lockedAccess: false }),
        html({ enabled: true, lockedAccess: false, status: makeStatus({ enabled: false }) }),
        html({ lockedAccess: true, status: makeWinStatus({ lockedAccessEnabled: true }) }),
      ];
      for (const markup of variants) {
        const ids = describedIds(switchTags(markup)[1]!);
        expect(ids).toHaveLength(2);
        expect(textOf(markup, ids[1]!)).toBeTruthy();
      }
    });

    it("源码结构：两个区块各自用 useId 生成风险段 id，且 hook 在提前 return 之前（macOS 区块有三个提前 return）", () => {
      const card = readCode("src/components/settings/computer-use-card.tsx");
      expect(card.match(/const riskId = useId\(\);/g)).toHaveLength(2);
      expect(card.match(/extraDescribedBy=\{riskId\}/g)).toHaveLength(2);
      expect(card.match(/<p id=\{riskId\} className="text-xs text-muted-foreground">/g)).toHaveLength(2);
      const mac = card.slice(card.indexOf("const LockedAccessBlock = ({"));
      expect(mac.indexOf("const riskId = useId();")).toBeGreaterThan(-1);
      expect(mac.indexOf("const riskId = useId();")).toBeLessThan(mac.indexOf("if (status && !status.lockedAccessSupported)"));
    });
  });

  it("装配失败后只留下的那一行「锁屏时也能用」（只能关）：开关同样有名字", () => {
    const status = makeStatus({
      supported: false,
      lockedAccessSupported: false,
      driverReady: false,
      driverError: "磁盘只读",
      lockedAccessNote: "磁盘只读",
      enabled: false,
      lockedAccessEnabled: false,
      permissions: perms("unknown", "unknown"),
    });
    const tags = switchTags(html({ enabled: true, lockedAccess: true, status }));
    expect(tags).toHaveLength(2);
    expect(tags[0]).toContain('aria-label="电脑操作"');
    expect(tags[1]).toContain('aria-label="锁屏时也能用"');
  });

  it("动态提醒带 role=status：总开关与实际对不上（macOS）", () => {
    const markup = html({ enabled: false, status: makeStatus({ enabled: true }) });
    expect(hasStatus(markup, "「电脑操作」还没有真正关掉")).toBe(true);
  });

  it("动态提醒带 role=status：macOS 锁屏开关的对不上说明、门禁原因", () => {
    const mismatch = html({ lockedAccess: false, status: makeStatus({ lockedAccessEnabled: true, credentialSet: true }) });
    expect(hasStatus(mismatch, "「锁屏时也能用」还没有真正关掉")).toBe(true);
    const gated = html({ enabled: true, lockedAccess: false, status: makeStatus({ enabled: false }) });
    expect(hasStatus(gated, "需要先开启「电脑操作」")).toBe(true);
  });

  it("动态提醒带 role=status：Windows 锁屏开关的对不上说明、门禁原因、后台组件没就绪的警告", () => {
    const mismatch = html({ lockedAccess: false, status: makeWinStatus({ lockedAccessEnabled: true }) });
    expect(hasStatus(mismatch, "「锁屏时也能用」还没有真正关掉")).toBe(true);
    const gated = html({ enabled: true, lockedAccess: false, status: makeWinStatus({ enabled: false }) });
    expect(hasStatus(gated, "需要先开启「电脑操作」")).toBe(true);
    const bgDown = html({ status: makeWinStatus({ backgroundReady: false, backgroundError: "缺少 koffi" }) });
    expect(hasStatus(bgDown, "锁屏后台模式暂时用不了：缺少 koffi")).toBe(true);
  });

  it("动态提醒带 role=status：读不到状态的说明", () => {
    const markup = html({ status: null, statusError: "没有回应" });
    expect(hasStatus(markup, "暂时读不到电脑操作的状态（没有回应）")).toBe(true);
  });

  it("没有任何提醒时不出空的 status 区域", () => {
    expect(html()).not.toContain('role="status"');
    expect(html({ status: makeWinStatus() })).not.toContain('role="status"');
  });

  it("开机密码框：autoComplete=new-password（不被当登录表单自动填充 / 弹「保存密码」）+ 有可读名字（SSR 看不到对话框，守源码）", () => {
    const card = readCode("src/components/settings/computer-use-card.tsx");
    const input = /<PasswordInput\b[\s\S]*?\/>/.exec(card)?.[0] ?? "";
    expect(input).toContain('autoComplete="new-password"');
    expect(input).toContain('aria-label="开机密码"');
    expect(input).not.toContain('autoComplete="off"');
  });
});

describe("源码契约：设置页接线 / 开机密码不落设置 / UI 约定", () => {
  const CARD = "src/components/settings/computer-use-card.tsx";

  it("设置页：两个开关经 saveFieldValue 落盘，只在严格 === true 时显示为开", () => {
    const page = read("src/app/settings/page.tsx");
    expect(page).toContain(
      'import { ComputerUseSection } from "@/components/settings/computer-use-card";',
    );
    expect(page).toMatch(/enabled=\{settings\.computerUse === true\}/);
    expect(page).toMatch(/saveFieldValue\("computerUse", v\)/);
    expect(page).toMatch(/lockedAccess=\{settings\.computerUseLockedAccess === true\}/);
    expect(page).toMatch(/saveFieldValue\(\s*"computerUseLockedAccess",\s*v\s*\)/);
  });

  it("设置页：电脑操作卡在「内置浏览器」卡之后、「仓库」卡之前，左侧导航里也是这个顺序（2026-11-24 起两张卡都有独立入口）", () => {
    const page = read("src/app/settings/page.tsx");
    const at = (key: string) => page.search(new RegExp(`wrapCard\\(\\s*"${key}"`));
    expect(at("browser")).toBeGreaterThan(-1);
    expect(at("computer-use")).toBeGreaterThan(at("browser"));
    expect(at("repos")).toBeGreaterThan(at("computer-use"));
    const nav = /const NAV_ITEMS[^=]*=\s*\[([\s\S]*?)\n\];/.exec(page)?.[1] ?? "";
    expect(nav).toContain('"repos"'); // 确认提取到了导航表
    // 以前这两张卡游离在导航之外：滚到它们时导航高亮停在「偏好」、也点不到
    expect(nav).toContain('"computer-use"');
    expect(nav.indexOf('"browser"')).toBeGreaterThan(-1);
    expect(nav.indexOf('"computer-use"')).toBeGreaterThan(nav.indexOf('"browser"'));
    expect(nav.indexOf('"repos"')).toBeGreaterThan(nav.indexOf('"computer-use"'));
  });

  it("卡片只经 bridge.setCredential 单向交出密码：不碰 settings / 存储 / 网络 / 日志（只看代码，不看注释）", () => {
    const card = readCode(CARD);
    expect(card).toMatch(/setCredential\(\{ password \}\)/);
    expect(card).not.toMatch(/saveFieldValue|saveSettings|patchSettings|updateSettings/);
    expect(card).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
    expect(card).not.toMatch(/\bfetch\(|XMLHttpRequest|navigator\.sendBeacon/);
    expect(card).not.toMatch(/console\./);
    // 对话框用掩码输入，不用 useDialog().prompt（明文单行）
    expect(card).toContain("<PasswordInput");
    expect(card).not.toMatch(/\bprompt\(/);
  });

  it("Section 把轮询 hook 的 adopt / refresh 接给 View", () => {
    const card = readCode(CARD);
    expect(card).toMatch(/onStatus=\{adopt\}[\s\S]*?onRefresh=\{refresh\}/);
  });

  it("保存开机密码对话框的固定文案（SSR 看不到，这里守原文）", () => {
    const card = readCode(CARD);
    expect(card).toContain("<DialogTitle>保存开机密码</DialogTitle>");
    expect(card).toContain(
      "用于锁屏时自动解锁。只保存在本机 Flowship 专用的钥匙串里，不会上传；升级 Flowship 后一般不用重新输入。目前只支持由英文字母、数字和常见符号组成的密码。",
    );
    expect(card).toMatch(/取消\s*<\/Button>/);
    expect(card).toMatch(/保存\s*<\/Button>/);
  });

  it("保存开机密码对话框（Windows 版）的固定文案：存在解锁组件里（加密）、只支持常见字符、默认要输 PIN 的电脑暂不支持；对话框按平台选文案", () => {
    const card = readCode(CARD);
    expect(card).toContain(
      "用于锁屏时自动解锁。由解锁组件用 Windows 数据保护加密后保存在本机，不会上传，也不会给 AI 看。目前只支持由英文字母、数字和常见符号组成的密码；锁屏界面默认要输入 PIN 的电脑暂不支持自动解锁。",
    );
    expect(card).toMatch(/platform === "win32" \? CREDENTIAL_DESC_WIN : CREDENTIAL_DESC_MAC/);
  });

  it("遵守 UI 约定：无原生 title 属性 / alert·confirm·prompt / 动效禁用项 / 原色 / text-white", () => {
    const card = readCode(CARD);
    expect(card).not.toMatch(/\btitle=/);
    expect(card).not.toMatch(/window\.(alert|confirm|prompt)\(|\balert\(/);
    expect(card).not.toMatch(/animate-(pulse|ping)|backdrop-blur|text-white/);
    expect(card).not.toMatch(
      /\b(?:text|bg|border)-(?:red|green|amber|yellow|blue|gray|slate|zinc|neutral|stone|orange|emerald|rose|sky|indigo|violet|purple|pink|teal|cyan|lime|fuchsia)-\d{2,3}\b/,
    );
  });
});

describe("契约对账：electron-app/desktop/types.mjs ⇄ src/lib/computer-use-bridge.ts", () => {
  // 唯一权威是 types.mjs（JSDoc）；改协议先改契约，再同步这里的 TS 翻译

  /** 契约里某个 @typedef 块的 @property 名字（可选的 `[name]` 去掉方括号） */
  const contractProps = (typedef: string): string[] => {
    const contract = read("electron-app/desktop/types.mjs");
    const block = new RegExp(`@typedef \\{Object\\} ${typedef}\\b([\\s\\S]*?)\\*/`).exec(
      contract,
    )?.[1];
    if (!block) throw new Error(`契约里找不到 ${typedef}`);
    return [...block.matchAll(/^ \* @property \{.*\} \[?(\w+)\]?/gm)].map((m) => m[1] ?? "");
  };

  /** TS 接口第一层（两空格缩进）的成员名 */
  const tsMembers = (iface: string): string[] => {
    const src = read("src/lib/computer-use-bridge.ts");
    const block = new RegExp(`export interface ${iface} \\{\\n([\\s\\S]*?)\\n\\}`).exec(src)?.[1];
    if (!block) throw new Error(`TS 里找不到 ${iface}`);
    return [...block.matchAll(/^ {2}(\w+)\??[:(]/gm)].map((m) => m[1] ?? "");
  };

  it("ComputerUseStatus：字段名一致", () => {
    expect(tsMembers("ComputerUseStatus").sort()).toEqual(contractProps("ComputerUseStatus").sort());
  });

  it("ComputerUseBridge：方法名一致（桥上没有「读回凭据」之类契约外的方法）", () => {
    expect(tsMembers("ComputerUseBridge").sort()).toEqual(contractProps("ComputerUseBridge").sort());
  });

  it("ComputerUseBridge：每个方法的参数名、返回值形状也一致，不只是方法名（包括后加的 testBackground / installUnlockHelper / uninstallUnlockHelper）", () => {
    const contract = contractBridgeMethods();
    const ts = tsBridgeMethods();
    // 解析自检：悄悄少解析几个方法，下面的逐个对账就空了
    expect(contract.length).toBeGreaterThanOrEqual(10);
    expect(contract.map((m) => m.name)).toEqual(
      expect.arrayContaining(["testBackground", "installUnlockHelper", "uninstallUnlockHelper"]),
    );
    expect(ts.map((m) => m.name).sort()).toEqual(contract.map((m) => m.name).sort());
    for (const expected of contract) {
      expect(ts.find((m) => m.name === expected.name), expected.name).toEqual(expected);
    }
  });
});
