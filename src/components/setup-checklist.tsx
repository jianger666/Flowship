"use client";

/**
 * 首页「开始使用」就绪清单（v1.0.x、用户拍板「保证新用户进来就去配置安装飞书工具」）
 *
 * 五项就绪度：① Cursor API Key ② 飞书工具 ③ GitLab Token ④ 至少一个仓库 ⑤ 我的角色。
 * 任一未完成 → 首页看板位置显示本清单；全部就绪 → 自动消失、首页变正常飞书排期看板。
 * 已配好的老用户永远看不到这张卡（stickyReady：曾经就绪过就不再闪清单）。
 *
 * 形态（用户拍板「全引导」）：每行 = 状态勾 + 一句话 + 「去设置」——清单不内嵌任何
 * 输入 / 点选控件、编辑入口统一在设置页；完成状态靠 gate 响应式判定 + CLI 轮询实时刷新。
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, CheckCircle2, Circle } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { useSettings } from "@/hooks/use-settings";
import { settingsUrl } from "@/lib/settings-link";
import { cn } from "@/lib/utils";

/** 曾经全部就绪过就记一笔——回工作台不再因飞书 CLI 瞬态失败闪清单 */
const SETUP_READY_SEEN_KEY = "fe-ai-flow:setup-ready-seen";

// /api/system/feishu-cli 的状态形状（跟 feishu-cli-card 同源、这里只取就绪判定要的字段）
interface FeishuCliStatus {
  larkCli: { installed: boolean; loggedIn?: boolean };
  meegle: { installed: boolean; loggedIn?: boolean };
}

export interface SetupGate {
  /** 首次判定中（配置 + CLI 状态都没拉到前、别闪清单也别闪看板） */
  loading: boolean;
  /** 五项全就绪（含 sticky：曾经就绪过也算） */
  ready: boolean;
  apiKeyReady: boolean;
  feishuReady: boolean;
  gitReady: boolean;
  reposReady: boolean;
  roleReady: boolean;
}

/**
 * 就绪度判定 hook（HomePage 用它决定渲染看板还是清单）。
 * 未就绪时 3s 轮询 CLI 状态（安装 / 登录都是后台流程、配完回来打勾要实时）；就绪即停。
 * stickyReady 为 true 时跳过 CLI 轮询（老用户不必再探、飞书真掉登录靠看板降级引导）。
 * settings 项（API Key / GitLab Token / 仓库 / 角色）走 useSettings 响应式判定、设置页改完回来 remount 天然拿最新。
 */
export const useSetupGate = (): SetupGate => {
  const { settings, loaded } = useSettings();
  // 曾经全部就绪过（localStorage）——避免飞书 CLI 瞬态失败把老用户打回清单
  const [stickyReady] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(SETUP_READY_SEEN_KEY) === "1";
  });
  // CLI 状态快照（null = 还没拉到）
  const [cli, setCli] = useState<FeishuCliStatus | null>(null);
  // CLI 状态至少拉到过一次（接口失败也算、避免接口挂了首页永远 loading）
  const [cliLoaded, setCliLoaded] = useState(false);

  const apiKeyReady = loaded && !!settings.apiKey?.trim();
  const gitReady = loaded && !!settings.gitToken?.trim();
  const reposReady = loaded && settings.repos.length > 0;
  const roleReady = loaded && !!settings.userRole;
  const feishuReady =
    !!cli &&
    cli.larkCli.installed &&
    !!cli.larkCli.loggedIn &&
    cli.meegle.installed &&
    !!cli.meegle.loggedIn;

  // 实时五项判定（不含 sticky）
  const liveReady =
    apiKeyReady && feishuReady && gitReady && reposReady && roleReady;

  // 首次 liveReady → 落 sticky、老用户回工作台不再闪清单
  useEffect(() => {
    if (!liveReady) return;
    try {
      window.localStorage.setItem(SETUP_READY_SEEN_KEY, "1");
    } catch {
      /* quota / 隐私模式写不进不影响本轮 */
    }
  }, [liveReady]);

  // sticky 已就绪：跳过 CLI 轮询（看板自己有飞书降级态）；否则 3s 轮询到飞书打勾
  useEffect(() => {
    if (stickyReady) return;
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
  }, [stickyReady, feishuReady]);

  return {
    // sticky 时只等 settings；否则还要等 CLI 至少拉过一次
    loading: stickyReady ? !loaded : !loaded || !cliLoaded,
    ready: liveReady || stickyReady,
    apiKeyReady,
    feishuReady,
    gitReady,
    reposReady,
    roleReady,
  };
};

// 单个步骤行：勾/序号圈 + 标题 + 短说明 + 「去设置」
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
        去设置
        <ArrowRight className="size-3.5" />
      </Link>
    )}
  </div>
);

export const SetupChecklist = ({ gate }: { gate: SetupGate }) => {
  return (
    <div className="mx-auto w-full max-w-xl px-6 py-14">
      <h1 className="text-xl font-semibold tracking-tight">开始使用</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        配好这几样、这里就是你的飞书排期看板
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
            done={gate.gitReady}
            index={3}
            title="GitLab Token"
            hint="提 MR 用的凭据"
            focus="git"
          />
          <StepRow
            done={gate.reposReady}
            index={4}
            title="代码仓库"
            hint="至少添加一个"
            focus="repos"
          />
          <StepRow
            done={gate.roleReady}
            index={5}
            title="我的角色"
            hint="不同角色会解锁对应的辅助能力"
            focus="prefs"
          />
        </CardContent>
      </Card>
    </div>
  );
};
