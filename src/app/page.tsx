"use client";

/**
 * 首页 = 飞书项目看板（V0.14、用户拍板「首页做成飞书项目看板」）
 *
 * - v1.0.x 新用户引导：三项就绪度（API Key / 飞书工具 / 仓库）任一未完成 →
 *   看板位置显示「开始使用」清单（行内直接配置）、全就绪自动切正常看板
 * - 已接飞书项目：我的工作项看板（列表 / 时间线、双状态徽标、点击直进任务或预览启动）
 * - 「新建任务」入口已砍（任务只从飞书工作项进）；临时需求切「对话」模式新建（v1.0 胶囊）
 */

import { FeishuBoard } from "@/components/feishu/feishu-board";
import { SetupChecklist, useSetupGate } from "@/components/setup-checklist";
import { LoadingState } from "@/components/ui/loading-state";

const HomePage = () => {
  const gate = useSetupGate();
  if (gate.loading) return <LoadingState variant="hero" />;
  if (!gate.ready) return <SetupChecklist gate={gate} />;
  return <FeishuBoard />;
};

export default HomePage;
