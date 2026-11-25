"use client";

/**
 * 「电脑操作」设置节：让 AI 操作这台电脑上的任何应用（截图 / 点击 / 输入），含「锁屏时也能用」。
 *
 * 数据分两条线（别混）：
 * - 两个开关（computerUse / computerUseLockedAccess）是普通设置：父组件经 saveFieldValue 落 config.json，这里只收 props——
 *   但开关**显示**的值以主进程的实际状态（status.enabled / lockedAccessEnabled）为准，props 只是设置草稿（乐观更新，写盘失败后会和实际不一致）：
 *   用户刚点的那一下先按目标值显示，对不上就显示实际状态并给常驻说明（见 shownSwitchState / getSwitchMismatchNote）；
 * - 权限 / 凭据 / 原生组件 / 锁屏这类「这台机器的实时状态」只能问主进程：经 window.__computerUse
 *   （preload 暴露，见 @/lib/computer-use-bridge），挂载时取一次、挂载期间每 3 秒轮询、用户操作后立即刷新。
 *
 * 开机密码**绝不**进 settings（明文 JSON、会被 /full 接口回传前端缓存）：只经 bridge.setCredential 单向写进系统钥匙串。
 * 在本文件里它只存在于「保存开机密码」对话框的输入框 state 里，保存 / 关闭即丢，不落任何存储、不进日志、不进 toast。
 *
 * 开机密码的生命周期跟着「锁屏时也能用」走：关掉这个开关（或在它开着时关掉「电脑操作」总开关）会把钥匙串里的密码一并清掉——
 * 关掉的功能不该还留着一份能自动解锁电脑的密码；再开启时会重新要求保存（见 disableLockedAccessFlow）。
 * 总开关从关到开每次都弹一次风险确认（无状态、不用再多存一个「已确认过」的设置）。
 *
 * Windows 的「锁屏时也能用」有两条路线，在这里分开讲（见 WindowsLockedAccessBlock）：
 * - 锁屏后台模式（默认）：电脑一直锁着，AI 通过窗口消息操作锁屏前已经打开的应用——不解锁、不需要开机密码、不需要装任何东西；
 * - 解锁组件（可选）：后台模式不够用时（某些应用锁屏时画不出界面）才用——装一个以系统身份运行的小服务 + 保存开机密码，
 *   AI 才能自动解锁、盖遮罩、做完再锁回去。开机密码此时存在解锁组件里（Windows 数据保护加密），不在 settings、不经本文件落地。
 * 所以 Windows 上开启「锁屏时也能用」**不**要求先存开机密码；清除开机密码也只是去掉「自动解锁」，不会关掉这个开关。
 *
 * 布局定式同「内置浏览器」卡：统一设置行（名称 + 一句说明 | 控件）、divide-y 分隔。
 * 无桌面壳（浏览器里访问 / pnpm dev:web）时桥不存在：整块禁用并提示「仅桌面端可用」——
 * 不隐藏，免得用户找不到、也搞不清为什么没有。
 *
 * 拆分：Section（取桥 + 轮询状态）→ View（纯展示 + 交互，status 由外部注入，方便单测各种状态）→
 * 权限行 / 锁屏区块 / 测试 / 导出 / 密码对话框各自一个小组件，各管各的局部 state。
 */

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PasswordInput } from "@/components/ui/password-input";
import { SettingRow } from "@/components/ui/setting-row";
import { Switch } from "@/components/ui/switch";
import { useDialog } from "@/hooks/use-dialog";
import {
  getComputerUseBridge,
  type ComputerUseBridge,
  type ComputerUsePermissionKind,
  type ComputerUseStatus,
  type LockedAccessTestResult,
} from "@/lib/computer-use-bridge";
import { isImeComposing } from "@/lib/ime";
import { cn } from "@/lib/utils";

/** 状态轮询间隔：用户去系统设置勾完权限再切回来，最迟 3 秒内能看到「已授权」 */
const POLL_INTERVAL_MS = 3000;

/** 连续读失败几次才对用户说「读不到状态」：头一下失败（启动瞬间主进程忙）不算，下一轮再失败才说 */
export const STATUS_ERROR_AFTER_FAILURES = 2;

/**
 * 同一个开机密码在常见序列化里的所有写法（去重、**长的在前**）：原样、JSON 字符串里的样子（`"` → `\"`、`\` → `\\`）、
 * `encodeURIComponent`、反斜杠转义引号。与主进程 `electron-app/desktop/redact-secret.mjs` 的 `secretForms` 同一份约定
 * （渲染进程不能 import 那边的 .mjs，所以各写一份，`tests/desktop-redact-secret.test.ts` 有对拍，改一边要改另一边）。
 * 生成不出来的写法（畸形 UTF-16 让 `encodeURIComponent` 抛 URIError）跳过那一种。
 */
export const secretForms = (secret: string): string[] => {
  const forms = new Set<string>([secret]);
  const add = (make: () => string) => {
    try {
      const v = make();
      if (v !== "") forms.add(v);
    } catch {
      /* 这一种写法生成不出来：跳过 */
    }
  };
  add(() => JSON.stringify(secret).slice(1, -1));
  add(() => encodeURIComponent(secret));
  add(() => secret.replace(/[\\'"]/g, "\\$&"));
  return [...forms].sort((a, b) => b.length - a.length);
};

/**
 * 展示前把错误文字里的开机密码抹掉（含上面几种序列化写法）。主进程 / IPC 层的报错本不该带它，但万一哪天有人把入参回显进了报错
 * （「密码 xxx 不合法」之类），toast 会被截图 / 录屏——这是整台电脑的登录密码，宁可多抹一道。
 * secret 为空 = 没有要抹的，原样返回。
 */
export const scrubSecret = (text: string, secret: string): string => {
  if (!secret) return text;
  let out = text;
  for (const form of secretForms(secret)) out = out.split(form).join("•••");
  return out;
};

/**
 * 错误整理成能直接给用户看的一句：去掉 Electron 给 IPC 错误加的前缀
 * （「Error invoking remote method 'computer-use:status': Error: …」）、折叠空白、限长 120 字；没有信息就用 fallback。
 * secret：先抹密码、再截断（先截断的话，被截成半截的密码就认不出来了）。
 */
const readableErrorText = (err: unknown, fallback: string, secret = ""): string => {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const text = scrubSecret(raw, secret)
    .replace(/^Error invoking remote method '[^']*':\s*/, "")
    .replace(/^Error:\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return text || fallback;
};

/** 读状态失败的原因，整理成能直接给用户看的一句；没有信息就说「没有回应」 */
export const statusReadErrorText = (err: unknown): string => readableErrorText(err, "主进程没有回应");

/** 主进程回的状态快照格式不对时给用户看的原因（走 statusError 那条「读不到状态」的路径） */
const STATUS_SHAPE_ERROR = "主进程返回的状态格式不对（界面和主进程的版本可能不一致）";

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * 运行时校验：状态快照是跨进程传来的（主进程 / preload 与界面的版本可能不一致——应用更新后没重启、开发时只重启了一边），
 * TS 类型只是编译期的承诺（第三轮评审：以前原样采纳）。只查卡片会**无保护地解引用**的字段——缺了会在渲染里抛 TypeError、整张卡白屏：
 * 平台、各布尔开关、permissions / session 两个子对象。不查可选字段，也不限定枚举值的集合（新版本多出一个枚举值不该让旧界面整个读不了状态）。
 */
export const isComputerUseStatus = (value: unknown): value is ComputerUseStatus => {
  if (!isPlainObject(value)) return false;
  if (value.platform !== "darwin" && value.platform !== "win32" && value.platform !== "other") return false;
  for (const key of [
    "enabled",
    "lockedAccessEnabled",
    "supported",
    "lockedAccessSupported",
    "driverReady",
    "credentialSet",
    "lockedAccessReady",
  ] as const) {
    if (typeof value[key] !== "boolean") return false;
  }
  const { permissions, session } = value;
  if (!isPlainObject(permissions)) return false;
  if (typeof permissions.accessibility !== "string" || typeof permissions.screen !== "string") return false;
  if (!isPlainObject(session)) return false;
  if (typeof session.active !== "boolean" || typeof session.unlockedByUs !== "boolean") return false;
  return true;
};

/** 需要授权的两项系统权限（仅 macOS 展示）：行名 + 对应桥参数 */
const PERMISSION_ITEMS: ReadonlyArray<{
  kind: ComputerUsePermissionKind;
  label: string;
}> = [
  { kind: "accessibility", label: "辅助功能" },
  { kind: "screen", label: "屏幕录制" },
];

/**
 * 操作失败的原因，整理成能直接给用户看的一句（见 readableErrorText：去 IPC 前缀 / 折叠空白 / 限长）。
 * 第三轮评审：以前原样把 `err.message` 拼进 toast——Electron 的 IPC 报错带着 `Error invoking remote method '…': Error: ` 前缀，
 * 主进程 / 驱动抛的原因可能是多行长文。secret：这条错误出自带着开机密码的调用时传入（先抹再截断）。
 */
const errText = (err: unknown, secret = ""): string => readableErrorText(err, "原因未知", secret);

/**
 * 「锁屏时也能用」当前**不能打开**的原因（null = 没有阻碍）。
 * 按「先解决哪个」排序、一次只报最靠前的一个：总开关没开 → macOS 权限不齐 → 原生组件没就绪。
 * （本平台没实现锁屏解锁是更上一层的情形：整个区块只给说明、根本不出开关，不走这里。）
 */
export const getLockedAccessBlockReason = (
  status: ComputerUseStatus,
  computerUseEnabled: boolean,
): string | null => {
  if (!computerUseEnabled) return "需要先开启「电脑操作」";
  if (status.platform === "darwin") {
    const missing = PERMISSION_ITEMS.filter(
      (item) => status.permissions[item.kind] !== "granted",
    );
    if (missing.length > 0) {
      return `需要先授予${missing.map((item) => `「${item.label}」`).join("和")}权限`;
    }
  }
  if (!status.driverReady) return status.driverError?.trim() || "原生组件未就绪";
  return null;
};

// ---------------------------------------------------------------------------
// 状态获取：取桥 + 挂载时取一次 + 每 3 秒轮询
// ---------------------------------------------------------------------------

/**
 * 取桥并持续同步主进程状态：
 * - 挂载后才读 window（SSR / 水合阶段当桥不存在，避免水合不一致）；
 * - 拿到桥先取一次，之后每 3 秒一次（页面不可见时跳过；卸载清理 timer）；
 * - 用户操作后由调用方 refresh() 立即刷新，或 adopt() 直接采纳操作返回的最新快照。
 */
export const useComputerUseStatus = () => {
  // 桥：null = 没有（网页版）或还没挂载
  const [bridge, setBridge] = useState<ComputerUseBridge | null>(null);
  // 最近一次从主进程拿到的状态快照；null = 还没拿到（或一直读失败）
  const [status, setStatus] = useState<ComputerUseStatus | null>(null);
  // 响应序号：issued = 已发起的请求数，applied = 已采纳的最新序号（只采纳不比它更旧的响应）
  const seqRef = useRef({ issued: 0, applied: 0 });
  // 是否仍挂载：卸载后迟到的响应不再 setState
  const mountedRef = useRef(true);
  // 有轮询请求在途：主进程慢响应时下一个 tick 直接跳过，不叠请求
  const pollingRef = useRef(false);
  // 一直读不到状态时的原因（见 STATUS_ERROR_AFTER_FAILURES）；null = 没问题 / 还没到该说的时候
  const [statusError, setStatusError] = useState<string | null>(null);
  // 连续读失败次数（读成功就清零）
  const failuresRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    setBridge(getComputerUseBridge());
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 采纳一份状态快照；seq 缺省 = 此刻（用户操作返回的最新状态一定采纳）。
  // 比已采纳的更旧的丢弃：慢响应的旧快照不能把刚拿到的新状态盖回去
  const adopt = useCallback(
    (next: ComputerUseStatus, seq = ++seqRef.current.issued) => {
      if (!mountedRef.current || seq < seqRef.current.applied) return;
      // 格式不对的快照不采纳（用户操作返回的也一样）：采了，下一次渲染解引用缺失的字段就白屏；旧快照留着
      if (!isComputerUseStatus(next)) return;
      seqRef.current.applied = seq;
      setStatus(next);
    },
    [],
  );

  // 向主进程取一次最新状态。读失败不弹 toast（保留旧快照、下一轮再试），免得每 3 秒弹一条错误；
  // 但**连续**失败又从没拿到过快照时，把原因交给卡片（statusError）：否则主进程没注册设置页 IPC 之类的故障，
  // 用户看到的是一张开关能点、却永远没有状态也没有说明的卡
  const refresh = useCallback(async (): Promise<void> => {
    if (!bridge) return;
    const seq = ++seqRef.current.issued;
    try {
      const next: unknown = await bridge.getStatus();
      // 格式不对 = 读失败：计入连续失败、到次数给用户一句原因（不能悄悄丢掉，不然卡片永远「还没读到」又不说为什么）
      if (!isComputerUseStatus(next)) throw new Error(STATUS_SHAPE_ERROR);
      adopt(next, seq);
      failuresRef.current = 0;
      if (mountedRef.current) setStatusError(null);
    } catch (err) {
      failuresRef.current += 1;
      if (failuresRef.current >= STATUS_ERROR_AFTER_FAILURES && mountedRef.current) {
        setStatusError(statusReadErrorText(err));
      }
    }
  }, [bridge, adopt]);

  useEffect(() => {
    if (!bridge) return;
    void refresh();
    const timer = window.setInterval(() => {
      // 页面不可见（标签页被切走 / 窗口最小化）就不打扰主进程；上一次轮询还没回来也跳过
      if (document.visibilityState === "hidden" || pollingRef.current) return;
      pollingRef.current = true;
      void refresh().finally(() => {
        pollingRef.current = false;
      });
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [bridge, refresh]);

  return { bridge, status, statusError, refresh, adopt };
};

// ---------------------------------------------------------------------------
// 小组件：权限行 / 测试 / 导出 / 密码对话框
// ---------------------------------------------------------------------------

/** 点过「去授权」之后的行内提示（屏幕录制多一句：授权后要重启才生效） */
export const PermissionGuide = ({ kind }: { kind: ComputerUsePermissionKind }) => (
  <>
    请在系统设置里勾选 Flowship
    {kind === "screen" && (
      <span className="block">授权后需要重启 Flowship 才生效</span>
    )}
  </>
);

/** 单项系统权限行：状态徽标 +（未授权时）「去授权」；点过之后行内提示去哪里勾 */
export const PermissionRow = ({
  item,
  granted,
  bridge,
  onStatus,
}: {
  item: (typeof PERMISSION_ITEMS)[number];
  granted: boolean;
  bridge: ComputerUseBridge;
  onStatus: (next: ComputerUseStatus) => void;
}) => {
  // 点过「去授权」：行内提示去系统设置里勾选（授权成功后「已授权」自然取代它）
  const [guided, setGuided] = useState(false);
  // 授权请求进行中：防连点
  const [requesting, setRequesting] = useState(false);

  const handleRequest = async () => {
    setRequesting(true);
    try {
      // requestPermission 返回请求后的最新状态：直接采纳，不必等下一轮轮询
      onStatus(await bridge.requestPermission(item.kind));
      setGuided(true);
    } catch (err) {
      toast.error(`打开授权失败：${errText(err)}`);
    } finally {
      setRequesting(false);
    }
  };

  return (
    <SettingRow
      label={item.label}
      hint={!granted && guided ? <PermissionGuide kind={item.kind} /> : undefined}
      control={
        <div className="flex items-center gap-2">
          <Badge variant={granted ? "success" : "warning"}>
            {granted ? "已授权" : "未授权"}
          </Badge>
          {!granted && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={requesting}
              onClick={() => void handleRequest()}
            >
              去授权
            </Button>
          )}
        </div>
      }
    />
  );
};

/** 「测试后台操作」各步骤的中文名（主进程探针 background-probe.mjs 的步骤名）；解锁测试的步骤名保持原样显示 */
export const BACKGROUND_STEP_LABELS: Readonly<Record<string, string>> = {
  countdown: "倒计时",
  window: "打开测试窗口",
  lock: "锁屏",
  still_locked: "确认仍在锁屏",
  capture: "锁屏时截图",
  input: "锁屏时输入",
  error: "意外错误",
};

/** 「测试锁屏可用 / 测试后台操作」的结果：总结果 + 逐步清单（✓/✗ + 名称 + 耗时 + 详情）；失败时带原因 */
export const LockedAccessTestReport = ({
  result,
  stepLabels,
}: {
  result: LockedAccessTestResult;
  /** 步骤名 → 中文名（没有对应项的原样显示） */
  stepLabels?: Readonly<Record<string, string>>;
}) => (
  <div className="space-y-2 rounded-md border border-border/60 p-3 text-xs">
    <div
      className={cn(
        "text-sm font-medium",
        result.ok ? "text-success" : "text-destructive",
      )}
    >
      {result.ok ? "测试通过" : "测试失败"}
    </div>
    {!result.ok && result.error && (
      <p className="break-words text-destructive">{result.error}</p>
    )}
    {result.steps.length > 0 && (
      <ul className="space-y-1">
        {result.steps.map((step, i) => (
          <li key={`${i}-${step.name}`} className="flex items-start gap-2">
            <span
              role="img"
              aria-label={step.ok ? "通过" : "失败"}
              className={cn(
                "shrink-0",
                step.ok ? "text-success" : "text-destructive",
              )}
            >
              {step.ok ? "✓" : "✗"}
            </span>
            <span className="min-w-0 flex-1">
              <span className="text-foreground">{stepLabels?.[step.name] ?? step.name}</span>
              <span className="ml-2 tabular-nums text-muted-foreground">
                {step.ms} ms
              </span>
              {step.detail && (
                <span className="block break-words text-muted-foreground">
                  {step.detail}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    )}
  </div>
);

/** 两种「会真的锁屏」的测试：自动解锁（macOS 钥匙串 / Windows 解锁组件）与 Windows 的锁屏后台操作 */
const TEST_KINDS = {
  unlock: {
    label: "测试锁屏可用",
    description:
      "点击确认后约 5 秒，电脑会锁屏，随后 Flowship 会自动解锁并回到桌面。期间屏幕会黑一下，请保持电脑在身边。",
    run: (bridge: ComputerUseBridge) => bridge.testLockedAccess(),
    stepLabels: undefined,
  },
  background: {
    label: "测试后台操作",
    description:
      "点击确认后约 5 秒，电脑会锁屏。Flowship 会在锁屏状态下对一个测试窗口截图、打字，验证「锁屏后台模式」能不能用。测完电脑会保持锁屏，请你自己解锁，再回到这里查看结果。期间请不要碰键盘和鼠标。",
    run: (bridge: ComputerUseBridge) => bridge.testBackground(),
    stepLabels: BACKGROUND_STEP_LABELS,
  },
} as const;

/**
 * 「测试锁屏可用」（kind=unlock，缺省）：确认后真的锁屏 → 自动解锁 → 回桌面；
 * 「测试后台操作」（kind=background，Windows）：确认后真的锁屏 → 在锁屏状态下对测试窗口截图 / 打字 → 电脑保持锁屏，用户自己解锁后才看得到结果。
 * 结束后展示逐步结果。`label` 可改按钮 / 对话框标题（Windows 的解锁测试叫「测试自动解锁」，和后台测试区分开）。
 */
export const LockedAccessTest = ({
  bridge,
  disabled,
  onFinished,
  kind = "unlock",
  label,
}: {
  bridge: ComputerUseBridge;
  disabled: boolean;
  onFinished: () => void;
  kind?: keyof typeof TEST_KINDS;
  label?: string;
}) => {
  const { confirm } = useDialog();
  const spec = TEST_KINDS[kind];
  const buttonLabel = label ?? spec.label;
  // 测试进度：running = 进行中（按钮 loading）；result = 最近一次结果（null = 没测过 / 正在测新的一次）
  const [test, setTest] = useState<{
    running: boolean;
    result: LockedAccessTestResult | null;
  }>({ running: false, result: null });

  const handleRun = async () => {
    // 会真的锁屏：重操作，默认聚焦「取消」，避免回车误触发
    const ok = await confirm({
      title: buttonLabel,
      description: spec.description,
      defaultFocus: "cancel",
    });
    if (!ok) return;
    setTest({ running: true, result: null });
    try {
      setTest({ running: false, result: await spec.run(bridge) });
    } catch (err) {
      setTest({
        running: false,
        result: { ok: false, steps: [], error: errText(err) },
      });
    }
    // 测试前后锁屏 / 会话状态都变过，立即刷新一次
    onFinished();
  };

  return (
    <div className="space-y-3">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || test.running}
        onClick={() => void handleRun()}
      >
        {test.running && <Loader2 className="animate-spin" />}
        {test.running ? "测试中…" : buttonLabel}
      </Button>
      {test.result && (
        <LockedAccessTestReport result={test.result} stepLabels={spec.stepLabels} />
      )}
    </div>
  );
};

/** Windows 解锁组件（以系统身份运行的小服务）的安装 / 卸载文案 */
const HELPER_TEXT = {
  install: {
    title: "安装解锁组件",
    description:
      "会弹出 Windows 的管理员授权窗口，请点「是」。解锁组件是一个以系统身份常驻运行的小服务（开机自动启动），替 Flowship 加密保存你的开机密码，并在 AI 需要解锁时在锁屏界面输入。它只认你当前这个 Windows 账户；但这个账户下运行的其他程序也能联系到它（比如触发解锁、覆盖或清除保存的密码），所以请只在你信任这台电脑上运行的程序时启用。可以随时在这里卸载，卸载会一并清除保存的密码。",
    confirmLabel: "安装",
    done: "解锁组件已安装",
    fail: "安装失败",
  },
  uninstall: {
    title: "卸载解锁组件",
    description:
      "卸载后会同时清除它保存的开机密码；之后 AI 在锁屏时只能用「锁屏后台模式」。",
    confirmLabel: "卸载",
    done: "解锁组件已卸载",
    fail: "卸载失败",
  },
} as const;

/**
 * Windows「解锁组件」行：安装状态徽标 + 安装 / 卸载按钮。
 * 安装 / 卸载都会碰系统级的东西（安装要管理员授权），只由用户在这里亲自点；结果（含失败原因）如实 toast。
 * `helper.detail` 是主进程对当前状态的补充说明（如「暂时无法安装」的原因）。
 */
export const UnlockHelperRow = ({
  bridge,
  helper,
  onFinished,
}: {
  bridge: ComputerUseBridge;
  helper: NonNullable<ComputerUseStatus["unlockHelper"]>;
  onFinished: () => void;
}) => {
  const { confirm } = useDialog();
  // 进行中的动作：期间两个按钮都禁用（安装会弹 UAC，用户可能要等好几秒）
  const [busy, setBusy] = useState<"install" | "uninstall" | null>(null);

  const handleRun = async (kind: "install" | "uninstall") => {
    const text = HELPER_TEXT[kind];
    const ok = await confirm({
      title: text.title,
      description: text.description,
      confirmLabel: text.confirmLabel,
      defaultFocus: "cancel",
      ...(kind === "uninstall" ? { destructive: true } : {}),
    });
    if (!ok) return;
    setBusy(kind);
    try {
      const res =
        kind === "install"
          ? await bridge.installUnlockHelper()
          : await bridge.uninstallUnlockHelper();
      if (res.ok) toast.success(text.done);
      else toast.error(`${text.fail}：${res.error?.trim() || "原因未知"}`);
    } catch (err) {
      toast.error(`${text.fail}：${errText(err)}`);
    } finally {
      setBusy(null);
    }
    // 安装 / 卸载之后组件状态、开机密码状态都变了，立即刷新
    onFinished();
  };

  return (
    <SettingRow
      className="py-0"
      label="解锁组件（可选）"
      // hint 一句话（≤ HINT_MAX，tests/settings-hint-brevity.test.ts 的 JSX 扫描会量这里的静态文字）；背景细节进 detail（ⓘ）
      detail="典型的是浏览器、部分聊天软件：锁屏时它们不绘制界面，后台模式截到的图是空白的。装上组件并保存开机密码后，AI 遇到这种情况会自动解锁、盖住屏幕完成任务，做完自动重新锁屏。"
      hint={
        <>
          有些应用锁屏时画不出界面。装上解锁组件并保存开机密码，AI 就能自动解锁、做完再锁回去。
          {helper.detail?.trim() && (
            <span className="mt-1 block text-warning">{helper.detail.trim()}</span>
          )}
        </>
      }
      control={
        <div className="flex items-center gap-2">
          <Badge variant={helper.installed ? "success" : "warning"}>
            {helper.installed ? "已安装" : "未安装"}
          </Badge>
          {helper.installed ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() => void handleRun("uninstall")}
            >
              {busy === "uninstall" && <Loader2 className="animate-spin" />}
              卸载
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy !== null || !helper.canInstall}
              onClick={() => void handleRun("install")}
            >
              {busy === "install" && <Loader2 className="animate-spin" />}
              安装
            </Button>
          )}
        </div>
      }
    />
  );
};

/** 底部弱化的「导出诊断信息」：导出的文件不含用户内容 / 凭据，toast 里给出路径 */
export const ExportDiagnosticsButton = ({
  bridge,
}: {
  bridge: ComputerUseBridge | null;
}) => {
  // 导出中：防双击
  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    if (!bridge) return;
    setExporting(true);
    try {
      const { path } = await bridge.exportDiagnostics();
      toast.success("诊断信息已导出", { description: path });
    } catch (err) {
      toast.error(`导出失败：${errText(err)}`);
    } finally {
      setExporting(false);
    }
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="text-muted-foreground"
      disabled={!bridge || exporting}
      onClick={() => void handleExport()}
    >
      {exporting && <Loader2 className="animate-spin" />}
      导出诊断信息
    </Button>
  );
};

/** 「保存开机密码」对话框的说明（macOS：存在 Flowship 专用钥匙串里）；原文被源码契约测试守着 */
const CREDENTIAL_DESC_MAC =
  "用于锁屏时自动解锁。只保存在本机 Flowship 专用的钥匙串里，不会上传；升级 Flowship 后一般不用重新输入。目前只支持由英文字母、数字和常见符号组成的密码。";
/** 同上（Windows：存在解锁组件里，用 Windows 数据保护加密；锁屏界面默认要输 PIN 的账户打不进去，如实写明） */
const CREDENTIAL_DESC_WIN =
  "用于锁屏时自动解锁。由解锁组件用 Windows 数据保护加密后保存在本机，不会上传，也不会给 AI 看。目前只支持由英文字母、数字和常见符号组成的密码；锁屏界面默认要输入 PIN 的电脑暂不支持自动解锁。";

/**
 * 「保存开机密码」对话框（自建 shadcn Dialog；useDialog().prompt 是明文单行输入、没有掩码，不能用）。
 * 只在需要时挂载（父组件 credMode 非空）：关闭 = 卸载，输入框 state 里的密码随之丢弃。
 * onSubmit 返回 true = 已保存（关闭）；false = 失败（父组件已 toast，对话框留着让用户改了重试）。
 * platform 只决定说明里「密码存在哪」的措辞（macOS 钥匙串 / Windows 解锁组件）。
 */
const CredentialDialog = ({
  platform,
  onSubmit,
  onClose,
}: {
  platform?: ComputerUseStatus["platform"];
  onSubmit: (password: string) => Promise<boolean>;
  onClose: () => void;
}) => {
  // 输入框里的开机密码：只活在这个组件的 state 里，不落任何存储 / 日志
  const [password, setPassword] = useState("");
  // 保存中：按钮 loading，并挡住 Esc / 点遮罩关闭（保存结果还要决定开关）
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!password || saving) return;
    setSaving(true);
    let ok = false;
    try {
      ok = await onSubmit(password);
    } catch (err) {
      // onSubmit（saveCredentialFlow）自己兜着所有已知的失败；这里是最后一道：不管出什么事都不能让「保存中」卡死
      // （按钮灰着、Esc / 点遮罩都关不掉对话框）。报错文字里万一带了密码，展示前抹掉
      toast.error(scrubSecret(`保存失败：${errText(err, password)}`, password));
    }
    if (ok) onClose();
    else setSaving(false);
  };

  return (
    <Dialog
      open
      // 里面是输了一半的开机密码：点遮罩误关一下就整个丢了（项目里带表单草稿的 dialog 都这样，见 ui-conventions）。
      // 出路没堵：Esc 与「取消」仍能关（保存中除外）
      disablePointerDismissal
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>保存开机密码</DialogTitle>
          <DialogDescription>
            {platform === "win32" ? CREDENTIAL_DESC_WIN : CREDENTIAL_DESC_MAC}
          </DialogDescription>
        </DialogHeader>
        <PasswordInput
          autoFocus
          // 这是「保存一个新的秘密」的输入框：new-password 让系统 / 浏览器内核别把它当登录表单去自动填充或弹「是否保存密码」（off 对密码框常被无视）
          autoComplete="new-password"
          aria-label="开机密码"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            // IME 选词中的 Enter 不是提交
            if (e.key === "Enter" && !isImeComposing(e)) {
              e.preventDefault();
              void handleSave();
            }
          }}
        />
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={!password || saving}
            onClick={() => void handleSave()}
          >
            {saving && <Loader2 className="animate-spin" />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// ---------------------------------------------------------------------------
// 「锁屏时也能用」区块
// ---------------------------------------------------------------------------

interface LockedAccessBlockProps {
  bridge: ComputerUseBridge | null;
  status: ComputerUseStatus | null;
  /** 「电脑操作」总开关（此刻显示的值：以主进程实际状态为准，见 shownSwitchState） */
  enabled: boolean;
  /** 「锁屏时也能用」开关（同上） */
  lockedAccess: boolean;
  /** 设置页里的值与主进程实际状态对不上时的常驻说明（见 getSwitchMismatchNote）；null = 一致 */
  syncNote?: string | null;
  onToggle: (next: boolean) => void;
  onEditCredential: () => void;
  onClearCredential: () => void;
  onRefresh: () => void;
}

/** 开机密码行：已保存 / 未保存 + 保存 / 修改 / 清除按钮（macOS 与 Windows 共用；hint 是行下的补充说明） */
const CredentialRow = ({
  credentialSet,
  hint,
  canEdit = true,
  onEdit,
  onClear,
}: {
  credentialSet: boolean;
  hint?: ReactNode;
  /** false = 不给「保存 / 修改」，只留「清除」（Windows：解锁组件版本和这版对不上，保存 / 修改会被组件那头拒掉） */
  canEdit?: boolean;
  onEdit: () => void;
  onClear: () => void;
}) => (
  <SettingRow
    className="py-0"
    label={`开机密码：${credentialSet ? "已保存" : "未保存"}`}
    hint={hint}
    control={
      <div className="flex items-center gap-2">
        {canEdit && (
          <Button type="button" variant="outline" size="sm" onClick={onEdit}>
            {credentialSet ? "修改" : "保存"}
          </Button>
        )}
        {credentialSet && (
          <Button type="button" variant="outline" size="sm" onClick={onClear}>
            清除
          </Button>
        )}
      </div>
    }
  />
);

/** Windows「锁屏时也能用」开关下的一句说明（默认路线：锁屏后台模式，不解锁、不要密码） */
const WINDOWS_LOCKED_DESC =
  "电脑锁屏时，AI 可以继续操作你锁屏前已经打开的应用：电脑始终保持锁屏，不需要开机密码。";
/** Windows 版风险 / 限制说明（如实写明做得到什么、做不到什么、谁能用） */
const WINDOWS_RISK_TEXT =
  "这种方式下电脑不会解锁，旁人看不到屏幕，但 AI 能看到并操作你已经打开的应用里的内容（比如已登录的聊天窗口）。它只能操作锁屏前已经打开的应用窗口；有些应用锁屏时不绘制界面，截图会是空白的。开启后，只要是你的 AI 收到的指令（你自己在 Flowship 或飞书里下的、定时任务触发的）都能这样使用这台电脑，群里的其他成员不能。建议只在个人电脑上开启。";

/**
 * 密码行下面的一句提示（只在「装了解锁组件 + 保存过开机密码」时才出现，见 WindowsLockedAccessBlock）。
 * 第五轮评审补的：handleLockedAccessToggle → disableLockedAccessFlow 没有平台区分，Windows 上关「锁屏时也能用」
 * 同样会把解锁组件里保存的开机密码一并清掉（macOS 的说明里早就写了这句，Windows 这里漏了）。
 * 不放进无条件显示的 WINDOWS_LOCKED_DESC / WINDOWS_RISK_TEXT：没装解锁组件的人不该在界面上看到任何解锁组件 / 开机密码的字样
 * （tests/computer-use-card.test.ts 对整段渲染结果钉着「没装组件时不出现『解锁组件』『开机密码：』」）。
 */
const WINDOWS_CREDENTIAL_OFF_NOTE = "关闭上面的「锁屏时也能用」会同时清除这里保存的开机密码，之后要用自动解锁需要重新保存。";

/**
 * 开关**已经关着**、密码却还留在组件里时，换掉上面那句（第六轮评审 P3）：这时再说「关闭开关会清除」没有意义（已经关了、没清掉），
 * 还会让人以为密码早没了。如实说现状，并指向密码行的「清除」。
 */
const WINDOWS_CREDENTIAL_LEFTOVER_NOTE = "「锁屏时也能用」现在是关着的，但解锁组件里还留着一份开机密码；不需要的话点上面的「清除」删掉。";

/**
 * 解锁组件装着、但版本和这版 Flowship 对不上（上面一行正提示「点安装升级」）时，密码行下面的一句话（第六轮评审 P2-1）。
 * 这段时间 helper.installed 为 false，整个密码行原本都不出——用户既看不到、也清不掉自己保存的开机密码；
 * 现在只要组件里确实存着一份密码（status.credentialSet），就出一行只带「清除」的密码行（不给保存 / 修改：组件那头会拒）。
 * 不对「升级之后这份密码还在不在」作任何断言：原地升级没在真机上走过（windows-unlock-live-test.md 里是待验证项）。
 */
const WINDOWS_CREDENTIAL_STALE_NOTE_BASE =
  "解锁组件还没升级到这一版（见上面的提示），升级之前不能自动解锁、也不能修改这份密码；你可以随时点「清除」把它删掉";
const WINDOWS_CREDENTIAL_STALE_NOTE = `${WINDOWS_CREDENTIAL_STALE_NOTE_BASE}，关闭上面的「锁屏时也能用」也会同时清除它。`;
/** 开关已经关着时的说法：「关闭开关也会清除它」没意义（已经关了），只留前半句（同 WINDOWS_CREDENTIAL_LEFTOVER_NOTE 的考虑，第六轮评审 P3） */
const WINDOWS_CREDENTIAL_STALE_NOTE_SWITCH_OFF = `${WINDOWS_CREDENTIAL_STALE_NOTE_BASE}。`;

/**
 * Windows 的「锁屏时也能用」区块，两条路线分开讲：
 * 1. 锁屏后台模式（开关管它，默认路线）：不解锁、不要密码；「测试后台操作」验证它在这台电脑上到底行不行；
 * 2. 解锁组件（可选，下面单独一行）：后台模式画不出的应用才用——装上组件 + 保存开机密码后，AI 能自动解锁、做完再锁回去。
 *    没装组件时不出密码行 / 解锁测试（密码存在组件里，没有组件就没有「保存开机密码」这回事）。
 * 开启开关**不**要求先存密码；开着的开关始终允许关掉（同 macOS 口径）。
 */
const WindowsLockedAccessBlock = ({
  bridge,
  status,
  enabled,
  lockedAccess,
  syncNote = null,
  onToggle,
  onEditCredential,
  onClearCredential,
  onRefresh,
}: LockedAccessBlockProps & { status: ComputerUseStatus }) => {
  // 开关下面那段风险说明的 id：开关用 extraDescribedBy 指向它，读屏聚焦开关时和行的 hint 一起念（R20-13，见 Switch 头注释）
  const riskId = useId();
  const blockReason = getLockedAccessBlockReason(status, enabled);
  const switchDisabled = !lockedAccess && blockReason !== null;
  // 后台组件没就绪（加载失败等）：开关照样能开（解锁组件那条路线可能是好的），但要如实说后台模式现在用不了
  const backgroundProblem =
    status.backgroundSupported === true && status.backgroundReady !== true
      ? `锁屏后台模式暂时用不了：${status.backgroundError?.trim() || "后台组件没有就绪"}`
      : null;
  const warning = blockReason ?? backgroundProblem;
  // 两个测试都会真的锁屏：开关没开 / 有门禁原因时点了也只会失败，一并挡住
  const testsBlocked = !lockedAccess || blockReason !== null;
  const helper = status.unlockHelper ?? null;
  // 解锁没就绪的补充原因（冷却中 / 权限不够等）：只在已经存了密码时说——没存密码时「未保存」这一行已经说明了
  const unlockNote =
    status.credentialSet && status.unlockReady !== true ? status.unlockNote?.trim() : undefined;

  return (
    <div className="space-y-3 py-4 first:pt-0 last:pb-0">
      <SettingRow
        className="py-0"
        label="锁屏时也能用"
        hint={
          <>
            {WINDOWS_LOCKED_DESC}
            {warning && <span role="status" className="mt-1 block text-warning">{warning}</span>}
            {syncNote && <span role="status" className="mt-1 block text-warning">{syncNote}</span>}
          </>
        }
        control={
          <Switch
            aria-label="锁屏时也能用"
            checked={lockedAccess}
            disabled={switchDisabled}
            onCheckedChange={onToggle}
            extraDescribedBy={riskId}
          />
        }
      />
      <p id={riskId} className="text-xs text-muted-foreground">{WINDOWS_RISK_TEXT}</p>
      {bridge && (
        <>
          <LockedAccessTest
            bridge={bridge}
            kind="background"
            disabled={testsBlocked || status.backgroundReady !== true}
            onFinished={onRefresh}
          />
          {helper && (
            <>
              <UnlockHelperRow bridge={bridge} helper={helper} onFinished={onRefresh} />
              {helper.installed ? (
                <>
                  <CredentialRow
                    credentialSet={status.credentialSet}
                    hint={unlockNote ? <span className="text-warning">{unlockNote}</span> : undefined}
                    onEdit={onEditCredential}
                    onClear={onClearCredential}
                  />
                  {status.credentialSet && (
                    <p className="text-xs text-muted-foreground">
                      {lockedAccess ? WINDOWS_CREDENTIAL_OFF_NOTE : WINDOWS_CREDENTIAL_LEFTOVER_NOTE}
                    </p>
                  )}
                  <LockedAccessTest
                    bridge={bridge}
                    label="测试自动解锁"
                    disabled={!status.credentialSet || testsBlocked}
                    onFinished={onRefresh}
                  />
                </>
              ) : (
                // 装着的组件版本和这版对不上（见 WINDOWS_CREDENTIAL_STALE_NOTE）：组件里确实存着密码才出，且只带「清除」
                status.credentialSet && (
                  <>
                    <CredentialRow credentialSet canEdit={false} onEdit={onEditCredential} onClear={onClearCredential} />
                    <p className="text-xs text-muted-foreground">
                      {lockedAccess ? WINDOWS_CREDENTIAL_STALE_NOTE : WINDOWS_CREDENTIAL_STALE_NOTE_SWITCH_OFF}
                    </p>
                  </>
                )
              )}
            </>
          )}
        </>
      )}
    </div>
  );
};

/**
 * 「锁屏时也能用」区块：开关 + 风险说明 + 开机密码状态 + 测试。
 * - 本平台没有任何锁屏路线（lockedAccessSupported=false）：整个区块只给主进程的说明、不给开关；
 * - Windows：另一套区块（后台模式 + 可选的解锁组件），见 WindowsLockedAccessBlock；
 * - status 为 null（没有桥 / 还没取回）：只出禁用的开关。
 */
const LockedAccessBlock = ({
  bridge,
  status,
  enabled,
  lockedAccess,
  syncNote = null,
  onToggle,
  onEditCredential,
  onClearCredential,
  onRefresh,
}: LockedAccessBlockProps) => {
  // 开关下面那段风险说明的 id（R20-13）。hook 必须在下面几个提前 return 之前调用，别挪到后面
  const riskId = useId();
  // 本平台没有任何锁屏路线：只给主进程的说明，不出开关
  if (status && !status.lockedAccessSupported) {
    return (
      <SettingRow
        label="锁屏时也能用"
        hint={status.lockedAccessNote?.trim() || "当前系统暂不支持"}
        control={null}
      />
    );
  }

  if (status?.platform === "win32") {
    return (
      <WindowsLockedAccessBlock
        bridge={bridge}
        status={status}
        enabled={enabled}
        lockedAccess={lockedAccess}
        syncNote={syncNote}
        onToggle={onToggle}
        onEditCredential={onEditCredential}
        onClearCredential={onClearCredential}
        onRefresh={onRefresh}
      />
    );
  }

  const blockReason = status ? getLockedAccessBlockReason(status, enabled) : null;
  // 条件不满足只拦「打开」：已经开着的开关始终允许关掉（同 Agent shell Git Bash 开关的口径，
  // 免得权限被撤 / 总开关关了之后把用户卡在「关不掉」）
  const switchDisabled = !status || (!lockedAccess && blockReason !== null);

  return (
    <div className="space-y-3 py-4 first:pt-0 last:pb-0">
      <SettingRow
        className="py-0"
        label="锁屏时也能用"
        hint={
          <>
            电脑锁屏时，AI 会用你保存的开机密码自动解锁、盖住屏幕完成任务，做完自动重新锁屏。
            {blockReason && (
              <span role="status" className="mt-1 block text-warning">{blockReason}</span>
            )}
            {syncNote && <span role="status" className="mt-1 block text-warning">{syncNote}</span>}
          </>
        }
        control={
          <Switch
            aria-label="锁屏时也能用"
            checked={lockedAccess}
            disabled={switchDisabled}
            onCheckedChange={onToggle}
            extraDescribedBy={riskId}
          />
        }
      />
      <p id={riskId} className="text-xs text-muted-foreground">
        开机密码只保存在本机 Flowship 专用的钥匙串里，不会上传，也不会给 AI 看；升级 Flowship 后一般不用重新输入。关闭这个开关会同时清除它，再次开启需要重新保存。开启后，只要是你的 AI 收到的指令（你自己在 Flowship 或飞书里下的、定时任务触发的）都能让它解锁并使用这台电脑，群里的其他成员不能。建议只在个人电脑上开启。
      </p>
      {status && bridge && (
        <>
          <CredentialRow
            credentialSet={status.credentialSet}
            onEdit={onEditCredential}
            onClear={onClearCredential}
          />
          <LockedAccessTest
            bridge={bridge}
            // 仅「已存密码 + 开关开」可点；条件不满足（有 blockReason）时点了也只会失败，一并挡住
            disabled={!status.credentialSet || !lockedAccess || blockReason !== null}
            onFinished={onRefresh}
          />
        </>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// 对外：View（status 注入，可单测）+ Section（取桥 + 轮询）
// ---------------------------------------------------------------------------

interface ComputerUseSectionProps {
  /** 总开关 computerUse（默认关）在设置里的值（草稿）；开关实际显示什么见 shownSwitchState（主进程状态优先） */
  enabled: boolean;
  /** 返回 Promise（落盘）时，等它结束再刷新主进程状态；resolve 成 false = 设置没写进去（卡片据此说明实际状态），别的值 / 没有返回值都当成功 */
  onEnabledChange: (next: boolean) => void | Promise<unknown>;
  /** 「锁屏时也能用」computerUseLockedAccess（默认关） */
  lockedAccess: boolean;
  /** 同 onEnabledChange：resolve 成 false = 没写进去 */
  onLockedAccessChange: (next: boolean) => void | Promise<unknown>;
}

interface ComputerUseViewProps extends ComputerUseSectionProps {
  /** 桌面端的桥；null = 没有（网页版）→ 整块禁用并提示「仅桌面端可用」 */
  bridge: ComputerUseBridge | null;
  /** 主进程状态快照；null = 还没拿到 / 没有桥 */
  status: ComputerUseStatus | null;
  /**
   * 一直读不到主进程状态的原因：useComputerUseStatus 在**连续**读失败、且从没拿到过快照之后才给（头一下失败不算，免得启动瞬间闪一条）。
   * 缺省 / null = 没问题或还在重试的头一下。
   */
  statusError?: string | null;
  /** 采纳操作返回的最新状态快照（授权后立即反映） */
  onStatus: (next: ComputerUseStatus) => void;
  /** 立即向主进程重取一次状态 */
  onRefresh: () => void | Promise<void>;
}

/** 「保存开机密码」对话框的来由：enable = 开启开关时弹的（保存成功才写开关）；change = 单纯保存 / 修改 */
type CredentialMode = "enable" | "change";

/**
 * 设置写盘没成功（saveFieldValue 失败返回 false，它自己已弹一条通用的「保存失败」）。
 * 只有**明确的 false** 才算失败：没有返回值（void）/ 别的值都当成功——写开关的回调不一定是 saveFieldValue。
 */
const writeFailed = (result: unknown): boolean => result === false;

/**
 * 调写开关的回调并折成「写进去了吗」：回调本不该抛（saveFieldValue 失败返回 false），抛了也只当没写进去——
 * 一次异常不能把整个流程（以及保存开机密码对话框的「保存中」）带垮。
 */
const settleWrite = async (
  write: (next: boolean) => void | Promise<unknown>,
  next: boolean,
): Promise<boolean> => {
  try {
    return !writeFailed(await write(next));
  } catch {
    return false;
  }
};

/** 刷新主进程状态：失败不影响已经做完的事（下一轮 3 秒轮询会再取），更不能抛出去 */
const safeRefresh = async (refresh: () => void | Promise<void>): Promise<void> => {
  try {
    await refresh();
  } catch {
    /* 下一轮轮询会再取 */
  }
};

// ---------------------------------------------------------------------------
// 两个开关显示什么：以主进程的实际状态为准（第二轮评审 #10）
// ---------------------------------------------------------------------------
// 开关的值有两个来源：设置页的草稿（saveFieldValue 乐观更新，写盘失败了它也已经是用户想要的样子）和主进程的实际状态
// （status.enabled / lockedAccessEnabled：server 推过去的、真正管着 AI 能不能用的那一份）。以前直接显示草稿：
// 写盘失败后界面显示「关」、主进程里实际仍开——对「把整台电脑交给 AI」的开关，这是危险的那一边。

/**
 * 开关写下去之后，主进程追上来的宽限（毫秒）：写盘 → server 推给主进程只差一拍，这段时间开关按「用户想要的样子」显示；
 * 到点还没追上（写盘失败的重试没成功、与主进程断连…）就按主进程的实际状态显示，并由 {@link getSwitchMismatchNote} 说明。
 */
export const SWITCH_SYNC_GRACE_MS = 10_000;

/**
 * 主进程眼里这个开关的实际状态；拿不到真读数时 undefined（调用方退回设置草稿）。
 * 装配失败 / 没有驱动的平台上快照是占位的（enabled / lockedAccessEnabled 恒为 false），不是真读数——只有 supported:true 才算。
 */
export const actualSwitchState = (
  status: ComputerUseStatus | null,
  key: "enabled" | "lockedAccessEnabled",
): boolean | undefined => (status?.supported === true ? status[key] === true : undefined);

/**
 * 开关此刻显示什么：用户刚点下的那一下（pending：等写盘、等主进程收到）> 主进程的实际状态 > 设置草稿（没有实际状态时才用）。
 */
export const shownSwitchState = ({
  pending,
  actual,
  draft,
}: {
  pending: boolean | null;
  actual: boolean | undefined;
  draft: boolean;
}): boolean => pending ?? actual ?? draft;

const SWITCH_LABELS = {
  enabled: { name: "电脑操作", effect: "操作这台电脑" },
  lockedAccess: { name: "锁屏时也能用", effect: "在锁屏时使用这台电脑" },
} as const;

/**
 * 设置页里的值（草稿）与主进程实际状态对不上、且不是「用户刚点的那一下还在同步」时的常驻说明；
 * null = 一致 / 拿不到实际状态 / 还在同步。「界面是关、实际仍开」是危险的那一边，措辞明说 AI 目前仍可以怎样。
 */
export const getSwitchMismatchNote = ({
  kind,
  draft,
  actual,
  pending,
}: {
  kind: keyof typeof SWITCH_LABELS;
  draft: boolean;
  actual: boolean | undefined;
  pending: boolean | null;
}): string | null => {
  if (actual === undefined || pending !== null || actual === draft) return null;
  const { name, effect } = SWITCH_LABELS[kind];
  return actual
    ? `「${name}」还没有真正关掉：设置页里已经是关闭，但主进程里仍然开着（设置没写进去，或主进程还没收到），AI 目前仍可以${effect}。请再点一次开关；一直这样的话请重启 Flowship`
    : `「${name}」还没有真正开启：设置页里已经是开启，但主进程里还没有生效（可能还在同步，或与主进程的连接断开了），AI 目前还不能${effect}。一直这样的话请重启 Flowship`;
};

/**
 * 「用户刚点下的那一下」的暂存：从点击到主进程状态追上来之间，开关按目标值显示（不然写盘 + 推送这一拍里它会弹回旧值、像没点上）。
 * 收起时机：主进程状态追上来了 / 写盘没成功（调用方清掉）/ 宽限到点仍没追上（之后按实际状态显示 + 常驻说明）。
 */
const useSwitchPending = (actual: boolean | undefined) => {
  const [pending, setPending] = useState<boolean | null>(null);
  // 第几次登记：连点两下时，两次写盘各自在路上，先发的那次若晚失败，只能收起**自己**登记的那一份——
  // 后一次登记的（用户此刻真正想要的样子）还在等写盘，不能被它顺手清掉（第三轮评审：以前失败无条件 setPending(null)）
  const seqRef = useRef(0);
  useEffect(() => {
    if (pending !== null && actual === pending) setPending(null);
  }, [pending, actual]);
  useEffect(() => {
    if (pending === null) return;
    const timer = setTimeout(() => setPending(null), SWITCH_SYNC_GRACE_MS);
    return () => clearTimeout(timer);
  }, [pending]);
  /** 登记「用户想要的样子」，返回「这次没写进去」时调用的收起函数：只在这次登记仍是最新一次时才真的收起 */
  const begin = (next: boolean): (() => void) => {
    const mine = ++seqRef.current;
    setPending(next);
    return () => {
      if (seqRef.current === mine) setPending(null);
    };
  };
  return [pending, begin] as const;
};

// 写开关失败后的补充说明：saveFieldValue 自己会弹一条「保存失败」，并说清楚会不会自动重试（5xx / 网络错误才重试；
// 服务端 4xx 拒绝、配置没加载成功都不会）——这里**不替它承诺重试**，只补它没说的后果。
// 而它是乐观更新——界面上开关已经显示成用户想要的样子，实际落盘的仍是旧值；对「电脑操作」这种授权开关，
// 用户必须被明说「现在到底开着还是关着」，别让他以为已经关了
const ENABLED_OFF_FAILED_TOAST =
  "「电脑操作」还没有关掉：设置没能写入成功。写入成功之前，AI 仍然可以操作这台电脑，请再点一次开关重试";
const LOCKED_OFF_FAILED_TOAST =
  "「锁屏时也能用」还没有关掉：设置没能写入成功。写入成功之前它仍然有效；开机密码先留着，开关真正关掉后会自动清除（需要停留在这个页面），也可以再点一次开关重试";
const CREDENTIAL_SAVED_SWITCH_FAILED_TOAST =
  "开机密码已保存，但「锁屏时也能用」没能打开：设置没能写入成功。可以再点一次「保存」，或稍后在设置里手动打开开关";
/** 主进程说「密码已存好、附带的收尾没做成」（saved:true）却没带原因时的兜底说明 */
const CREDENTIAL_SAVED_WITH_NOTE_FALLBACK = "开机密码已经保存好了，但保存后还有一步收尾没做成，自动解锁可能暂时用不了";
const CLEAR_SWITCH_FAILED_TOAST =
  "开机密码已清除，但「锁屏时也能用」的开关没能关掉：设置没能写入成功。没有密码时它不会自动解锁，请再点一次开关把它关掉";

/**
 * 整张卡不可用（装配失败 / 没有驱动）、但「锁屏时也能用」在设置里还开着时，替代整块锁屏区块的那一行的说明。
 * 一句话（HINT_MAX 以内，tests/settings-hint-brevity.test.ts 的 JSX / 常量扫描会量它）：指路到「已保存的开机密码」那一行；
 * 「关掉它不会顺带删密码」这类细节进 {@link LOCKED_ACCESS_UNAVAILABLE_DETAIL}（R20-13：原来两句塞在一起 87 字，超过上限）。
 */
export const LOCKED_ACCESS_UNAVAILABLE_HINT =
  "这项设置还开着，但「电脑操作」现在用不了（见上面的说明）。可以先关掉它；要删开机密码，用下面「已保存的开机密码」那行的「清除」。";
/** 上一行的补充说明（名称后的 ⓘ） */
export const LOCKED_ACCESS_UNAVAILABLE_DETAIL =
  "之前保存过的开机密码不会因为关掉这项设置而被删除；要删，用下面「已保存的开机密码」那一行的「清除」。";

/**
 * 整张卡不可用（装配失败）时的「清除开机密码」行的说明：读不出有没有存过，所以不说「已保存 / 未保存」。
 * 一句话（HINT_MAX 以内；R20-13：原来 75 字，把「和功能能不能用无关」也塞了进来）。
 */
export const UNAVAILABLE_CREDENTIAL_HINT =
  "「电脑操作」这次没能初始化，读不出有没有保存过开机密码。点「清除」会删掉它（没存过也没关系），随时可以清。";

/**
 * 保存开机密码的流程：交给主进程写进钥匙串；成功后（开启流程）才真正写开关。
 * 返回 true = 已保存（开启流程：开关也写进去了）；主进程返回 ok:false / 抛错 → toast 说明原因、返回 false，开关一个字都不动
 * （取消对话框更是根本走不到这里 → 开关保持关）。密码只经 setCredential 单向交出去，不进 toast / 日志（报错文字里万一带了它，展示前也抹掉）。
 * 密码存好了但开关没写进去（writeLockedAccess 返回 false）：也返回 false——对话框因此留着，用户能看见这句说明、再点一次「保存」
 * （再存一遍同一个密码是幂等的，然后重试写开关）；对话框要是照样关掉，用户会以为「锁屏时也能用」已经开了。
 * 主进程回 ok:false + saved:true = 密码**已经存好**、只是附带的收尾没做成（Windows 冷却记录没清掉）：按「已保存」往下走
 * （开启流程照写开关、返回 true 让对话框关闭、刷新状态），主进程那句话以警告提示展示（第四轮评审 B1）。只认明确的 `saved === true`。
 */
export const saveCredentialFlow = async ({
  bridge,
  password,
  enableAfterSave,
  writeLockedAccess,
  refresh,
}: {
  bridge: ComputerUseBridge | null;
  password: string;
  /** 开启流程：保存成功后把「锁屏时也能用」写成开 */
  enableAfterSave: boolean;
  writeLockedAccess: (next: boolean) => void | Promise<unknown>;
  refresh: () => void | Promise<void>;
}): Promise<boolean> => {
  if (!bridge) return false;
  // 主进程说「密码已经存好了，只是附带的收尾没做成」时要告诉用户的话；null = 没有这回事
  let savedNote: string | null = null;
  try {
    const res = await bridge.setCredential({ password });
    if (!res.ok) {
      // 只认明确的 saved === true：缺省 / false / "true" / 1 一律当失败——宁可让用户再试一次，也别把没存上的当成存好了
      if (res.saved !== true) {
        toast.error(scrubSecret(res.error?.trim() || "保存失败", password));
        return false;
      }
      savedNote = scrubSecret(res.error?.trim() || CREDENTIAL_SAVED_WITH_NOTE_FALLBACK, password);
    }
  } catch (err) {
    toast.error(scrubSecret(`保存失败：${errText(err, password)}`, password));
    return false;
  }
  // 密码其实已经存好了，这不是失败：当失败处理的话，对话框不关、用户以为没存上，又输一遍。照常往下走，只把那句话亮出来；
  // 文案偏长，留足 10 秒（项目里长警告的惯例，见 requirement-group-dialog）
  if (savedNote !== null) toast.warning(savedNote, { duration: 10_000 });
  // 写开关抛错也只当没写进去（settleWrite）：这一步在上面的 try 之外，抛出去的话对话框的「保存中」就永远复位不了
  if (enableAfterSave && !(await settleWrite(writeLockedAccess, true))) {
    toast.error(CREDENTIAL_SAVED_SWITCH_FAILED_TOAST);
    await safeRefresh(refresh); // 密码已经存进去了：状态里的「开机密码：已保存」要立刻反映
    return false;
  }
  await safeRefresh(refresh);
  return true;
};

/**
 * 清钥匙串里的开机密码，折成统一结果：桥抛错 / 主进程返回 ok:false（钥匙串里没删掉）都算失败。
 * error 是能直接给用户看的原因（主进程自己写的中文 / 桥的错误信息），不含密码。
 */
const clearCredentialResult = async (
  bridge: ComputerUseBridge,
): Promise<{ ok: true } | { ok: false; error: string }> => {
  try {
    const res = await bridge.clearCredential();
    if (res?.ok === false) {
      return { ok: false, error: res.error?.trim() || "钥匙串里的开机密码没有删掉" };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errText(err) };
  }
};

/** 清钥匙串里的开机密码并告诉用户结果（成功 / 失败各一条 toast；失败如实说密码还留着、怎么处理）。返回是否清掉 */
const clearCredentialAndReport = async (bridge: ComputerUseBridge): Promise<boolean> => {
  const cleared = await clearCredentialResult(bridge);
  if (cleared.ok) {
    toast.success("已清除保存的开机密码");
  } else {
    toast.error(
      `已关闭「锁屏时也能用」，但开机密码没能清除：${cleared.error}。可以稍后点「清除」再试`,
    );
  }
  return cleared.ok;
};

/**
 * 关掉「锁屏时也能用」并把钥匙串里的开机密码一并清掉——关掉的功能不该还留着一份能自动解锁电脑的密码。
 * 顺序：先把开关写成关（关 = 失败即关闭，必须先生效；写失败 = 落盘的开关还开着，停手、什么都不清，并明说「还没有关掉」），再清密码。
 * 清密码失败不回滚开关（功能已经关了、不会再自动解锁），但如实告诉用户密码还留着、怎么处理。
 * `switchIsOn=false`（总开关关闭时，锁屏开关本来就没开）只清密码、不写设置。
 *
 * 开关没写进去、而钥匙串里有密码时调 `onWriteFailed`：设置页对 5xx / 网络错误会自动重试，重试成功时开关是在没人经手的情况下关掉的，
 * 密码没人清（第三轮评审）——调用方据此登记「开关真的关了之后补清密码」（见 {@link deferredClearVerdict}）。
 *
 * 清密码排在写盘之后（写盘慢时秒级），这段时间里用户可能又把开关打开了、或存了新密码：真动手清之前问一次 `shouldClear`，
 * 返回 false = 用户之后又动过，这次「关」不再代表他的意图——不清（第四轮评审 B2：不能把他刚存的密码清掉）。
 */
export const disableLockedAccessFlow = async ({
  bridge,
  switchIsOn,
  hasCredential,
  writeLockedAccess,
  refresh,
  onWriteFailed,
  shouldClear,
}: {
  bridge: ComputerUseBridge | null;
  /** 「锁屏时也能用」此刻是开着的：要写成关 */
  switchIsOn: boolean;
  /** 钥匙串里有开机密码：要清掉 */
  hasCredential: boolean;
  writeLockedAccess: (next: boolean) => void | Promise<unknown>;
  refresh: () => void | Promise<void>;
  /** 开关没写进去、密码因此先留着时调用（只在 hasCredential 时调） */
  onWriteFailed?: () => void;
  /** 开关写完、真动手清密码之前再问一次：false = 这期间用户又动过锁屏开关 / 开机密码，这次不清；缺省 = 照清 */
  shouldClear?: () => boolean;
}): Promise<void> => {
  if (switchIsOn) {
    // saveFieldValue 落盘失败返回 false（回调抛错同样当没写进去）：落盘的开关还是开的，别去清密码；界面上它已被乐观地显示成关了，要明说
    if (!(await settleWrite(writeLockedAccess, false))) {
      toast.error(LOCKED_OFF_FAILED_TOAST);
      if (hasCredential) onWriteFailed?.();
      await safeRefresh(refresh);
      return;
    }
  }
  // 写盘等了一阵：用户若在这期间又开了开关 / 存了新密码，这次的清除就不能再落到他头上
  if (hasCredential && bridge && (shouldClear?.() ?? true)) await clearCredentialAndReport(bridge);
  await safeRefresh(refresh);
};

/**
 * 「关开关没写进去、密码先留着」之后，什么时候该补清密码（纯函数，便于单测）：
 * - "drop"：用不着了——用户又把开关打开了（设置草稿重新是开：不再替他清），或钥匙串里已经没有密码（手动清过了）；
 * - "wait"：还没到时候——主进程里锁屏开关还开着 / 读不到（自动重试还没成功，或还没推到主进程）；
 * - "clear"：主进程确认开关已经关了、设置草稿也是关、钥匙串里还有密码 → 清。
 * 要求主进程那边**确认**已关（而不是看草稿）：草稿是乐观更新，写盘失败时它早就是关了。
 */
export const deferredClearVerdict = ({
  draftLocked,
  actualLocked,
  credentialSet,
}: {
  draftLocked: boolean;
  actualLocked: boolean | undefined;
  credentialSet: boolean;
}): "drop" | "wait" | "clear" => {
  if (draftLocked || !credentialSet) return "drop";
  return actualLocked === false ? "clear" : "wait";
};

export const ComputerUseView = ({
  bridge,
  status,
  statusError = null,
  enabled,
  onEnabledChange,
  lockedAccess,
  onLockedAccessChange,
  onStatus,
  onRefresh,
}: ComputerUseViewProps) => {
  const { confirm } = useDialog();
  // 「保存开机密码」对话框：null = 没开
  const [credMode, setCredMode] = useState<CredentialMode | null>(null);
  // 主进程明确说本平台没有桌面驱动（如 Linux），或这次启动装配失败：整张卡不可用
  const platformUnsupported = status !== null && !status.supported;
  // 有桥却一直读不到状态（主进程没注册设置页 IPC 等）：明说，别让用户对着一个能点却不工作的卡片猜
  const statusUnreadable = bridge !== null && status === null && statusError !== null && statusError !== "";

  // 两个开关显示什么：以主进程的实际状态为准（props 里的 enabled / lockedAccess 是设置草稿，乐观更新，写盘失败后会和实际不一致），
  // 用户刚点的那一下先按目标值显示（写盘 + 推送给主进程有一拍）。拿不到真读数（没有桥 / 还没读到 / 装配失败的占位快照）才退回草稿
  const actualEnabled = actualSwitchState(status, "enabled");
  const actualLocked = actualSwitchState(status, "lockedAccessEnabled");
  const [pendingEnabled, beginPendingEnabled] = useSwitchPending(actualEnabled);
  const [pendingLocked, beginPendingLocked] = useSwitchPending(actualLocked);
  const shownEnabled = shownSwitchState({ pending: pendingEnabled, actual: actualEnabled, draft: enabled });
  const shownLocked = shownSwitchState({ pending: pendingLocked, actual: actualLocked, draft: lockedAccess });
  // 收窄权限的联动（关锁屏开关 / 清密码）：设置里或主进程里只要有一边还开着就要做——收窄永远是安全方向
  const lockedOn = shownLocked || lockedAccess;
  const enabledNote = getSwitchMismatchNote({ kind: "enabled", draft: enabled, actual: actualEnabled, pending: pendingEnabled });
  const lockedNote = getSwitchMismatchNote({ kind: "lockedAccess", draft: lockedAccess, actual: actualLocked, pending: pendingLocked });

  // 用户对「锁屏开关 / 开机密码」动手的序号：点关、点开、存开机密码各 +1（第四轮评审 B2）。
  // 「关掉之后清密码」都是异步的——主流程要等写盘（慢时秒级），补清要等设置页自动重试成功（退避 2 / 8 / 30 秒，最长约 40 秒），
  // 期间用户可能又开了开关、存了新密码。清之前核对序号：还是登记那一刻的才清；变过 = 用户之后又做过别的，这次清除不再代表他的意图，作废
  const lockedSeqRef = useRef(0);
  const nextLockedSeq = () => ++lockedSeqRef.current;

  // 「关锁屏开关」没写进去、钥匙串里的密码因此先留着时登记的意图：设置页对 5xx / 网络错误会自动重试，重试成功时开关是在没人经手的情况下
  // 关掉的，没有这一条就没人去清密码（第三轮评审）。等主进程确认开关真的关了再清（见 deferredClearVerdict）。
  // 值 = 登记时的序号（null = 没有）
  const [clearAfterOff, setClearAfterOff] = useState<number | null>(null);
  const credentialSet = status?.credentialSet === true;
  useEffect(() => {
    if (clearAfterOff === null) return;
    // 登记之后用户又动过（点开 / 存了新密码 / 又点了一次关）：这次补清作废
    if (clearAfterOff !== lockedSeqRef.current) {
      setClearAfterOff(null);
      return;
    }
    const verdict = deferredClearVerdict({ draftLocked: lockedAccess, actualLocked, credentialSet });
    if (verdict === "wait") return;
    setClearAfterOff(null);
    if (verdict !== "clear" || !bridge) return;
    void (async () => {
      await clearCredentialAndReport(bridge);
      await safeRefresh(onRefresh);
    })();
  }, [clearAfterOff, lockedAccess, actualLocked, credentialSet, bridge, onRefresh]);

  // 写开关 = 先登记「用户想要的样子」（pending）→ 等落盘；没写进去（返回 false / 回调抛错）就收起**自己登记的那一份**、回到主进程的实际状态
  // （期间用户又点了一下 = 又登记了新的一份，那份不归这次写盘管，见 useSwitchPending）。
  // 返回值原样交给调用方（false = 没写进去；抛错折成 false）
  const writeVia =
    (
      begin: (next: boolean) => () => void,
      write: (next: boolean) => void | Promise<unknown>,
    ) =>
    async (next: boolean): Promise<unknown> => {
      const dropMine = begin(next);
      let result: unknown;
      try {
        result = await write(next);
      } catch {
        result = false;
      }
      if (writeFailed(result)) dropMine();
      return result;
    };
  const writeEnabled = writeVia(beginPendingEnabled, onEnabledChange);
  const writeLocked = writeVia(beginPendingLocked, onLockedAccessChange);

  // 写开关（等落盘）后立即刷新主进程状态；主进程那边的开关是 server 推过去的、可能晚一拍，3 秒轮询兜底。
  // 返回 false = 设置没写进去（saveFieldValue 失败返回 false，它自己已弹通用的「保存失败」）：调用方要据此说明实际状态，
  // 不能当成已经生效——它是乐观更新，界面上开关已经是用户想要的样子，落盘的却还是旧值
  const commit = async (
    write: (next: boolean) => void | Promise<unknown>,
    next: boolean,
  ): Promise<boolean> => {
    const saved = await settleWrite(write, next);
    await safeRefresh(onRefresh);
    return saved;
  };

  // Windows：默认路线（锁屏后台模式）不需要开机密码——开启开关不要求先存密码，清除密码也不关开关；
  // 开机密码只属于可选的「解锁组件」那条路线
  const isWindows = status?.platform === "win32";

  const handleLockedAccessToggle = (next: boolean) => {
    // 每点一下开关都是一次新的用户动作：之前登记的「关掉之后清密码」（主流程与补清）都不再代表他此刻的意图
    const seq = nextLockedSeq();
    // 开启时还没存开机密码：先弹对话框，保存成功才真正写开关；取消 → 开关保持关（Windows 不要求）
    if (next && !isWindows && !status?.credentialSet) {
      setCredMode("enable");
      return;
    }
    // 关闭：开关写成关之后，钥匙串里的开机密码一并清掉（再开启会重新要求保存）
    if (!next) {
      void disableLockedAccessFlow({
        bridge,
        switchIsOn: true,
        hasCredential: status?.credentialSet === true,
        writeLockedAccess: writeLocked,
        refresh: onRefresh,
        onWriteFailed: () => setClearAfterOff(seq),
        shouldClear: () => lockedSeqRef.current === seq,
      });
      return;
    }
    // 用户又把它打开了：之前「关掉后补清密码」的意图作废（不能在他刚开启之后把密码清了）
    setClearAfterOff(null);
    void commit(writeLocked, next);
  };

  const handleEnabledToggle = async (next: boolean) => {
    // 整张卡不可用（装配失败 / 没有驱动）时只允许关：开关此刻显示「开」= 设置里开着，关掉它不会碰任何系统能力；打开一律不行
    if (next && platformUnsupported) return;
    if (next) {
      // 从关到开每次都确认一次：这是把整台电脑交给 AI 的开关，说清楚会发生什么再开（默认聚焦「取消」，回车不会误开）
      const ok = await confirm({
        title: "开启电脑操作",
        description:
          "开启后，AI 会截取这台电脑的屏幕画面（画面会发给你所用的模型服务商），并像你一样点击、输入，可以操作任何应用，包括你不在电脑前、通过飞书下指令的时候。建议只在个人电脑上开启，并留意 AI 的操作记录。",
        confirmLabel: "开启",
        defaultFocus: "cancel",
      });
      if (!ok) return;
      await commit(writeEnabled, true);
      return;
    }
    // 关闭：总开关先关（立即生效）。「锁屏时也能用」依附于它——它开着（设置里或主进程里）就一并关掉并清掉钥匙串里的开机密码。
    // 序号在写总开关之前就取：它要等落盘，这段时间里用户的动作（存新密码等）同样算「更晚」
    const seq = nextLockedSeq();
    if (!(await commit(writeEnabled, false))) {
      // 总开关实际还开着（开关会弹回「开」并带常驻说明）：toast 里也明说。后面的联动清理照做——它只会收窄权限（关锁屏开关、清密码），
      // 而且各写各的、各自失败各自说明；不因为总开关没关成就把密码留在钥匙串里
      toast.error(ENABLED_OFF_FAILED_TOAST);
    }
    if (lockedOn) {
      await disableLockedAccessFlow({
        bridge,
        switchIsOn: true,
        hasCredential: status?.credentialSet === true,
        writeLockedAccess: writeLocked,
        refresh: onRefresh,
        onWriteFailed: () => setClearAfterOff(seq),
        shouldClear: () => lockedSeqRef.current === seq,
      });
    }
  };

  const handleSaveCredential = (password: string): Promise<boolean> => {
    // 用户在存开机密码：之前登记的「关掉之后清密码」（主流程 / 补清）作废——不能在他刚存好的时候把它清掉
    nextLockedSeq();
    return saveCredentialFlow({
      bridge,
      password,
      enableAfterSave: credMode === "enable",
      writeLockedAccess: writeLocked,
      refresh: onRefresh,
    });
  };

  const handleClearCredential = async () => {
    if (!bridge) return;
    const ok = await confirm({
      title: "清除开机密码",
      description: isWindows
        ? "清除后，AI 锁屏时不能再自动解锁了（「锁屏后台模式」不受影响）。需要时可以重新保存。"
        : lockedOn
          ? "清除后「锁屏时也能用」会一并关闭，需要重新保存密码才能再次开启。"
          : "清除后，再次开启「锁屏时也能用」需要重新保存密码。",
      confirmLabel: "清除",
      destructive: true,
    });
    if (!ok) return;
    const cleared = await clearCredentialResult(bridge);
    if (!cleared.ok) {
      // 钥匙串里的密码还在：开关不动、不刷新（状态没有变化）
      toast.error(`清除失败：${cleared.error}`);
      return;
    }
    // 整张卡不可用（装配失败）时没有「开机密码：已保存 / 未保存」那一行会跟着变——不说一声，用户点完什么变化都看不到
    if (platformUnsupported) toast.success("已清除保存的开机密码");
    // 没有密码了：开着的开关一并关掉（macOS：没密码就没法自动解锁。Windows：后台模式用不着密码，开关保持）。
    // 开关没写进去：密码已经清了（这一步不回滚），只是开关落盘还开着——没有密码它自动解锁不了，但要如实说明
    if (lockedOn && !isWindows && !(await settleWrite(writeLocked, false))) {
      toast.error(CLEAR_SWITCH_FAILED_TOAST);
    }
    await safeRefresh(onRefresh);
  };

  return (
    <div className="divide-y divide-border/60">
      <SettingRow
        label="电脑操作"
        hint={
          <>
            让 AI 操作这台电脑上的任何应用（截图、点击、输入）。你不在电脑前时，也可以通过飞书让它帮你操作。
            {!bridge && <span className="mt-1 block">仅桌面端可用</span>}
            {platformUnsupported && (
              // 主进程装配失败时 driverError 里是具体原因（系统其实支持，别说「暂不支持」）；没有驱动的平台没有这一项 → 兜底文案
              <span className="mt-1 block">
                {status?.driverError?.trim() || "当前系统暂不支持电脑操作"}
              </span>
            )}
            {statusUnreadable && (
              <span role="status" className="mt-1 block text-warning">
                暂时读不到电脑操作的状态（{statusError}），会自动重试。一直这样的话请重启 Flowship
              </span>
            )}
            {enabledNote && <span role="status" className="mt-1 block text-warning">{enabledNote}</span>}
          </>
        }
        control={
          // 无障碍（S-8f，有意保留的行为，别当 bug 去掉）：这个开关显式写了 aria-label（名字要说清「授权什么」），但 describedby 仍由 SettingRow
          // 的 context 自动挂上本行的 hint——读屏聚焦它会把整段说明念出来（含「不在电脑前也能通过飞书操作」的披露，以及下面的状态 / 不一致警告）。
          // 这是想要的：把整台电脑交给 AI 的开关，安全披露就该被读到。「锁屏时也能用」的两个开关（macOS / Windows 区块里）同理，
          // 而且它们的风险说明不在 hint 里、是开关下面另起的一段话——所以那两个开关另用 extraDescribedBy 指向那段话（R20-13 补上；
          // 之前这条注释说「同理」、实际只念 hint，风险段读屏聚焦开关时听不到）。
          <Switch
            aria-label="电脑操作"
            checked={shownEnabled}
            // 整张卡不可用（装配失败 / 没有驱动）时只拦「打开」：设置里已经开着的开关始终允许关掉（同锁屏开关的口径）——
            // 装配失败后若连关都关不掉，设置里已开着它的用户就被卡在「看不见也关不了」
            disabled={!bridge || (platformUnsupported && !shownEnabled)}
            onCheckedChange={(v) => void handleEnabledToggle(v)}
          />
        }
      />

      {/* 权限区只在 macOS 显示，状态始终展示（总开关没开也能先去授权）；整张卡不可用（装配失败）时不显示：
          那时权限读数是占位的「未知」，点「去授权」也只会撞上同一个初始化错误 */}
      {bridge &&
        !platformUnsupported &&
        status?.platform === "darwin" &&
        PERMISSION_ITEMS.map((item) => (
          <PermissionRow
            key={item.kind}
            item={item}
            granted={status.permissions[item.kind] === "granted"}
            bridge={bridge}
            onStatus={onStatus}
          />
        ))}

      {/* 整个平台都没有桌面驱动（如 Linux）：总开关已禁用并说明，锁屏区块没有意义，不重复出现 */}
      {!platformUnsupported && (
        <LockedAccessBlock
          bridge={bridge}
          status={status}
          enabled={shownEnabled}
          lockedAccess={shownLocked}
          syncNote={lockedNote}
          onToggle={handleLockedAccessToggle}
          onEditCredential={() => setCredMode("change")}
          onClearCredential={() => void handleClearCredential()}
          onRefresh={() => void onRefresh()}
        />
      )}

      {/* 整张卡不可用、但「锁屏时也能用」在设置里还开着：整块锁屏区块不出（点不了测试 / 保存密码），只留一行让它能被关掉——
          不留的话，装配失败后设置里已开着它的用户就关不掉了。只能关，不能开；密码状态在这种状态下读不到，所以不出密码行 */}
      {platformUnsupported && shownLocked && (
        <SettingRow
          label="锁屏时也能用"
          hint={LOCKED_ACCESS_UNAVAILABLE_HINT}
          detail={LOCKED_ACCESS_UNAVAILABLE_DETAIL}
          control={
            <Switch
              aria-label="锁屏时也能用"
              checked
              onCheckedChange={(v) => {
                if (!v) handleLockedAccessToggle(false);
              }}
            />
          }
        />
      )}

      {/* 装配失败（有桌面驱动的平台、这次启动没能初始化）时仍给一个清除入口：开机密码存在钥匙串 / 解锁组件里，清掉它不需要驱动——
          功能坏了不该让一份能自动解锁电脑的密码删不掉（第三轮评审：以前这里 reject、只能等功能恢复）。读不出有没有存过，所以不显示「已保存 / 未保存」，
          没存过时清除也是成功。没有桌面驱动的平台（Linux 等）没有这回事，不显示 */}
      {bridge && platformUnsupported && (status?.platform === "darwin" || status?.platform === "win32") && (
        <SettingRow
          label="已保存的开机密码"
          hint={UNAVAILABLE_CREDENTIAL_HINT}
          control={
            <Button type="button" variant="outline" size="sm" onClick={() => void handleClearCredential()}>
              清除
            </Button>
          }
        />
      )}

      <div className="pt-4">
        <ExportDiagnosticsButton bridge={bridge} />
      </div>

      {credMode && (
        <CredentialDialog
          platform={status?.platform}
          onSubmit={handleSaveCredential}
          onClose={() => setCredMode(null)}
        />
      )}
    </div>
  );
};

export const ComputerUseSection = (props: ComputerUseSectionProps) => {
  const { bridge, status, statusError, refresh, adopt } = useComputerUseStatus();
  return (
    <ComputerUseView
      {...props}
      bridge={bridge}
      status={status}
      statusError={statusError}
      onStatus={adopt}
      onRefresh={refresh}
    />
  );
};
