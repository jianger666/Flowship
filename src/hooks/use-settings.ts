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
 * - loaded：是否完成首次 config 初始化（避免 SSR/hydrate 闪空）
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import {
  DEFAULT_SETTINGS,
  getSettings,
  initSettings,
  saveSettings,
} from "@/lib/local-store";
import type {
  FeAiFlowSettings,
  JumpIde,
  RepoConfig,
  SubmitShortcut,
} from "@/lib/types";

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
 * - ignore：非设置页编辑字段（如 modelUsage），恒视为相等（dirty 由调用方硬编码 false）
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
  feishuBridgeStreaming: "boolTrue",
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
  modelUsage: "ignore",
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

  // 首次挂载：先 await 配置初始化（读 config.json）、再灌进草稿态
  useEffect(() => {
    let alive = true;
    void initSettings().then(() => {
      if (!alive) return;
      const s = getSettings();
      setSettings(s);
      setSavedSettings(s);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, []);

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
      // 模型使用计数：非设置页字段（recordModelUsage 直写）、恒不 dirty
      modelUsage: false,
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
      feishuBridgeStreaming: !isFieldEqual(
        "feishuBridgeStreaming",
        settings,
        savedSettings,
      ),
      teamKnowledgeEnabled: !isFieldEqual(
        "teamKnowledgeEnabled",
        settings,
        savedSettings,
      ),
      companyEnv: !isFieldEqual("companyEnv", settings, savedSettings),
    }),
    [settings, savedSettings]
  );

  const hasUnsaved = useMemo(
    () => Object.values(dirty).some(Boolean),
    [dirty]
  );

  // 通用字段更新工具：只改草稿、不写 config.json
  const update = <K extends SettingsField>(
    key: K,
    value: FeAiFlowSettings[K]
  ) => {
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
  const saveFieldValue = <K extends SettingsField>(
    key: K,
    value: FeAiFlowSettings[K],
  ): Promise<boolean> => {
    const next: FeAiFlowSettings = { ...getSettings(), [key]: value };
    setSettings((prev) => ({ ...prev, [key]: value }));
    return saveSettings(next).then((ok) => {
      if (ok) {
        setSavedSettings((prev) => ({ ...prev, [key]: value }));
      } else {
        // 保存失败：savedSettings 不动 → 字段保持 dirty、离页仍会拦截提示
        toast.error("保存失败：配置没能写入 config.json、请重试");
      }
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
    dirty,
    hasUnsaved,
    update,
    saveFieldValue,
  };
};
