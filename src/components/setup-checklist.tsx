"use client";

/**
 * 首页「开始使用」就绪清单（v1.0.x、用户拍板「保证新用户进来就去配置安装飞书工具」）
 *
 * 三项就绪度：① Cursor API Key ② 飞书工具（两个 CLI 装好 + 登录）③ 至少一个仓库。
 * 任一未完成 → 首页看板位置显示本清单（每步行内直接可操作、不用跳设置页找按钮）；
 * 全部就绪 → 自动消失、首页变正常飞书排期看板。已配好的老用户永远看不到这张卡。
 *
 * 为什么不做开屏向导（wizard）：向导能跳过、跳过就再也不出现；清单占据首页、
 * 配不完每次打开都在——这才是「保证」。建任务 / 推进的硬闸（缺能力琥珀提示）继续兜底。
 */

import { useEffect, useState } from "react";
import { CheckCircle2, Circle, FolderPlus, KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { FeishuCliCard } from "@/components/settings/feishu-cli-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useSettings } from "@/hooks/use-settings";
import { pickNativePaths } from "@/lib/native-picker";
import { pathBasename } from "@/lib/path-utils";

// /api/system/feishu-cli 的状态形状（跟 feishu-cli-card 同源、这里只取就绪判定要的字段）
interface FeishuCliStatus {
  larkCli: { installed: boolean; loggedIn?: boolean };
  meegle: { installed: boolean; loggedIn?: boolean };
}

export interface SetupGate {
  /** 首次判定中（配置 + CLI 状态都没拉到前、别闪清单也别闪看板） */
  loading: boolean;
  /** 三项全就绪 */
  ready: boolean;
  apiKeyReady: boolean;
  feishuReady: boolean;
  reposReady: boolean;
  // 配置读写透传给清单用——gate 和清单必须共用同一个 useSettings 实例、
  // 各自 useSettings 的话清单里保存后 gate 看不到（实例间无订阅）、打勾不实时
  settings: ReturnType<typeof useSettings>["settings"];
  settingsLoaded: boolean;
  saveFieldValue: ReturnType<typeof useSettings>["saveFieldValue"];
}

/**
 * 就绪度判定 hook（HomePage 用它决定渲染看板还是清单）。
 * 未就绪时 3s 轮询 CLI 状态（安装 / 登录都是后台流程、装完打勾要实时）；就绪即停。
 */
export const useSetupGate = (): SetupGate => {
  const { settings, loaded, saveFieldValue } = useSettings();
  // CLI 状态快照（null = 还没拉到）
  const [cli, setCli] = useState<FeishuCliStatus | null>(null);
  // CLI 状态至少拉到过一次（接口失败也算、避免接口挂了首页永远 loading）
  const [cliLoaded, setCliLoaded] = useState(false);

  const apiKeyReady = loaded && !!settings.apiKey?.trim();
  const reposReady = loaded && settings.repos.length > 0;
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
    ready: apiKeyReady && feishuReady && reposReady,
    apiKeyReady,
    feishuReady,
    reposReady,
    settings,
    settingsLoaded: loaded,
    saveFieldValue,
  };
};

// 步骤头：完成打绿勾、未完成空圈 + 序号
const StepHeader = ({
  done,
  index,
  title,
  hint,
}: {
  done: boolean;
  index: number;
  title: string;
  hint: string;
}) => (
  <div className="flex items-center gap-2.5">
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
    <div className="min-w-0">
      <div className="text-sm font-medium">{title}</div>
      <div className="text-xs text-muted-foreground">{hint}</div>
    </div>
  </div>
);

export const SetupChecklist = ({ gate }: { gate: SetupGate }) => {
  // 配置读写走 gate 透传（跟就绪判定同一个 useSettings 实例、保存立即打勾）
  const { settings, settingsLoaded: loaded, saveFieldValue } = gate;
  // API Key 输入草稿（保存后清空、显示已配置态）
  const [keyDraft, setKeyDraft] = useState("");
  // 原生目录 picker 调用中（防双击）
  const [picking, setPicking] = useState(false);

  const handleSaveKey = () => {
    const v = keyDraft.trim();
    if (!v) return;
    saveFieldValue("apiKey", v);
    setKeyDraft("");
    toast.success("API Key 已保存");
  };

  const handlePickRepos = async () => {
    if (!loaded) return;
    setPicking(true);
    try {
      const paths = await pickNativePaths({
        mode: "folder",
        multiple: true,
        prompt: "选择仓库目录",
      });
      if (!paths || paths.length === 0) return;
      const fresh = paths.filter(
        (p) => p && !settings.repos.some((r) => r.path === p),
      );
      if (fresh.length === 0) {
        toast.error("选的目录已经在列表里");
        return;
      }
      saveFieldValue("repos", [
        ...settings.repos,
        ...fresh.map((p) => ({ name: pathBasename(p), path: p })),
      ]);
      toast.success(`已添加 ${fresh.length} 个仓库`);
    } finally {
      setPicking(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-10">
      <h1 className="text-xl font-semibold tracking-tight">开始使用</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        三步配好、这里就是你的飞书排期看板——点一下需求、AI 直接开工
      </p>

      <div className="mt-6 flex flex-col gap-4">
        {/* ① Cursor API Key */}
        <Card>
          <CardContent className="space-y-3 pt-5">
            <StepHeader
              done={gate.apiKeyReady}
              index={1}
              title="Cursor API Key"
              hint="AI 的命脉、所有任务都靠它跑"
            />
            {gate.apiKeyReady ? (
              <div className="pl-7 text-xs text-muted-foreground">
                已配置（去设置页可修改 / 验证）
              </div>
            ) : (
              <div className="flex items-center gap-2 pl-7">
                <KeyRound className="size-4 shrink-0 text-muted-foreground" />
                <Input
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value)}
                  placeholder="crsr_ 开头、cursor.com/dashboard/integrations 创建"
                  type="password"
                  className="h-8"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSaveKey();
                  }}
                />
                <Button size="sm" className="h-8" disabled={!keyDraft.trim()} onClick={handleSaveKey}>
                  保存
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ② 飞书工具（本项目最重要的能力）：直接内嵌完整安装 / 登录卡、不用跳设置页 */}
        <div className="space-y-2">
          <div className="px-1">
            <StepHeader
              done={gate.feishuReady}
              index={2}
              title="飞书工具"
              hint="接飞书 / 飞书项目——需求看板、文档、状态同步全靠它"
            />
          </div>
          {!gate.feishuReady && <FeishuCliCard />}
        </div>

        {/* ③ 仓库 */}
        <Card>
          <CardContent className="space-y-3 pt-5">
            <StepHeader
              done={gate.reposReady}
              index={3}
              title="添加仓库"
              hint="AI 干活的代码目录、至少加一个"
            />
            <div className="flex items-center gap-2 pl-7">
              {gate.reposReady && (
                <span className="text-xs text-muted-foreground">
                  已添加 {settings.repos.length} 个：
                  {settings.repos.map((r) => r.name).join("、")}
                </span>
              )}
              <Button
                size="sm"
                variant={gate.reposReady ? "outline" : "default"}
                className="h-8"
                disabled={picking || !loaded}
                onClick={() => void handlePickRepos()}
              >
                {picking ? <Loader2 className="animate-spin" /> : <FolderPlus />}
                选择仓库目录
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <p className="mt-6 text-center text-xs text-muted-foreground">
        全部完成后这里自动变成看板；分支 / 模型等细项随时在右上角 ⚙ 设置里调
      </p>
    </div>
  );
};
