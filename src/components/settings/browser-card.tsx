"use client";

/**
 * 「内置浏览器」设置节（桌面端内置浏览器的两个开关 + 清登录态）。
 *
 * 布局定式同偏好卡：统一设置行（名称 + 一句说明 | 控件）。
 * 无桌面壳（浏览器里访问 / pnpm dev:web）时 `window.__browser` 不存在：两个开关仍可改（只是个设置值），
 * 但「清除浏览器登录数据」不可用，并给出「仅桌面端可用」的提示——不隐藏，免得用户找不到、也搞不清为什么没有。
 *
 * 清除前的确认走 `useDialog().confirm({ destructive: true })`（与面板菜单同一个流程 / 同一份文案，见 clear-data-flow.ts）。
 * 以前这里自己做「点一次变『确认清除』、5 秒内再点才真清」的两步确认：不可逆操作不走统一确认框违反 ui-conventions，
 * 而且 5 秒窗口对读屏 / 键盘用户很不友好（R2-14 ⑤）。
 */

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { runClearBrowsingData } from "@/components/browser/clear-data-flow";
import { Button } from "@/components/ui/button";
import { IntInput } from "@/components/ui/int-input";
import { SettingRow } from "@/components/ui/setting-row";
import { Switch } from "@/components/ui/switch";
import { useDialog } from "@/hooks/use-dialog";

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
          await api.clearBrowsingData();
        } finally {
          setBusy(false);
        }
      },
      onSuccess: () => toast.success("已清除内置浏览器的登录数据"),
      onError: (msg) => toast.error(`清除失败：${msg}`),
    });
  };

  return (
    <div className="divide-y divide-border/60">
      <SettingRow
        label="允许 AI 执行页面脚本"
        hint="开启后 AI 可直接在网页里运行 JavaScript（browser_evaluate），能力强、风险也高；默认关闭。关闭时 AI 想执行脚本，会先在浏览器面板弹出审批卡，由你选择仅本任务允许、永久开启或拒绝"
        control={
          <Switch
            checked={evaluateEnabled}
            onCheckedChange={onEvaluateEnabledChange}
          />
        }
      />
      <SettingRow
        label="记录你输入的内容"
        hint="开启后，你在浏览器里的输入会连同内容一起告诉 AI（邮箱、令牌、卡号等敏感格式仍会自动打码）；默认只记「输入了几个字」。密码框的内容无论如何都不记录"
        control={
          <Switch
            checked={recordInputValues}
            onCheckedChange={onRecordInputValuesChange}
          />
        }
      />
      <SettingRow
        label="允许 AI 读写登录态"
        hint="开启后 AI 能看到 Cookie / 本地存储的明文值，也能写入、删除、导出和导入登录状态。导出的文件含明文凭据（Cookie / 令牌），保存在任务目录（权限 0600），14 天后自动清理；无痕标签的数据不允许导出。默认关闭时只能看到名字和属性，值只显示长度和前 4 位"
        control={<Switch checked={storageAccess} onCheckedChange={onStorageAccessChange} />}
      />
      <SettingRow
        label="允许 AI 授予页面权限"
        hint="开启后 AI 可以代你对页面请求的权限（定位、通知、读剪贴板等）点允许或拒绝；默认关闭，页面请求权限时由你在面板上决定。摄像头和麦克风永远默认拒绝"
        control={<Switch checked={pagePermissions} onCheckedChange={onPagePermissionsChange} />}
      />
      <SettingRow
        label="自动放行本机的自签名证书"
        hint="只对真正的本机地址生效：localhost（含 *.localhost）、127.0.0.0/8 和 ::1，用于本机开发站点的自签名证书。*.local（局域网设备名，可能是别人的机器）不在此列，仍会询问你；其它网站的证书错误同样要你在面板上确认"
        control={<Switch checked={trustLoopbackCerts} onCheckedChange={onTrustLoopbackCertsChange} />}
      />
      <SettingRow
        label="允许 AI 读取网络响应内容"
        hint="开启后 AI 可以查看请求和响应的正文（已自动隐去令牌、密码等敏感内容）；关闭后只能看到地址、状态和头部"
        control={<Switch checked={networkBodyRead} onCheckedChange={onNetworkBodyReadChange} />}
      />
      <SettingRow
        label="高级调试工具"
        hint="给 AI 提供网络规则、性能分析、源码查看、断点调试、录制这组前端调试工具；关闭可以省一些提示词。对新开始的会话生效"
        control={<Switch checked={advancedTools} onCheckedChange={onAdvancedToolsChange} />}
      />
      <SettingRow
        label="标签页数量上限"
        hint="单个任务最多同时打开几个标签页（5–60）。每个标签页是一个独立的渲染进程，设太大会吃内存"
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
      <SettingRow
        label="清除浏览器登录数据"
        hint={
          desktop
            ? "清掉内置浏览器保存的 Cookie 与站点数据，所有网站需要重新登录"
            : "仅桌面端可用"
        }
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
