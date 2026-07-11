"use client";

/**
 * 设置页（壳子）
 *
 * v1.0.x 整合（用户拍板「太零散、一个 tab 下只有一两个设置项」）：8 张卡收成 4 组——
 *   连接（Cursor API Key + GitLab Token + 飞书集成）/ 偏好（跳转 IDE + 分支模板 +
 *   提交快捷键 + 续用 Agent + 默认模型）/ 仓库 / 存储。
 * 各配置块以「节」组件（*-card.tsx 里的 XxxSection）拼进组卡、左侧锚点导航四项。
 *
 * - 能力类配置（MCP / Skill / Action）在 /actions 能力页 tab 管理
 * - 旧深链兼容：?focus=api-key|feishu|git → 连接、profile|preference|model → 偏好、
 *   mcp / skills → 重定向 /actions?tab=
 *
 * 拆分约定：状态管理 → hooks；配置节 → components/settings/*-card.tsx；本文件只组合。
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
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
import { getSettings } from "@/lib/local-store";
import { cn } from "@/lib/utils";

import { ApiKeySection } from "@/components/settings/api-key-card";
import { ModelSection } from "@/components/settings/model-card";
import { RepoCard } from "@/components/settings/repo-card";
import { StorageCard } from "@/components/settings/storage-card";
import { ProfileSection } from "@/components/settings/user-profile-card";
import { GitLabSection } from "@/components/settings/git-card";
import { InteractionSection } from "@/components/settings/preference-card";
import { CheckUpdateButton } from "@/components/settings/check-update-button";
import { DiagnosticsButton } from "@/components/settings/diagnostics-button";
import { FeishuCliSection } from "@/components/settings/feishu-cli-card";

// 左侧锚点导航（v1.0.x 四组）：id 同 ?focus= 新取值
const NAV_ITEMS: Array<{ focus: string; label: string }> = [
  { focus: "connect", label: "连接" },
  { focus: "prefs", label: "偏好" },
  { focus: "repos", label: "仓库" },
  { focus: "storage", label: "存储" },
];

// 旧 focus 值 → 新分组（全站 settingsUrl("api-key") 等旧跳转不断链）
const LEGACY_FOCUS: Record<string, string> = {
  "api-key": "connect",
  feishu: "connect",
  git: "connect",
  profile: "prefs",
  preference: "prefs",
  model: "prefs",
};

// 能力类 focus（已迁去 /actions 能力页）→ 对应 tab 的重定向表
const CAPABILITY_FOCUS: Record<string, string> = {
  mcp: "mcp",
  skills: "skills",
};

const SettingsPage = () => {
  const router = useRouter();
  const { settings, loaded, update, saveFieldValue } = useSettings();
  const { models, loading: modelsLoading, error: modelsError, fetchModels } = useModels();
  // API Key 归属信息（Cursor.me）——验证时顺便拉、展示在连接卡
  const { info: apiKeyInfo, loading: infoLoading, fetchInfo } = useApiKeyInfo();

  // 一次「验证」同时拉模型列表 + 账号信息（两者都吃 SWR 缓存、重复调很便宜）
  const validateApiKey = useCallback(
    (key: string) => {
      const trimmed = key.trim();
      if (!trimmed) return;
      void fetchModels(trimmed);
      void fetchInfo(trimmed);
    },
    [fetchModels, fetchInfo],
  );

  // apiKey 失焦落盘：顺带自动验证（省得用户手动点「验证」才出模型 / 账号信息）
  const handleApiKeyCommit = (value: string) => {
    saveFieldValue("apiKey", value);
    validateApiKey(value);
  };

  // GitLab host 自动烘焙（用户拍板「选仓库时就推导、别等推进」）：
  // 仓库变更时从仓库 origin 推导、静默写进 settings.gitHost（无 UI 字段）——
  // 推进弹窗 / 服务端直接用现成值、运行时零推导零闪烁。推不出（没配 origin）保持原值、
  // 服务端起 agent 时仍有兜底推导。
  // 代次守卫（发版前蓝军 P1）：连续快速改仓库列表时多个 fetch 乱序返回、旧响应可能
  // 覆盖新 host——只认最后一次发起的请求。
  const bakeGenRef = useRef(0);
  const bakeGitHost = useCallback((repoPaths: string[]) => {
    if (repoPaths.length === 0) return;
    const gen = ++bakeGenRef.current;
    const q = encodeURIComponent(repoPaths.join(","));
    void fetch(`/api/repo-remote-meta?paths=${q}`)
      .then((r) => r.json())
      .then((d: { host?: string | null }) => {
        if (gen !== bakeGenRef.current) return; // 已有更新一次烘焙、本次作废
        const derived = d.host?.trim();
        if (derived && derived !== (getSettings().gitHost ?? "").trim()) {
          saveFieldValue("gitHost", derived);
        }
      })
      .catch(() => {
        /* 推不出不动原值 */
      });
    // saveFieldValue 引用稳定（hook 内定义）、不进 deps 防重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 仓库提交：落盘 + 重新烘焙 host（换仓库 / 加仓库后 host 跟着换）。
  // 不做「首次加载补烘焙」的老用户兼容——老用户当年都手填过 host、值本来就在（用户拍板）
  const handleReposCommit = (next: typeof settings.repos) => {
    saveFieldValue("repos", next);
    bakeGitHost(next.map((r) => r.path));
  };

  // 桌面端壳注入的版本号（web 版没有、不显示）；useEffect 读防 hydration mismatch
  const [appVersion, setAppVersion] = useState<string | null>(null);
  useEffect(() => {
    setAppVersion(window.__appVersion ?? null);
  }, []);

  // 进设置页（配置加载完成）若已有 apiKey 就自动验证一次——读 SWR 缓存秒出模型 + 账号信息、
  // 不用用户手动点「验证」。用 ref 保证只跑一次（读 getSettings 的落盘值、不依赖输入草稿、
  // 避免把 apiKey 放进 deps 导致每次敲键都重拉）
  const didInitValidate = useRef(false);
  useEffect(() => {
    if (!loaded || didInitValidate.current) return;
    didInitValidate.current = true;
    const key = getSettings().apiKey?.trim();
    if (key) validateApiKey(key);
  }, [loaded, validateApiKey]);

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

  // 组卡外层包稳定 id + 锚点高亮 ring；scroll-mt 给 sticky 顶栏留出定位余量
  const wrapCard = (focus: string, node: ReactNode) => (
    <div
      id={`card-${focus}`}
      className={cn(
        "scroll-mt-6 rounded-xl transition-shadow duration-300",
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
      {/* 左侧锚点导航：sticky 跟随、点击定位、滚动高亮当前节 */}
      <nav className="sticky top-6 hidden h-fit w-40 shrink-0 flex-col gap-0.5 self-start md:flex">
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
        {/* 顶部返回链接 + 页标题 */}
        <div>
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
              <span className="text-xs text-muted-foreground" title="桌面端版本号">
                v{appVersion}
              </span>
            )}
            <DiagnosticsButton />
            <CheckUpdateButton />
          </div>
        </div>

        {/* ---- 连接：外部服务凭据（Cursor / GitLab / 飞书）---- */}
        {wrapCard(
          "connect",
          <Card>
            <CardHeader>
              <CardTitle>连接</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <ApiKeySection
                apiKey={settings.apiKey}
                info={apiKeyInfo}
                onChange={(v) => update("apiKey", v)}
                onCommit={handleApiKeyCommit}
                onValidate={validateApiKey}
                validating={modelsLoading || infoLoading}
              />
              <Separator />
              <GitLabSection
                gitToken={settings.gitToken ?? ""}
                onTokenChange={(v) => update("gitToken", v)}
                onTokenCommit={(v) => saveFieldValue("gitToken", v)}
              />
              <Separator />
              <FeishuCliSection />
            </CardContent>
          </Card>,
        )}

        {/* ---- 偏好：个人工作方式（IDE / 分支模板 / 快捷键 / 续用 / 默认模型）---- */}
        {wrapCard(
          "prefs",
          <Card>
            <CardHeader>
              <CardTitle>偏好</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <ProfileSection
                branchTemplate={settings.branchTemplate ?? ""}
                jumpIde={settings.jumpIde ?? "cursor"}
                onJumpIdeChange={(v) => saveFieldValue("jumpIde", v)}
                onBranchTemplateChange={(v) => update("branchTemplate", v)}
                onBranchTemplateCommit={(v) => saveFieldValue("branchTemplate", v)}
              />
              <Separator />
              <InteractionSection
                submitShortcut={settings.submitShortcut ?? "mod-enter"}
                reuseAgentDefault={settings.reuseAgentDefault ?? false}
                onSubmitShortcutChange={(v) => saveFieldValue("submitShortcut", v)}
                onReuseAgentDefaultChange={(v) => saveFieldValue("reuseAgentDefault", v)}
              />
              <Separator />
              <ModelSection
                models={models}
                modelsError={modelsError}
                selection={settings.defaultModel}
                onChange={(next) => saveFieldValue("defaultModel", next)}
                apiKey={settings.apiKey}
                refreshing={modelsLoading}
                onRefresh={fetchModels}
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
