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
 * - dirty：4 个字段的 dirty map（缓存计算结果、不要每次 render 重算）
 * - hasUnsaved：dirty 任一为 true（用于离页提示）
 * - update / saveField：分别更新草稿 / 把单字段刷盘
 * - loaded：是否完成首次 localStorage 加载（避免 SSR/hydrate 闪空）
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { DEFAULT_SETTINGS, getSettings, saveSettings } from "@/lib/local-store";
import type { FeAiFlowSettings } from "@/lib/types";

export type SettingsField = keyof FeAiFlowSettings;

export interface UseSettingsResult {
  settings: FeAiFlowSettings;
  savedSettings: FeAiFlowSettings;
  loaded: boolean;
  dirty: Record<SettingsField, boolean>;
  hasUnsaved: boolean;
  update: <K extends SettingsField>(key: K, value: FeAiFlowSettings[K]) => void;
  saveField: (key: SettingsField) => boolean;
}

// 浅比较 / 深比较都不通用、按字段类型分别比较：
// - apiKey / mcpServersJson：字符串直接 ===
// - defaultModel：嵌套对象、JSON.stringify 简单粗暴但够用（量很小）
// - repos：数组、长度 + 每项 path/name 比较
const isFieldEqual = (
  key: SettingsField,
  a: FeAiFlowSettings,
  b: FeAiFlowSettings
): boolean => {
  if (key === "apiKey" || key === "mcpServersJson") {
    return a[key] === b[key];
  }
  if (key === "repos") {
    if (a.repos.length !== b.repos.length) return false;
    return a.repos.every((r, i) => r.path === b.repos[i].path && r.name === b.repos[i].name);
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

  // 首次挂载读 localStorage、settings 和 savedSettings 都用同一份初值
  useEffect(() => {
    const s = getSettings();
    setSettings(s);
    setSavedSettings(s);
    setLoaded(true);
  }, []);

  // dirty 状态按字段缓存：4 个字段在 settings/savedSettings 任意变化时才重算
  // 避免之前每次 render 8 次 JSON.stringify 的浪费
  const dirty = useMemo<Record<SettingsField, boolean>>(
    () => ({
      apiKey: !isFieldEqual("apiKey", settings, savedSettings),
      defaultModel: !isFieldEqual("defaultModel", settings, savedSettings),
      repos: !isFieldEqual("repos", settings, savedSettings),
      mcpServersJson: !isFieldEqual("mcpServersJson", settings, savedSettings),
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

  // 单字段保存：只把当前 Card 对应的字段写到 localStorage、其他字段保留
  // 4 张 Card 互不干扰、谁改谁存。返回 boolean 让调用方知道是否真存进去了
  const saveField = (key: SettingsField): boolean => {
    const next: FeAiFlowSettings = { ...savedSettings, [key]: settings[key] };
    const ok = saveSettings(next);
    if (ok) {
      setSavedSettings(next);
      toast.success("已保存");
    } else {
      toast.error("保存失败、可能 localStorage 配额已满或处于隐私模式");
    }
    return ok;
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
    saveField,
  };
};
