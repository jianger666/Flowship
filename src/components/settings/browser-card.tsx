"use client";

/**
 * 「内置浏览器」设置节（桌面端内置浏览器的 AI 权限开关 + 标签页上限 + 清登录态）。
 *
 * 布局定式同偏好卡：统一设置行（名称 + 一句说明 | 控件）。**每行说明只留一句**，补充说明进名称后面的 ⓘ 气泡
 *（SettingRow 的 `detail`）——这张卡以前每行一大段字，用户点名过「一大串一大串的字」。
 * 全部文案在 `@/lib/browser-settings-copy`（纯数据，契约测试直接断言它）；本文件只管布局和接线。
 * 行序：AI 能做什么（脚本 / 登录态 / 页面权限）→ AI 能看到什么（网络正文 / 你的输入）→ 调试工具 → 浏览器自身（证书 / 标签页）→ 清除。
 * 无桌面壳（浏览器里访问 / pnpm dev:web）时 `window.__browser` 不存在：开关仍可改（只是个设置值），
 * 但「清除浏览器登录数据」不可用，并给出「仅桌面端可用」的提示——不隐藏，免得用户找不到、也搞不清为什么没有。
 *
 * 清除前的确认走 `useDialog().confirm({ destructive: true })`（与面板菜单同一个流程 / 同一份文案，见 clear-data-flow.ts）。
 * 以前这里自己做「点一次变『确认清除』、5 秒内再点才真清」的两步确认：不可逆操作不走统一确认框违反 ui-conventions，
 * 而且 5 秒窗口对读屏 / 键盘用户很不友好（R2-14 ⑤）。
 */

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { clearSuccessMessage, runClearBrowsingData } from "@/components/browser/clear-data-flow";
import { Button } from "@/components/ui/button";
import { IntInput } from "@/components/ui/int-input";
import { SettingRow } from "@/components/ui/setting-row";
import { Switch } from "@/components/ui/switch";
import { useDialog } from "@/hooks/use-dialog";
import {
  BROWSER_SETTING_COPY as COPY,
  type BrowserSettingCopy,
} from "@/lib/browser-settings-copy";

/** 文案条目 → SettingRow 的 label / hint / detail（detail 缺省就不出 ⓘ） */
const rowCopy = (c: BrowserSettingCopy) => ({
  label: c.label,
  hint: c.hint,
  detail: c.detail,
});

interface BrowserSectionProps {
  /** 允许 AI 在页面里执行 JS（browser_evaluate）。默认关 */
  evaluateEnabled: boolean;
  onEvaluateEnabledChange: (next: boolean) => void;
  /** 用户操作记录里带上输入的值（密码框永不记）。默认关 */
  recordInputValues: boolean;
  onRecordInputValuesChange: (next: boolean) => void;
  /** 增强包 E2（契约 §15）：允许 AI 读写登录态（cookie / storage 明文、写入、导入导出）。默认关 */
  storageAccess: boolean;
  onStorageAccessChange: (next: boolean) => void;
  /** 允许 AI 授予 / 拒绝页面权限（定位 / 通知 / 剪贴板读…）。默认关 */
  pagePermissions: boolean;
  onPagePermissionsChange: (next: boolean) => void;
  /** 自动放行真正本机（localhost / *.localhost / 127.0.0.0/8 / ::1；R6-23：不含 *.local）的自签名证书。默认开 */
  trustLoopbackCerts: boolean;
  onTrustLoopbackCertsChange: (next: boolean) => void;
  /** 允许 AI 读取网络请求 / 响应体（已脱敏）。默认开 */
  networkBodyRead: boolean;
  onNetworkBodyReadChange: (next: boolean) => void;
  /** 给 AI 注册「高级调试」工具组（网络规则 / 性能 / 源码 / 调试器 / 录制）。默认开 */
  advancedTools: boolean;
  onAdvancedToolsChange: (next: boolean) => void;
  /** 单个任务同时打开的标签页上限（5–60，缺省 20） */
  maxTabs: number;
  onMaxTabsChange: (next: number) => void;
}

export const BrowserSection = ({
  evaluateEnabled,
  onEvaluateEnabledChange,
  recordInputValues,
  onRecordInputValuesChange,
  storageAccess,
  onStorageAccessChange,
  pagePermissions,
  onPagePermissionsChange,
  trustLoopbackCerts,
  onTrustLoopbackCertsChange,
  networkBodyRead,
  onNetworkBodyReadChange,
  advancedTools,
  onAdvancedToolsChange,
  maxTabs,
  onMaxTabsChange,
}: BrowserSectionProps) => {
  // window.__browser 只在客户端挂载后才能读（SSR / 水合阶段当不可用，避免水合不一致）
  const [desktop, setDesktop] = useState(false);
  const [busy, setBusy] = useState(false);
  const { confirm } = useDialog();

  useEffect(() => {
    setDesktop(typeof window.__browser?.clearBrowsingData === "function");
  }, []);

  const handleClear = async () => {
    const api = window.__browser;
    if (!api) return;
    await runClearBrowsingData({
      confirm,
      // busy 只罩住「确认之后的真清除」；确认框是模态的，弹着的时候点不到这个按钮，不需要再防重入
      clear: async () => {
        setBusy(true);
        try {
          // 要把主进程的结果（重新加载了几个标签）原样交回去给 onSuccess 出提示，所以这里 return 而不是丢弃
          return await api.clearBrowsingData();
        } finally {
          setBusy(false);
        }
      },
      onSuccess: (result) => toast.success(clearSuccessMessage(result)),
      onError: (msg) => toast.error(`清除失败：${msg}`),
    });
  };

  return (
    <div className="divide-y divide-border/60">
      {/* ① AI 能做什么：默认关、风险高的放最上面 */}
      <SettingRow
        {...rowCopy(COPY.evaluate)}
        control={
          <Switch
            checked={evaluateEnabled}
            onCheckedChange={onEvaluateEnabledChange}
          />
        }
      />
      <SettingRow
        {...rowCopy(COPY.storage)}
        control={<Switch checked={storageAccess} onCheckedChange={onStorageAccessChange} />}
      />
      <SettingRow
        {...rowCopy(COPY.permissions)}
        control={<Switch checked={pagePermissions} onCheckedChange={onPagePermissionsChange} />}
      />
      {/* ② AI 能看到什么 */}
      <SettingRow
        {...rowCopy(COPY.networkBody)}
        control={<Switch checked={networkBodyRead} onCheckedChange={onNetworkBodyReadChange} />}
      />
      <SettingRow
        {...rowCopy(COPY.recordInput)}
        control={
          <Switch
            checked={recordInputValues}
            onCheckedChange={onRecordInputValuesChange}
          />
        }
      />
      {/* ③ 调试工具 + 浏览器自身 */}
      <SettingRow
        {...rowCopy(COPY.advancedTools)}
        control={<Switch checked={advancedTools} onCheckedChange={onAdvancedToolsChange} />}
      />
      <SettingRow
        {...rowCopy(COPY.loopbackCerts)}
        control={<Switch checked={trustLoopbackCerts} onCheckedChange={onTrustLoopbackCertsChange} />}
      />
      <SettingRow
        {...rowCopy(COPY.maxTabs)}
        control={
          <IntInput
            value={maxTabs}
            min={5}
            max={60}
            fallback={20}
            label="标签页上限"
            aria-label="标签页数量上限"
            className="w-20"
            onCommit={onMaxTabsChange}
          />
        }
      />
      {/* ④ 破坏性操作放最后 */}
      <SettingRow
        label={COPY.clearData.label}
        hint={desktop ? COPY.clearData.hint : COPY.clearData.unavailable}
        control={
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!desktop || busy}
            onClick={() => void handleClear()}
          >
            {busy ? "清除中…" : "清除"}
          </Button>
        }
      />
    </div>
  );
};
