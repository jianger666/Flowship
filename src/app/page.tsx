"use client";

/**
 * 首页 = 飞书项目看板（V0.14、用户拍板「首页做成飞书项目看板」）
 *
 * - 已接飞书项目：我的工作项看板（列表 / 时间线、双状态徽标、点击直进任务或预览启动）
 * - 未接（CLI 未装 / 未授权）：看板内降级引导（FeishuBoard 自带）
 * - 「新建任务」入口已砍（任务只从飞书工作项进）；临时需求走侧栏「新建对话」（chat）
 */

import { FeishuBoard } from "@/components/feishu/feishu-board";

const HomePage = () => <FeishuBoard />;

export default HomePage;
