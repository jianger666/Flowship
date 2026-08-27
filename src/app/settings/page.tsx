"use client";

/**
 * 设置页（壳子）
 *
 * 组卡按用户心智（2026-08-18：模型提供方从「连接」拆成独立一栏）：
 *   模型（Cursor SDK / 自定义两块目录，默认提供方在目录下面）/ 连接（GitLab Token + 飞书集成 + 环境配置）/
 *   团队（wk 流程：WK 产出目录 + Delivery Hub）/
 *   偏好（跳转 IDE + 分支模板 + 提交快捷键 + 续用 Agent）/ 仓库 / 存储。
 * 各配置块以「节」组件（*-card.tsx 里的 XxxSection）拼进组卡、左侧锚点导航六项。
 *
 * - 能力类配置（MCP / Skill / Action）在 /actions 能力页 tab 管理
 * - 旧深链兼容：?focus=api-key → 模型、feishu|git|env → 连接、profile|preference → 偏好、
 *   mcp / skills → 重定向 /actions?tab=；?focus=model 本身就是模型栏、不再映射
 *
 * 拆分约定：状态管理 → hooks；配置节 → components/settings/*-card.tsx；本文件只组合。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ChoiceButton } from "@/components/ui/choice-button";
import { LoadingState } from "@/components/ui/loading-state";
import { Separator } from "@/components/ui/separator";

import { useSettings } from "@/hooks/use-settings";
import { useModels } from "@/hooks/use-models";
import { useApiKeyInfo } from "@/hooks/use-api-key-info";
import {
  CURSOR_PROVIDER_ID,
  DEFAULT_MEEGLE_PROJECT,
  defaultModelForProvider,
  isCursorProvider,
  type AgentProviderId,
  type CustomProviderConfig,
} from "@/lib/types";
import { cn } from "@/lib/utils";

import { ApiKeySection, DefaultModelSection } from "@/components/settings/api-key-card";
import {
  CustomProviderList,
  DefaultProviderSection,
} from "@/components/settings/custom-provider-card";
import { RepoCard } from "@/components/settings/repo-card";
import { StorageCard } from "@/components/settings/storage-card";
import { GitLabSection } from "@/components/settings/git-card";
import { PreferenceSections } from "@/components/settings/preference-card";
import { CompanyEnvSection } from "@/components/settings/company-env-card";
import { CheckUpdateButton } from "@/components/settings/check-update-button";
import { DiagnosticsButton } from "@/components/settings/diagnostics-button";
import { FeishuCliSection } from "@/components/settings/feishu-cli-card";
import { WkHarnessSection } from "@/components/settings/wk-harness-card";
import { useWhatsNew } from "@/components/whats-new-host";
import { emptyCompanyEnv } from "@/lib/company-env";
import { hasWhatsNewFor } from "@/lib/whats-new";

// 左侧锚点导航（六组）：id 同 ?focus= 新取值
const NAV_ITEMS: Array<{ focus: string; label: string }> = [
  { focus: "model", label: "模型" },
  { focus: "connect", label: "连接" },
  { focus: "team", label: "团队" },
  { focus: "prefs", label: "偏好" },
  { focus: "repos", label: "仓库" },
  { focus: "storage", label: "存储" },
];

// 旧 focus 值 → 新分组（全站 settingsUrl("api-key") 等旧跳转不断链）
const LEGACY_FOCUS: Record<string, string> = {
  // 凭据曾挂在连接卡；现在模型栏自己就是 id=model、不用再映射
  "api-key": "model",
  feishu: "connect",
  git: "connect",
  // 曾短暂独立「环境」分组 → 并回连接
  env: "connect",
  profile: "prefs",
  preference: "prefs",
};

// 能力类 focus（已迁去 /actions 能力页）→ 对应 tab 的重定向表
const CAPABILITY_FOCUS: Record<string, string> = {
  mcp: "mcp",
  skills: "skills",
};

const SettingsPage = () => {
  const router = useRouter();
  const { openCurrent: openWhatsNew } = useWhatsNew();
  const { settings, loaded, update, saveFieldValue } = useSettings();
  const { models, loading: modelsLoading, error: modelsError, fetchModels } = useModels();
  // API Key 归属信息（Cursor.me）——拉模型时顺便拉、展示在 Key 下面
  const { info: apiKeyInfo, fetchInfo } = useApiKeyInfo();

  // 新建对话用的默认提供方；Cursor 凭据始终可见，自定义条目在下面目录里
  const provider: AgentProviderId = settings.provider ?? CURSOR_PROVIDER_ID;
  const customProviders: CustomProviderConfig[] = useMemo(
    () => settings.customProviders ?? [],
    [settings.customProviders],
  );

  // 拉 Cursor 模型列表（进页 / 改 Key）。自定义条目各自在行内拉。
  const pullCursorModels = useCallback(
    (apiKey: string, options?: { manual?: boolean }) => {
      if (!apiKey.trim()) {
        void fetchModels({ provider: CURSOR_PROVIDER_ID, apiKey: "" }, options);
        return;
      }
      void fetchModels({ provider: CURSOR_PROVIDER_ID, apiKey }, options);
      void fetchInfo(apiKey, options);
    },
    [fetchModels, fetchInfo],
  );

  const handleApiKeyCommit = (value: string) => {
    saveFieldValue("apiKey", value);
    pullCursorModels(value);
  };

  const handleCustomProvidersCommit = (next: CustomProviderConfig[]) => {
    saveFieldValue("customProviders", next);
  };

  const handleProviderChange = (next: AgentProviderId) => {
    saveFieldValue("provider", next);
    if (isCursorProvider(next)) pullCursorModels(settings.apiKey);
  };

  // 仓库提交：只落盘 repos（host 不进 settings、推进 / ship 时按任务仓库 remote 现推）
  const handleReposCommit = (next: typeof settings.repos) => {
    saveFieldValue("repos", next);
  };

  // 桌面端壳注入的版本号（web 版没有、不显示）；useEffect 读防 hydration mismatch
  const [appVersion, setAppVersion] = useState<string | null>(null);
  useEffect(() => {
    setAppVersion(window.__appVersion ?? null);
  }, []);

  // 进设置页若当前 provider 已配好凭据就自动拉一次——读 SWR 缓存秒出模型。
  // 用 ref 保证只跑一次。
  const didInitValidate = useRef(false);
  useEffect(() => {
    if (!loaded || didInitValidate.current) return;
    didInitValidate.current = true;
    pullCursorModels(settings.apiKey);
  }, [loaded, pullCursorModels, settings.apiKey]);

  // 当前导航高亮项（点导航 / 滚动跟随都更新）
  const [activeFocus, setActiveFocus] = useState<string>(NAV_ITEMS[0].focus);
  // ?focus= 锚点定位 + 短暂高亮
  const [highlightId, setHighlightId] = useState<string | null>(null);

  // 点导航：滚到对应组卡 + 短暂高亮 ring
  const scrollToFocus = useCallback((focus: string) => {
    const id = `card-${focus}`;
    const el = document.getElementById(id);
    if (!el) return;
    setActiveFocus(focus);
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    setHighlightId(id);
    window.setTimeout(() => setHighlightId(null), 1600);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const raw = new URLSearchParams(window.location.search).get("focus");
    if (!raw) return;
    // 能力类 focus 重定向去能力页
    if (CAPABILITY_FOCUS[raw]) {
      router.replace(`/actions?tab=${CAPABILITY_FOCUS[raw]}`);
      return;
    }
    const focus = LEGACY_FOCUS[raw] ?? raw;
    requestAnimationFrame(() => scrollToFocus(focus));
  }, [loaded, router, scrollToFocus]);

  // 滚动跟随高亮：观察每张组卡、视口上半区内最靠前的算当前节
  useEffect(() => {
    if (!loaded) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const first = visible[0]?.target?.id;
        if (first?.startsWith("card-")) setActiveFocus(first.slice(5));
      },
      // 上缘 20% ~ 下缘 60% 之间算「当前在看」——偏向靠上的卡片
      { rootMargin: "-20% 0px -60% 0px" },
    );
    for (const item of NAV_ITEMS) {
      const el = document.getElementById(`card-${item.focus}`);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [loaded]);

  // 组卡外层包稳定 id + 锚点高亮 ring；scroll-mt 要 ≥ sticky 返回顶栏高度（~7rem）、
  // 否则锚点定位后卡片标题被浮顶盖住
  const wrapCard = (focus: string, node: ReactNode) => (
    <div
      id={`card-${focus}`}
      className={cn(
        "scroll-mt-28 rounded-xl transition-shadow duration-300",
        highlightId === `card-${focus}` && "ring-2 ring-primary/60",
      )}
    >
      {node}
    </div>
  );

  if (!loaded) {
    return <LoadingState variant="hero" />;
  }

  // 返回 = 回来路（任务详情 / 首页都可能）、无历史（直开 /settings）兜底回首页
  const handleBack = () => {
    if (window.history.length > 1) router.back();
    else router.push("/");
  };

  return (
    <div className="mx-auto flex max-w-5xl gap-8 px-6 py-8">
      {/* 左侧锚点导航：sticky 跟随、点击定位、滚动高亮当前节。
          top-8 必须 = 容器 py-8：sticky 吸附位和自然位重合、开始滚动那一刻不跳 8px
          （用户实测「出现顶栏分隔线时导航动一下」的根因） */}
      <nav className="sticky top-8 hidden h-fit w-40 shrink-0 flex-col gap-0.5 self-start md:flex">
        <div className="mb-2 px-2 text-xs font-medium text-muted-foreground">设置</div>
        {NAV_ITEMS.map((item) => (
          <ChoiceButton
            key={item.focus}
            shape="tab"
            selected={activeFocus === item.focus}
            onClick={() => scrollToFocus(item.focus)}
            className="w-full cursor-pointer"
          >
            {item.label}
          </ChoiceButton>
        ))}
        {/* 能力入口指路（MCP / Skill / Action 已迁能力页） */}
        <div className="mt-3 border-t pt-2">
          <button
            type="button"
            onClick={() => router.push("/actions")}
            className="w-full cursor-pointer rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            能力 →
          </button>
        </div>
      </nav>

      {/* 右侧内容列（保持长滚动） */}
      <div className="min-w-0 max-w-3xl flex-1 space-y-6">
        {/* 顶部返回链接 + 页标题——sticky 浮顶：长页滚到底也能一眼找到回去的路
            （2026-07-15 用户反馈「滚到下边不知道怎么回去」）。
            -mt-8/pt-8 抵消容器 py-8：吸附时盖住上方 32px 滚动区、自然位置不变不跳动 */}
        <div className="sticky top-0 z-20 -mx-2 -mt-8 bg-background/95 px-2 pb-3 pt-8 backdrop-blur">
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 mb-2 px-2"
            onClick={handleBack}
          >
            <ArrowLeft />
            返回
          </Button>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold">设置</h1>
            {appVersion && (
              <Tooltip content="桌面端版本号">
                <span className="text-xs text-muted-foreground">
                  v{appVersion}
                </span>
              </Tooltip>
            )}
            {appVersion && hasWhatsNewFor(appVersion) ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-muted-foreground"
                onClick={openWhatsNew}
              >
                本版更新
              </Button>
            ) : null}
            <DiagnosticsButton />
            <CheckUpdateButton />
          </div>
        </div>

        {/* ---- 模型：提供方 + 凭据 + 默认模型 ---- */}
        {wrapCard(
          "model",
          <Card>
            <CardHeader>
              <CardTitle>模型</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-3">
                <div className="text-sm">Cursor SDK</div>
                <div className="space-y-4 rounded-md border border-border/60 p-4">
                  <ApiKeySection
                    apiKey={settings.apiKey}
                    info={apiKeyInfo}
                    onChange={(v) => update("apiKey", v)}
                    onCommit={handleApiKeyCommit}
                    className="py-0 first:pt-0 last:pb-0"
                  />
                  <div className="space-y-2 border-t border-border/60 pt-4">
                    <DefaultModelSection
                      models={models}
                      modelSelection={defaultModelForProvider(
                        settings,
                        CURSOR_PROVIDER_ID,
                      )}
                      onModelChange={(next) => {
                        saveFieldValue("defaultModel", next);
                      }}
                      canRefreshModels={!!settings.apiKey?.trim()}
                      onModelsRefresh={() =>
                        pullCursorModels(settings.apiKey, { manual: true })
                      }
                      modelsRefreshing={modelsLoading}
                      modelsError={modelsError}
                      providerId={CURSOR_PROVIDER_ID}
                      className="py-0 first:pt-0 last:pb-0"
                    />
                  </div>
                </div>
              </div>
              <CustomProviderList
                items={customProviders}
                onChange={(next) => update("customProviders", next)}
                onCommit={handleCustomProvidersCommit}
                defaultProvider={provider}
                onDefaultProviderChange={handleProviderChange}
              />
              <DefaultProviderSection
                value={provider}
                settings={settings}
                onChange={handleProviderChange}
                className="py-0 first:pt-0 last:pb-0"
              />
            </CardContent>
          </Card>,
        )}

        {/* ---- 连接：GitLab / 飞书 / 公司环境（模型凭据已拆走）---- */}
        {wrapCard(
          "connect",
          <Card>
            <CardHeader>
              <CardTitle>连接</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <GitLabSection
                gitToken={settings.gitToken ?? ""}
                onTokenChange={(v) => update("gitToken", v)}
                onTokenCommit={(v) => saveFieldValue("gitToken", v)}
              />
              <Separator />
              <FeishuCliSection
                meegleProject={settings.meegleProject ?? { ...DEFAULT_MEEGLE_PROJECT }}
                onMeegleProjectChange={(v) => saveFieldValue("meegleProject", v)}
                feishuChatBridge={settings.feishuChatBridge === true}
                onFeishuChatBridgeChange={(v) =>
                  saveFieldValue("feishuChatBridge", v)
                }
              />
              <Separator />
              <CompanyEnvSection
                value={settings.companyEnv ?? emptyCompanyEnv()}
                onChange={(next) => update("companyEnv", next)}
                onCommit={(next) => saveFieldValue("companyEnv", next)}
              />
            </CardContent>
          </Card>,
        )}

        {/* ---- 团队：wk-harness 接入（WK 产出目录 + Delivery Hub，写 ~/.wk/config.yaml、不进 settings） ---- */}
        {wrapCard(
          "team",
          <Card>
            <CardHeader>
              <CardTitle>团队</CardTitle>
            </CardHeader>
            <CardContent>
              <WkHarnessSection />
            </CardContent>
          </Card>,
        )}

        {/* ---- 偏好：统一设置行（每项一行「名称+说明 | 控件」、divide-y 分隔——
             原「三小节各自小标题」层级太多、用户实测「还是有点乱」后定型） ---- */}
        {wrapCard(
          "prefs",
          <Card>
            <CardHeader>
              <CardTitle>偏好</CardTitle>
            </CardHeader>
            <CardContent>
              <PreferenceSections
                jumpIde={settings.jumpIde ?? "cursor"}
                onJumpIdeChange={(v) => saveFieldValue("jumpIde", v)}
                userRole={settings.userRole}
                onUserRoleChange={(v) => saveFieldValue("userRole", v)}
                branchTemplate={settings.branchTemplate ?? ""}
                onBranchTemplateChange={(v) => update("branchTemplate", v)}
                onBranchTemplateCommit={(v) => saveFieldValue("branchTemplate", v)}
                submitShortcut={settings.submitShortcut ?? "mod-enter"}
                reuseAgentDefault={settings.reuseAgentDefault ?? false}
                onSubmitShortcutChange={(v) => saveFieldValue("submitShortcut", v)}
                onReuseAgentDefaultChange={(v) => saveFieldValue("reuseAgentDefault", v)}
                agentShellGitBash={settings.agentShellGitBash ?? false}
                onAgentShellGitBashChange={(v) =>
                  saveFieldValue("agentShellGitBash", v)
                }
                isolateWorktreeDefault={settings.isolateWorktreeDefault ?? true}
                onIsolateWorktreeDefaultChange={(v) =>
                  saveFieldValue("isolateWorktreeDefault", v)
                }
                feishuBridgeKeepAwake={settings.feishuBridgeKeepAwake !== false}
                onFeishuBridgeKeepAwakeChange={(v) =>
                  saveFieldValue("feishuBridgeKeepAwake", v)
                }
                />
            </CardContent>
          </Card>,
        )}

        {/* ---- 仓库 ---- */}
        {wrapCard(
          "repos",
          <RepoCard
            repos={settings.repos}
            onChange={(next) => update("repos", next)}
            onCommit={handleReposCommit}
          />,
        )}

        {/* ---- 存储 ---- */}
        {wrapCard("storage", <StorageCard />)}
      </div>
    </div>
  );
};

export default SettingsPage;
