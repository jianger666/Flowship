"use client";

/**
 * 客户端 Providers 集合
 * - next-themes：三态主题（浅色 / 深色 / 跟随系统）、默认跟随系统、顶栏 ThemeToggle 切换
 *   attribute="class" → 在 <html> 挂 .light/.dark；disableTransitionOnChange 防切换瞬间闪色
 * - DialogProvider：全局 confirm / prompt（禁用 window.{alert,confirm,prompt}）
 * - TaskListProvider：全局任务列表（侧栏 + 各页面共享、统一刷新 / 同步）
 * - ImagePreviewProvider：全局图片 lightbox（ImageThumb 点击站内看大图）
 * - 后续如果接 react-query / jotai 等也都加在这里
 */

import { ThemeProvider } from "next-themes";
import { useEffect, type ReactNode } from "react";

import { DialogProvider } from "@/hooks/use-dialog";
import { ImagePreviewProvider } from "@/components/ui/image-preview";
import { CloseConfirmHandler } from "@/components/close-confirm-handler";
import { DeepLinkHandler } from "@/components/deep-link-handler";
import { TaskAttentionWatcher } from "@/components/task-attention-watcher";
import { TaskListProvider } from "@/hooks/use-task-list";
import { MrInboxProvider } from "@/hooks/use-mr-inbox";
import { getSettings, initSettings } from "@/lib/local-store";
import { useModels } from "@/hooks/use-models";

interface ProvidersProps {
  children: ReactNode;
}

// 模型列表预热（V0.7.13 用户拍板「打开软件就拉一次」）：
// app 加载后台静默拉一遍 → 写进 localStorage 缓存 + server 内存缓存、
// 之后所有用到模型列表的入口（新建任务 / 设置 / 切模型）全是秒出
const ModelsPrefetch = () => {
  const { fetchModels } = useModels();
  useEffect(() => {
    // await 配置初始化后再读 apiKey（清理版删掉 localStorage 后、缓存只有 init 后才有值）
    void initSettings().then(() => {
      const key = getSettings().apiKey?.trim();
      if (key) void fetchModels(key);
    });
  }, [fetchModels]);
  return null;
};

export const Providers = ({ children }: ProvidersProps) => {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {/* DialogProvider 提供全局 confirm/prompt——禁用 window.{alert,confirm,prompt}、
          统一走 shadcn 风格弹窗。组件内用 useDialog() 拿到 confirm / prompt */}
      <DialogProvider>
        <ModelsPrefetch />
        {/* ImagePreviewProvider：全局图片 lightbox（任意 ImageThumb 点击站内看大图、多图左右切换） */}
        <ImagePreviewProvider>
          {/* TaskListProvider：侧栏 + 各页面共享同一份任务列表、新建 / 删除 / 状态变化统一同步 */}
          <TaskListProvider>
            {/* MrInboxProvider：提测收件箱（顶栏 badge + 任务内提醒条共享一份、前台 5 分钟轮询） */}
            <MrInboxProvider>
              {/* 任务转入「等你回复」且窗口在后台 → 系统通知 + Dock 角标（点通知跳详情页） */}
              <TaskAttentionWatcher />
              {/* 飞书卡片深链 flowship://tasks/<id> → 路由跳对应任务页 */}
              <DeepLinkHandler />
              <CloseConfirmHandler />
              {children}
            </MrInboxProvider>
          </TaskListProvider>
        </ImagePreviewProvider>
      </DialogProvider>
    </ThemeProvider>
  );
};
