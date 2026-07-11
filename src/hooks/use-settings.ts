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
 * - savedSettings：已写到 localStorage 的版本、只读
 * - dirty：各字段的 dirty map（缓存计算结果、不要每次 render 重算）
 * - hasUnsaved：dirty 任一为 true（用于离页提示）
 * - update / saveFieldValue：更新草稿（文本框输入用）/ 落盘某字段（编辑即保存）
 * - loaded：是否完成首次 localStorage 加载（避免 SSR/hydrate 闪空）
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
    // 先 await 配置初始化（读 config.json / 首次迁移）、再读；缓存有 localStorage 兜底、init 慢也不空
    void initSettings().then(() => setIde(getSettings().jumpIde ?? "cursor"));
  }, []);
  return ide;
};

export const useSubmitShortcut = (): SubmitShortcut => {
  const [shortcut, setShortcut] = useState<SubmitShortcut>("mod-enter");
  useEffect(() => {
    // 轻量读取个人输入偏好；默认保持旧行为，避免配置初始化前误改 Enter 语义。
    void initSettings().then(() =>
      setShortcut(getSettings().submitShortcut ?? "mod-enter"),
    );
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
  ) => void;
}

// 浅比较 / 深比较都不通用、按字段类型分别比较：
// - apiKey / gitHost / gitToken：字符串直接 ===
// - defaultModel：嵌套对象、id + params 数组按位比较
// - repos：数组、长度 + 每项 path/name 比较
const isFieldEqual = (
  key: SettingsField,
  a: FeAiFlowSettings,
  b: FeAiFlowSettings
): boolean => {
  if (
    key === "apiKey" ||
    key === "gitHost" ||
    key === "gitToken" ||
    key === "branchTemplate" ||
    key === "jumpIde" ||
    key === "submitShortcut"
  ) {
    return (a[key] ?? "") === (b[key] ?? "");
  }
  if (key === "repos") {
    // CR-09：完整比较 RepoConfig 全部持久字段（稳定序列化、undefined 归一空串）——
    // 原实现只比 path/name、编辑分支 / 模板 / 预览命令时 dirty 恒 false、离页不提示
    if (a.repos.length !== b.repos.length) return false;
    return a.repos.every((r, i) => repoConfigEquals(r, b.repos[i]));
  }
  if (key === "reuseAgentDefault") {
    // boolean 字段：缺省视同 false 比较
    return (a[key] ?? false) === (b[key] ?? false);
  }
  if (key === "isolateWorktreeDefault") {
    // boolean 字段：缺省视同 true 比较（默认隔离）
    return (a[key] ?? true) === (b[key] ?? true);
  }
  if (
    key === "disabledMcpServers" ||
    key === "disabledSkills" ||
    key === "disabledRules"
  ) {
    // 黑名单是集合、顺序无关——排序后逐项比
    const x = [...(a[key] ?? [])].sort();
    const y = [...(b[key] ?? [])].sort();
    if (x.length !== y.length) return false;
    return x.every((s, i) => s === y[i]);
  }
  if (key === "mcpServers") {
    return (
      JSON.stringify(a.mcpServers ?? {}) === JSON.stringify(b.mcpServers ?? {})
    );
  }
  if (key === "actionLayout") {
    // order 是排序、顺序有意义——逐位比；hidden 同样逐位比
    const ax = a.actionLayout ?? { order: [], hidden: [] };
    const bx = b.actionLayout ?? { order: [], hidden: [] };
    const eqArr = (m: string[], n: string[]) =>
      m.length === n.length && m.every((v, i) => v === n[i]);
    return eqArr(ax.order, bx.order) && eqArr(ax.hidden, bx.hidden);
  }
  // defaultModel：浅比较 id + params 数组
  const x = a.defaultModel;
  const y = b.defaultModel;
  if (x.id !== y.id) return false;
  const xp = x.params ?? [];
  const yp = y.params ?? [];
  if (xp.length !== yp.length) return false;
  return xp.every((p, i) => p.id === yp[i].id && p.value === yp[i].value);
};

export const useSettings = (): UseSettingsResult => {
  // 当前编辑中的设置快照（草稿）、可能跟磁盘上不同
  const [settings, setSettings] = useState<FeAiFlowSettings>(DEFAULT_SETTINGS);

  // 已经写到 localStorage 的快照（已保存版本）、和草稿对比算 dirty
  const [savedSettings, setSavedSettings] = useState<FeAiFlowSettings>(DEFAULT_SETTINGS);

  // 是否已从 localStorage 读到初值；防止 SSR 渲染时闪现空表单
  const [loaded, setLoaded] = useState(false);

  // 首次挂载：先 await 配置初始化（读 config.json / 首次从 localStorage 迁移）、再灌进草稿态
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
      branchTemplate: !isFieldEqual("branchTemplate", settings, savedSettings),
      gitHost: !isFieldEqual("gitHost", settings, savedSettings),
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
      isolateWorktreeDefault: !isFieldEqual(
        "isolateWorktreeDefault",
        settings,
        savedSettings,
      ),
      disabledSkills: !isFieldEqual("disabledSkills", settings, savedSettings),
      disabledRules: !isFieldEqual("disabledRules", settings, savedSettings),
      // 模型使用计数：非设置页字段（recordModelUsage 直写）、恒不 dirty
      modelUsage: false,
    }),
    [settings, savedSettings]
  );

  const hasUnsaved = useMemo(
    () => Object.values(dirty).some(Boolean),
    [dirty]
  );

  // 通用字段更新工具：只改草稿、不写 localStorage
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
  ): void => {
    const next: FeAiFlowSettings = { ...getSettings(), [key]: value };
    setSettings((prev) => ({ ...prev, [key]: value }));
    void saveSettings(next).then((ok) => {
      if (ok) {
        setSavedSettings((prev) => ({ ...prev, [key]: value }));
      } else {
        // 保存失败：savedSettings 不动 → 字段保持 dirty、离页仍会拦截提示
        toast.error("保存失败：配置没能写入 config.json、请重试");
      }
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
