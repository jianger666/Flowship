"use client";

/**
 * 首页「开始使用」就绪清单（v1.0.x、用户拍板「保证新用户进来就去配置安装飞书工具」）
 *
 * 四项就绪度：① Cursor API Key ② 飞书工具 ③ 至少一个仓库 ④ 我的角色。
 * 任一未完成 → 首页看板位置显示本清单；全部就绪 → 自动消失、首页变正常飞书排期看板。
 * 已配好的老用户永远看不到这张卡。
 *
 * 形态：单卡多行、多数行 = 状态勾 + 标题 + 「去配置」跳设置页；
 * 「我的角色」行内嵌 ChoiceButton chip 直接点选落盘、无需跳设置页。
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, CheckCircle2, Circle } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { ChoiceButton } from "@/components/ui/choice-button";
import { buttonVariants } from "@/components/ui/button";
import { useSettings } from "@/hooks/use-settings";
import { settingsUrl } from "@/lib/settings-link";
import {
  USER_ROLE_LABEL,
  USER_ROLES,
  type UserRole,
} from "@/lib/types";
import { cn } from "@/lib/utils";

// /api/system/feishu-cli 的状态形状（跟 feishu-cli-card 同源、这里只取就绪判定要的字段）
interface FeishuCliStatus {
  larkCli: { installed: boolean; loggedIn?: boolean };
  meegle: { installed: boolean; loggedIn?: boolean };
}

export interface SetupGate {
  /** 首次判定中（配置 + CLI 状态都没拉到前、别闪清单也别闪看板） */
  loading: boolean;
  /** 四项全就绪 */
  ready: boolean;
  apiKeyReady: boolean;
  feishuReady: boolean;
  reposReady: boolean;
  roleReady: boolean;
  /** 当前已选角色（清单 chip 选中态、与就绪度同一 settings 实例） */
  userRole: UserRole | undefined;
  /** 点选角色即存——写的是本 hook 持有的实例、gate 就地重算、无需切页 */
  pickRole: (role: UserRole) => void;
}

/**
 * 就绪度判定 hook（HomePage 用它决定渲染看板还是清单）。
 * 未就绪时 3s 轮询 CLI 状态（安装 / 登录都是后台流程、配完回来打勾要实时）；就绪即停。
 *
 * ⚠️ useSettings 是「每实例独立快照」hook——角色点选必须走本 hook 下发的 pickRole
 * 写同一实例、gate 才会响应式重算；SetupChecklist 里再开一个 useSettings 实例
 * 写入不会同步过来（踩过：点了 chip 清单不刷新、要切页才生效）。
 */
export const useSetupGate = (): SetupGate => {
  const { settings, loaded, saveFieldValue } = useSettings();
  // CLI 状态快照（null = 还没拉到）
  const [cli, setCli] = useState<FeishuCliStatus | null>(null);
  // CLI 状态至少拉到过一次（接口失败也算、避免接口挂了首页永远 loading）
  const [cliLoaded, setCliLoaded] = useState(false);

  const apiKeyReady = loaded && !!settings.apiKey?.trim();
  const reposReady = loaded && settings.repos.length > 0;
  const roleReady = loaded && !!settings.userRole;
  const feishuReady =
    !!cli &&
    cli.larkCli.installed &&
    !!cli.larkCli.loggedIn &&
    cli.meegle.installed &&
    !!cli.meegle.loggedIn;

  useEffect(() => {
    let stop = false;
    const pull = async () => {
      try {
        const res = await fetch("/api/system/feishu-cli", { cache: "no-store" });
        if (res.ok && !stop) setCli((await res.json()) as FeishuCliStatus);
      } catch {
        /* 下轮再试 */
      } finally {
        if (!stop) setCliLoaded(true);
      }
    };
    void pull();
    if (feishuReady) return; // 已就绪：不再轮询
    const timer = window.setInterval(() => void pull(), 3000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [feishuReady]);

  return {
    loading: !loaded || !cliLoaded,
    ready: apiKeyReady && feishuReady && reposReady && roleReady,
    apiKeyReady,
    feishuReady,
    reposReady,
    roleReady,
    userRole: settings.userRole,
    pickRole: (role) => saveFieldValue("userRole", role),
  };
};

// 单个步骤行：勾/序号圈 + 标题 + 短说明 + 「去配置」
const StepRow = ({
  done,
  index,
  title,
  hint,
  focus,
}: {
  done: boolean;
  index: number;
  title: string;
  hint: string;
  focus: string;
}) => (
  <div className="flex items-center gap-3 px-4 py-3.5">
    {done ? (
      <CheckCircle2 className="size-5 shrink-0 text-green-500" />
    ) : (
      <span className="relative flex size-5 shrink-0 items-center justify-center">
        <Circle className="size-5 text-muted-foreground/40" />
        <span className="absolute text-[10px] font-medium text-muted-foreground">
          {index}
        </span>
      </span>
    )}
    <div className="min-w-0 flex-1">
      <div className={cn("text-sm font-medium", done && "text-muted-foreground")}>
        {title}
      </div>
      <div className="text-xs text-muted-foreground/80">{hint}</div>
    </div>
    {!done && (
      <Link
        href={settingsUrl(focus)}
        className={cn(
          buttonVariants({ variant: "outline", size: "sm" }),
          "no-underline",
        )}
      >
        去配置
        <ArrowRight className="size-3.5" />
      </Link>
    )}
  </div>
);

/** 「我的角色」步骤：行内四个 chip 直接点选落盘、无需跳设置页 */
const RoleStepRow = ({
  done,
  index,
  userRole,
  onPick,
}: {
  done: boolean;
  index: number;
  userRole: UserRole | undefined;
  onPick: (role: UserRole) => void;
}) => (
  <div className="flex items-start gap-3 px-4 py-3.5">
    {done ? (
      <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-green-500" />
    ) : (
      <span className="relative mt-0.5 flex size-5 shrink-0 items-center justify-center">
        <Circle className="size-5 text-muted-foreground/40" />
        <span className="absolute text-[10px] font-medium text-muted-foreground">
          {index}
        </span>
      </span>
    )}
    <div className="min-w-0 flex-1 space-y-2">
      <div>
        <div className={cn("text-sm font-medium", done && "text-muted-foreground")}>
          选择你的角色
        </div>
        <div className="text-xs text-muted-foreground/80">
          不同角色会解锁对应的辅助能力
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {USER_ROLES.map((id) => (
          <ChoiceButton
            key={id}
            shape="chip"
            selected={userRole === id}
            onClick={() => onPick(id)}
          >
            {USER_ROLE_LABEL[id]}
          </ChoiceButton>
        ))}
      </div>
    </div>
  </div>
);

export const SetupChecklist = ({ gate }: { gate: SetupGate }) => {
  return (
    <div className="mx-auto w-full max-w-xl px-6 py-14">
      <h1 className="text-xl font-semibold tracking-tight">开始使用</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        配好这四样、这里就是你的飞书排期看板
      </p>

      <Card className="mt-6 py-0">
        <CardContent className="divide-y p-0">
          <StepRow
            done={gate.apiKeyReady}
            index={1}
            title="Cursor API Key"
            hint="AI 跑任务的凭据"
            focus="api-key"
          />
          <StepRow
            done={gate.feishuReady}
            index={2}
            title="飞书工具"
            hint="安装并登录、需求直接变任务"
            focus="feishu"
          />
          <StepRow
            done={gate.reposReady}
            index={3}
            title="代码仓库"
            hint="至少添加一个"
            focus="repos"
          />
          <RoleStepRow
            done={gate.roleReady}
            index={4}
            userRole={gate.userRole}
            onPick={gate.pickRole}
          />
        </CardContent>
      </Card>
    </div>
  );
};
