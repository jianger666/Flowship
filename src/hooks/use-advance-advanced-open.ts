"use client";

/**
 * 推进弹窗「高级选项」区的开合状态：用户偏好（view-memory 记忆）+ 临时强制展开。
 *
 * - 偏好：用户亲手点触发器才写 view-memory（localStorage、全局共用、默认收起），下次打开保持；
 * - 强制展开：区里有「必须让用户看见」的阻断项时（目前只有「没选模型又不续用」——提交会被拦、
 *   而模型选择器就在高级区里）临时撑开。**不落盘**（不是用户的偏好）、弹窗关闭即清；
 *   用户此时手动收起 = 同时清强制并存「收起」，不跟用户抢。
 */

import { useCallback, useEffect, useState } from "react";

import {
  loadAdvanceAdvancedOpen,
  saveAdvanceAdvancedOpen,
} from "@/lib/view-memory";

export const useAdvanceAdvancedOpen = (dialogOpen: boolean) => {
  // 用户偏好的开合态：惰性读 view-memory（弹窗关着不渲染内容、SSR 读不到只得 false，无 hydration 差异）
  const [pref, setPref] = useState<boolean>(() => loadAdvanceAdvancedOpen());
  // 临时强制展开（阻断项需要露出来时置位、不落盘、弹窗关闭清零）
  const [forced, setForced] = useState(false);

  // 每次打开重读一遍偏好（多窗口场景别处改过也能跟上）；关闭时清强制态
  useEffect(() => {
    if (dialogOpen) setPref(loadAdvanceAdvancedOpen());
    else setForced(false);
  }, [dialogOpen]);

  // 用户点触发器：写偏好并落盘；收起同时撤销强制，避免「点了收起又弹开」
  const setExpanded = useCallback((next: boolean) => {
    setPref(next);
    if (!next) setForced(false);
    saveAdvanceAdvancedOpen(next);
  }, []);

  // 阻断项需要露出来：只展开、不改偏好（引用稳定，可放心进 effect 依赖）
  const forceExpand = useCallback(() => setForced(true), []);

  return { expanded: pref || forced, setExpanded, forceExpand };
};
