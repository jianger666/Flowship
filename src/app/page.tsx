"use client";

/**
 * 首页 = 飞书项目看板（V0.14、用户拍板「首页做成飞书项目看板」）
 *
 * - v1.0.x 新用户引导：三项就绪度（API Key / 飞书工具 / 仓库）任一未完成 →
 *   看板位置显示「开始使用」清单（行内直接配置）、全就绪自动切正常看板
 * - 已接飞书项目：我的工作项看板（列表 / 时间线、双状态徽标、点击直进任务或预览启动）
 * - 「新建任务」入口已砍（任务只从飞书工作项进）；临时需求切「对话」模式新建（v1.0 胶囊）
 */

import { useEffect } from "react";

import { FeishuBoard } from "@/components/feishu/feishu-board";
import { SetupChecklist, useSetupGate } from "@/components/setup-checklist";
import { LoadingState } from "@/components/ui/loading-state";
import { markShellContentReady } from "@/lib/shell-ready";

const HomePage = () => {
  const gate = useSetupGate();

  // 开屏一屏到底（v1.1.x）：就绪清单是「真实内容」、渲出来即通知壳收 splash；
  // 看板分支的通知由 FeishuBoard 在数据首渲时发（等内容、不是等外壳）
  useEffect(() => {
    if (!gate.loading && !gate.ready) markShellContentReady();
  }, [gate.loading, gate.ready]);

  // immediate：启动链必然要等、延迟出场反而跟后面看板 loading 接力时「亮-灭-亮」闪
  if (gate.loading) return <LoadingState variant="hero" immediate />;
  if (!gate.ready) return <SetupChecklist gate={gate} />;
  return <FeishuBoard />;
};

export default HomePage;
