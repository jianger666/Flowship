"use client";

/**
 * 设置页配置 hook
 *
 * 抽出 settings 草稿态、已保存态、dirty 计算、按字段保存、未保存离页拦截。
 * 拆分原因：以前所有逻辑塞在 settings/page.tsx 里、组件 600+ 行难维护、
 * dirty 检测每次 render 跑 8 次 stringify、用 useMemo 缓存即可避免。
 *
 * 返回值约定：
 * - settings：当前编辑中的草稿、UI 双向绑定
 * - savedSettings：已写入 config.json 的版本、只读
 * - dirty：各字段的 dirty map（缓存计算结果、不要每次 render 重算）
 * - hasUnsaved：dirty 任一为 true（用于离页提示）
 * - update / saveFieldValue：更新草稿（文本框输入用）/ 落盘某字段（编辑即保存）
 * - loaded：是否完成首次 config 初始化尝试（避免 SSR/hydrate 闪空；不代表加载成功，见 loadFailed）
 * - unreadable：config.json 读取阶段就不可读（损坏 / 权限等）时的 reason；非 null 时暂停保存、
 *   设置页只展示错误提示（settings 此时是默认值、不是用户的配置）
 * - loadFailed：init 没能拿到磁盘上的真实配置（含 unreadable，也含网络 / 服务没就绪这类瞬时失败）。
 *   true 时 settings 只是默认值：设置页显示「加载失败 + 重试加载」、一切保存被拒（review #16）
 * - retryLoad / retrying：重新加载真实配置（失败态才有意义）；成功后草稿换成真实配置、才允许编辑
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import {
  DEFAULT_SETTINGS,
  getLastSettingsRejectReason,
  getSettings,
  getSettingsUnreadable,
  initSettings,
  isSettingsLoaded,
  saveSettingsDetailed,
} from "@/lib/local-store";
import {
  SETTINGS_NOT_LOADED_TOAST,
  canPersistSettings,
} from "@/lib/settings-load-state";
import {
  createSaveRetrier,
  saveWithRetry,
  type SaveRetrier,
} from "@/lib/save-retry";
import {
  describeSettingsUnreadable,
  type SettingsUnreadable,
} from "@/lib/settings-unreadable";
import type {
  FeAiFlowSettings,
  JumpIde,
  RepoConfig,
  SubmitShortcut,
} from "@/lib/types";

/** 服务端 4xx 拒绝保存（如校验不过的 400）：这类失败重试不会成功，所以文案不能说「将自动重试」 */
export const rejectedToast = (status: number, reason?: string | null): string =>
  reason?.trim()
    ? `保存失败：服务端拒绝了这次修改（HTTP ${status}）：${reason.trim()}。不会自动重试，请检查后再改一次该项`
    : `保存失败：服务端拒绝了这次修改（HTTP ${status}）、不会自动重试。请检查输入后再改一次该项`;

// RepoConfig 稳定序列化比较：字段顺序固定、可选字段缺省归一空串（CR-09）。
// 加新字段时记得补这里——漏了该字段的编辑不会触发 dirty。
const repoConfigCanonical = (r: RepoConfig): string =>
  JSON.stringify([
    r.path,
    r.name,
    r.onlineBranch ?? "",
    r.testBranch ?? "",
    r.devBranch ?? "",
    r.branchTemplate ?? "",
    r.previewCommand ?? "",
    r.setupCommand ?? "",
    // boolean 开关缺省归一 false（修：原先漏 readonly、切开关不触发 dirty）
    r.readonly ?? false,
    r.scriptRepo ?? false,
  ]);

export const repoConfigEquals = (a: RepoConfig, b: RepoConfig): boolean =>
  repoConfigCanonical(a) === repoConfigCanonical(b);

/**
 * 轻量读「代码跳转 IDE」配置（artifact-panel / 事件流附件 chip 等展示组件用）
 *
 * 跟 useSettings 的区别：那个是设置页专用重 hook（带 dirty 计算 + beforeunload 拦截）、
 * 展示组件只要一个值、不该背那些副作用。SSR 首渲返默认 cursor、挂载后读真实配置
 * （getSettings 在 render 里直接调会 hydration mismatch、必须走 effect）。
 */
export const useJumpIde = (): JumpIde => {
  const [ide, setIde] = useState<JumpIde>("cursor");
  useEffect(() => {
    // 先 await 配置初始化（读 config.json）、再读；init 前 cache 是默认值、不空窗
    // alive 守卫：对齐 useSettings，避免卸载后迟到 then 还 setState
    let alive = true;
    void initSettings().then(() => {
      if (!alive) return;
      setIde(getSettings().jumpIde ?? "cursor");
    });
    return () => {
      alive = false;
    };
  }, []);
  return ide;
};

export const useSubmitShortcut = (): SubmitShortcut => {
  const [shortcut, setShortcut] = useState<SubmitShortcut>("mod-enter");
  useEffect(() => {
    // 轻量读取个人输入偏好；默认保持旧行为，避免配置初始化前误改 Enter 语义。
    let alive = true;
    void initSettings().then(() => {
      if (!alive) return;
      setShortcut(getSettings().submitShortcut ?? "mod-enter");
    });
    return () => {
      alive = false;
    };
  }, []);
  return shortcut;
};

type SettingsField = keyof FeAiFlowSettings;

export interface UseSettingsResult {
  settings: FeAiFlowSettings;
  savedSettings: FeAiFlowSettings;
  loaded: boolean;
  unreadable: SettingsUnreadable | null;
  /** init 没拿到磁盘上的真实配置（含 unreadable）；此时 settings 只是默认值、保存被拒 */
  loadFailed: boolean;
  /** 「重试加载」进行中 */
  retrying: boolean;
  retryLoad: () => Promise<void>;
  dirty: Record<SettingsField, boolean>;
  hasUnsaved: boolean;
  update: <K extends SettingsField>(key: K, value: FeAiFlowSettings[K]) => void;
  // 即时存某字段的指定值（编辑即保存：选择 / 开关 onChange、文本框 onBlur 调）
  saveFieldValue: <K extends SettingsField>(
    key: K,
    value: FeAiFlowSettings[K],
  ) => Promise<boolean>;
}

/**
 * 字段 → 比较器种类（表驱动，R1-11）。
 * 新增 FeAiFlowSettings 字段时必须在此表登记——`satisfies Record<keyof …>`
 * 漏配会在编译期报错，避免再 fall-through 到错误比较器（同族已第三次）。
 *
 * - stringEmpty：缺省视同 ""
 * - boolFalse / boolTrue：缺省视同 false / true
 * - stringSet：字符串集合（排序后比，顺序无关）
 * - ignore：非设置页编辑字段（如 starredModels），恒视为相等（dirty 由调用方硬编码 false）
 */
type FieldEqKind =
  | "stringEmpty"
  | "boolFalse"
  | "boolTrue"
  | "repos"
  | "stringSet"
  | "mcpServers"
  | "actionLayout"
  | "defaultModel"
  | "meegleProject"
  | "companyEnv"
  | "provider"
  | "customProviders"
  | "ignore";

const FIELD_EQ_KIND = {
  apiKey: "stringEmpty",
  gitToken: "stringEmpty",
  branchTemplate: "stringEmpty",
  jumpIde: "stringEmpty",
  submitShortcut: "stringEmpty",
  userRole: "stringEmpty",
  reuseAgentDefault: "boolFalse",
  agentShellGitBash: "boolFalse",
  feishuChatBridge: "boolFalse",
  isolateWorktreeDefault: "boolTrue",
  feishuBridgeKeepAwake: "boolTrue",
  teamKnowledgeEnabled: "boolTrue",
  repos: "repos",
  disabledMcpServers: "stringSet",
  disabledSkills: "stringSet",
  disabledRules: "stringSet",
  mcpServers: "mcpServers",
  actionLayout: "actionLayout",
  defaultModel: "defaultModel",
  meegleProject: "meegleProject",
  companyEnv: "companyEnv",
  provider: "provider",
  customProviders: "customProviders",
  starredModels: "ignore",
} as const satisfies Record<SettingsField, FieldEqKind>;

const eqStringSet = (x: string[] | undefined, y: string[] | undefined): boolean => {
  const a = [...(x ?? [])].sort();
  const b = [...(y ?? [])].sort();
  if (a.length !== b.length) return false;
  return a.every((s, i) => s === b[i]);
};

/** 导出供单测锁定 dirty 比较（settings-save / 桥接开关回归） */
export const isFieldEqual = (
  key: SettingsField,
  a: FeAiFlowSettings,
  b: FeAiFlowSettings,
): boolean => {
  switch (FIELD_EQ_KIND[key]) {
    case "stringEmpty":
      return (a[key] ?? "") === (b[key] ?? "");
    case "boolFalse":
      return (a[key] ?? false) === (b[key] ?? false);
    case "boolTrue":
      return (a[key] ?? true) === (b[key] ?? true);
    case "repos": {
      // CR-09：完整比较 RepoConfig 全部持久字段（稳定序列化、undefined 归一空串）
      if (a.repos.length !== b.repos.length) return false;
      return a.repos.every((r, i) => repoConfigEquals(r, b.repos[i]));
    }
    case "stringSet":
      return eqStringSet(
        a[key] as string[] | undefined,
        b[key] as string[] | undefined,
      );
    case "mcpServers":
      return (
        JSON.stringify(a.mcpServers ?? {}) === JSON.stringify(b.mcpServers ?? {})
      );
    case "actionLayout": {
      const ax = a.actionLayout ?? { order: [], hidden: [] };
      const bx = b.actionLayout ?? { order: [], hidden: [] };
      const eqArr = (m: string[] | undefined, n: string[] | undefined) => {
        const mm = m ?? [];
        const nn = n ?? [];
        return mm.length === nn.length && mm.every((v, i) => v === nn[i]);
      };
      return (
        eqArr(ax.order, bx.order) &&
        eqArr(ax.hidden, bx.hidden) &&
        eqArr(ax.groupOrder, bx.groupOrder) &&
        eqArr(ax.collapsedGroups, bx.collapsedGroups)
      );
    }
    case "defaultModel": {
      const x = a.defaultModel;
      const y = b.defaultModel;
      if (x.id !== y.id) return false;
      const xp = x.params ?? [];
      const yp = y.params ?? [];
      if (xp.length !== yp.length) return false;
      return xp.every((p, i) => p.id === yp[i].id && p.value === yp[i].value);
    }
    case "meegleProject": {
      const ax = a.meegleProject;
      const bx = b.meegleProject;
      return (
        (ax?.key ?? "") === (bx?.key ?? "") &&
        (ax?.name ?? "") === (bx?.name ?? "") &&
        (ax?.simpleName ?? "") === (bx?.simpleName ?? "")
      );
    }
    case "companyEnv":
      // 结构化对象：稳定 JSON 比；缺省视同空配置
      return (
        JSON.stringify(a.companyEnv ?? {}) ===
        JSON.stringify(b.companyEnv ?? {})
      );
    case "provider":
      return (a.provider ?? "cursor") === (b.provider ?? "cursor");
    case "customProviders":
      return (
        JSON.stringify(a.customProviders ?? []) ===
        JSON.stringify(b.customProviders ?? [])
      );
    case "ignore":
      return true;
  }
};

export const useSettings = (): UseSettingsResult => {
  // 当前编辑中的设置快照（草稿）、可能跟磁盘上不同
  const [settings, setSettings] = useState<FeAiFlowSettings>(DEFAULT_SETTINGS);

  // 已经写入 config.json 的快照（已保存版本）、和草稿对比算 dirty
  const [savedSettings, setSavedSettings] = useState<FeAiFlowSettings>(DEFAULT_SETTINGS);

  // 是否已从 config 初始化灌过初值；防止 SSR 渲染时闪现空表单
  const [loaded, setLoaded] = useState(false);

  // config.json 在读取阶段就不可读（损坏 / 权限等）：此时 settings 只是默认值、不是用户的配置，
  // 保存必须暂停（local-store 本来也会拒绝整对象 PUT），否则 UI 会照常提示「将自动重试」而重试永远不会成功
  const [unreadable, setUnreadable] = useState<SettingsUnreadable | null>(null);
  // 给异步回调读最新值（saveFieldValue 是每次渲染新建的闭包）
  const unreadableRef = useRef(unreadable);
  unreadableRef.current = unreadable;

  // init 没能拿到磁盘上的真实配置（含 unreadable；也含网络 / 服务没就绪这类瞬时失败，它们没有 unreadable 状态）。
  // 此时 settings 只是默认值：以前这种情况渲染一个无提示的空表单、改一项就以默认值为底整包 PUT 覆盖磁盘（review #16）。
  const [loadFailed, setLoadFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const retryingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 把 local-store 的 init 结果（真实配置 or 默认值 + 失败态）同步进 hook 状态；首次加载与「重试加载」共用
  const applyInitResult = useCallback(() => {
    const s = getSettings();
    setSettings(s);
    setSavedSettings(s);
    setUnreadable(getSettingsUnreadable());
    setLoadFailed(!isSettingsLoaded());
    setLoaded(true);
  }, []);

  // 首次挂载：先 await 配置初始化（读 config.json）、再灌进草稿态
  useEffect(() => {
    let alive = true;
    void initSettings().then(() => {
      if (!alive) return;
      applyInitResult();
    });
    return () => {
      alive = false;
    };
  }, [applyInitResult]);

  // 「重试加载」：失败态下重新 GET /full；成功 → 草稿换成真实配置、解除拒写；仍失败 → 保持拒写并提示。
  // initSettings 失败会清空单飞 promise，所以这里会真的重新发请求（成功后再调只会复用结果）
  const retryLoad = useCallback(async (): Promise<void> => {
    if (retryingRef.current) return;
    retryingRef.current = true;
    setRetrying(true);
    try {
      await initSettings();
    } finally {
      retryingRef.current = false;
      if (mountedRef.current) {
        applyInitResult();
        setRetrying(false);
        if (isSettingsLoaded()) toast.success("配置已加载");
        else toast.error("重试加载仍失败，设置继续保持暂停保存");
      }
    }
  }, [applyInitResult]);

  // dirty 状态按字段缓存：各字段在 settings/savedSettings 任意变化时才重算
  // 避免之前每次 render 多次 JSON.stringify 的浪费
  const dirty = useMemo<Record<SettingsField, boolean>>(
    () => ({
      apiKey: !isFieldEqual("apiKey", settings, savedSettings),
      defaultModel: !isFieldEqual("defaultModel", settings, savedSettings),
      repos: !isFieldEqual("repos", settings, savedSettings),
      jumpIde: !isFieldEqual("jumpIde", settings, savedSettings),
      submitShortcut: !isFieldEqual("submitShortcut", settings, savedSettings),
      userRole: !isFieldEqual("userRole", settings, savedSettings),
      branchTemplate: !isFieldEqual("branchTemplate", settings, savedSettings),
      gitToken: !isFieldEqual("gitToken", settings, savedSettings),
      disabledMcpServers: !isFieldEqual(
        "disabledMcpServers",
        settings,
        savedSettings,
      ),
      mcpServers: !isFieldEqual("mcpServers", settings, savedSettings),
      actionLayout: !isFieldEqual("actionLayout", settings, savedSettings),
      reuseAgentDefault: !isFieldEqual(
        "reuseAgentDefault",
        settings,
        savedSettings,
      ),
      agentShellGitBash: !isFieldEqual(
        "agentShellGitBash",
        settings,
        savedSettings,
      ),
      isolateWorktreeDefault: !isFieldEqual(
        "isolateWorktreeDefault",
        settings,
        savedSettings,
      ),
      disabledSkills: !isFieldEqual("disabledSkills", settings, savedSettings),
      disabledRules: !isFieldEqual("disabledRules", settings, savedSettings),
      // 常用星标：下拉里直写、恒不 dirty
      starredModels: false,
      meegleProject: !isFieldEqual("meegleProject", settings, savedSettings),
      // 飞书 chat 桥接全局开关 / 插电防休眠（S1 落 settings、UI 段后续接）
      feishuChatBridge: !isFieldEqual(
        "feishuChatBridge",
        settings,
        savedSettings,
      ),
      feishuBridgeKeepAwake: !isFieldEqual(
        "feishuBridgeKeepAwake",
        settings,
        savedSettings,
      ),
      teamKnowledgeEnabled: !isFieldEqual(
        "teamKnowledgeEnabled",
        settings,
        savedSettings,
      ),
      companyEnv: !isFieldEqual("companyEnv", settings, savedSettings),
      provider: !isFieldEqual("provider", settings, savedSettings),
      customProviders: !isFieldEqual("customProviders", settings, savedSettings),
    }),
    [settings, savedSettings]
  );

  // 不可读时没有任何东西能存：不再算「有未保存修改」，免得离页还被 beforeunload 拦一道
  // 加载失败同理：草稿 = 默认值、没有「已保存」可言，也存不进去
  const hasUnsaved = useMemo(
    () => !unreadable && !loadFailed && Object.values(dirty).some(Boolean),
    [dirty, unreadable, loadFailed]
  );

  // 通用字段更新工具：只改草稿、不写 config.json
  const update = <K extends SettingsField>(
    key: K,
    value: FeAiFlowSettings[K]
  ) => {
    // 草稿被改了：该字段待办的自动重试作废。否则「保存失败 → 用户在框里改回旧值 → blur」时，
    // 因新值与落盘一致，调用方（apiKey 的早返回 / company-env 的 lastSaved 去重）不会再发起保存、
    // 也就没人 cancel 重试，退避后失败的新值会被写盘、与输入框里看到的不一致。
    // 只丢待办、不 bump 世代：repo-card 先落盘安全版再 update 草稿，安全版若失败仍要排重试
    retrierRef.current?.dropPending(key);
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  // 即时存某字段的指定值（编辑即保存的唯一落盘入口）：
  // - 选择 / 开关 / 增删等离散操作：onChange 里直接调（传新值）
  // - 文本框：onChange 只改草稿（update）、onBlur 时调本方法落盘（传当前值）
  // base 取 getSettings() 读「落盘最新」而非 savedSettings 闭包——连续存不同字段不会互相覆盖；
  // state 只更新该字段（不整体替换）——避免把其它正在输入、尚未 blur 的草稿字段冲掉。
  // CR-08：await 服务端 config.json 写结果——成功才把字段标「已保存」（savedSettings）、
  // 失败 toast（原实现 500 也静默当成功、重启后修改凭空消失）。草稿态先行更新（乐观）。
  // 不弹 success toast：编辑即存高频、刷屏没意义、仅失败时提示
  // S13-03：保存失败后的自动重试器（惰性建一次；字段级退避重试、新保存作废旧重试、卸载时补跑）
  const retrierRef = useRef<SaveRetrier | null>(null);
  const getRetrier = (): SaveRetrier => {
    if (!retrierRef.current) {
      retrierRef.current = createSaveRetrier({
        onRecovered: () => toast.success("配置已自动重试保存成功"),
        onGiveUp: () =>
          toast.error("配置多次重试仍未能保存、请检查磁盘 / 服务后再改一次该项"),
        // 重试那一次才被服务端 4xx 拒绝（如配置已被别处改成校验不过的形态）：同一份内容再重试没有意义
        onRejected: (_key, status) =>
          toast.error(rejectedToast(status, getLastSettingsRejectReason())),
      });
    }
    return retrierRef.current;
  };
  // 卸载（离开设置页）：待重试的字段立即各补跑一次，免得草稿随组件一起丢
  useEffect(
    () => () => {
      retrierRef.current?.flush();
    },
    [],
  );

  const saveFieldValue = <K extends SettingsField>(
    key: K,
    value: FeAiFlowSettings[K],
  ): Promise<boolean> => {
    // 不可读：不改草稿、不落盘、不排自动重试（它不是瞬时故障、重试永远成功不了）。
    // 设置页此时不渲染表单、正常走不到这里，这是兜底
    if (unreadableRef.current) {
      toast.error(describeSettingsUnreadable(unreadableRef.current.reason).headline);
      return Promise.resolve(false);
    }
    // 没成功加载过磁盘上的真实配置（瞬时失败 / 服务没就绪）：getSettings() 只是默认值，
    // 在它上面改一项再整包 PUT 会覆盖磁盘配置——同样不改草稿、不落盘、不排自动重试（重试也基于默认值）。
    // 直接问 local-store（真值源）、不用 loadFailed state：state 要等下一次渲染才更新，这里是兜底
    if (!canPersistSettings({ initSucceeded: isSettingsLoaded() })) {
      toast.error(SETTINGS_NOT_LOADED_TOAST);
      return Promise.resolve(false);
    }
    const next: FeAiFlowSettings = { ...getSettings(), [key]: value };
    setSettings((prev) => ({ ...prev, [key]: value }));
    // 作废旧重试 + 失败登记重试都交给 saveWithRetry：它按世代判断「期间是否有同字段的新保存」，
    // V1 的 PUT 在路上时用户又存了 V2，V1 晚失败就不会再排重试（否则退避后用旧值覆盖 V2）
    // 走带状态码的 saveSettingsDetailed：4xx（服务端明确拒绝）不排重试，5xx / 网络错误才重试
    return saveWithRetry({
      retrier: getRetrier(),
      key,
      first: () => saveSettingsDetailed(next, [key]),
      retry: async () => {
        // 重试用「落盘最新」做 base、只覆盖本字段（同首次保存）
        const res = await saveSettingsDetailed(
          { ...getSettings(), [key]: value },
          [key],
        );
        if (res.ok) setSavedSettings((prev) => ({ ...prev, [key]: value }));
        return res;
      },
      // 保存失败：savedSettings 不动 → 字段保持 dirty、离页仍会拦截提示；
      // 并登记自动重试——之前失败后草稿再没人去存、只能等用户碰巧再改一次
      onFailed: () => toast.error("保存失败：配置没能写入 config.json、将自动重试"),
      // 被服务端 4xx 拒绝：不会重试，提示不能再说「将自动重试」
      onRejected: (status) =>
        toast.error(rejectedToast(status, getLastSettingsRejectReason())),
    }).then((ok) => {
      if (ok) setSavedSettings((prev) => ({ ...prev, [key]: value }));
      return ok;
    });
  };

  // 离页前拦截：用 ref 持有最新 hasUnsaved、listener 只挂一次
  // 不放在 deps 里、避免 hasUnsaved 每变都 add/remove
  const hasUnsavedRef = useRef(hasUnsaved);
  hasUnsavedRef.current = hasUnsaved;

  useEffect(() => {
    if (!loaded) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasUnsavedRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [loaded]);

  return {
    settings,
    savedSettings,
    loaded,
    unreadable,
    loadFailed,
    retrying,
    retryLoad,
    dirty,
    hasUnsaved,
    update,
    saveFieldValue,
  };
};
