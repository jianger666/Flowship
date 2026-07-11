"use client";

/**
 * 设置页（壳子）
 *
 * v1.0.x 瘦身（用户拍板）：
 * - 能力类配置（MCP / Skill / Action）迁去 /actions 能力页 tab 管理、这里只留「设置」——
 *   凭据连接 / 模型 / 仓库 / 偏好 / 存储
 * - 左侧锚点导航（长滚动保留、点导航定位到对应卡片 + 滚动跟随高亮）——原来一屏十张卡要一直滚
 * - 旧深链兼容：?focus=mcp / skills 重定向到 /actions?tab=
 *
 * 拆分约定：
 * - 状态管理 → src/hooks/use-settings.ts、use-models.ts
 * - 各配置块 → src/components/settings/*-card.tsx
 * - 这个文件只组合：拿 hook 出来的值、传给 Card
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ChoiceButton } from "@/components/ui/choice-button";
import { LoadingState } from "@/components/ui/loading-state";

import { useSettings } from "@/hooks/use-settings";
import { useModels } from "@/hooks/use-models";
import { useApiKeyInfo } from "@/hooks/use-api-key-info";
import { getSettings } from "@/lib/local-store";
import { cn } from "@/lib/utils";

import { ApiKeyCard } from "@/components/settings/api-key-card";
import { ModelCard } from "@/components/settings/model-card";
import { RepoCard } from "@/components/settings/repo-card";
import { StorageCard } from "@/components/settings/storage-card";
import { UserProfileCard } from "@/components/settings/user-profile-card";
import { GitCard } from "@/components/settings/git-card";
import { PreferenceCard } from "@/components/settings/preference-card";
import { CheckUpdateButton } from "@/components/settings/check-update-button";
import { DiagnosticsButton } from "@/components/settings/diagnostics-button";
import { FeishuCliCard } from "@/components/settings/feishu-cli-card";

// 左侧锚点导航项（顺序 = 页面卡片顺序；id 后缀同 ?focus= 取值、旧链接全兼容）
const NAV_ITEMS: Array<{ focus: string; label: string }> = [
  { focus: "api-key", label: "Cursor API Key" },
  { focus: "feishu", label: "飞书集成" },
  { focus: "profile", label: "个人信息" },
  { focus: "preference", label: "交互偏好" },
  { focus: "git", label: "GitLab" },
  { focus: "model", label: "默认模型" },
  { focus: "repos", label: "仓库" },
  { focus: "storage", label: "存储" },
];

// 能力类 focus（已迁去 /actions 能力页）→ 对应 tab 的重定向表
const CAPABILITY_FOCUS: Record<string, string> = {
  mcp: "mcp",
  skills: "skills",
};

const SettingsPage = () => {
  const router = useRouter();
  const { settings, loaded, update, saveFieldValue } = useSettings();
  const { models, loading: modelsLoading, error: modelsError, fetchModels } = useModels();
  // API Key 归属信息（Cursor.me）——验证时顺便拉、展示在 ApiKeyCard
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
  // ?focus= 锚点定位 + 短暂高亮；能力类 focus（mcp/skills）重定向去能力页
  const [highlightId, setHighlightId] = useState<string | null>(null);

  // 点导航：滚到对应卡片 + 短暂高亮 ring
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
    const focus = new URLSearchParams(window.location.search).get("focus");
    if (!focus) return;
    // 旧深链兼容：MCP / Skills 已迁能力页
    if (CAPABILITY_FOCUS[focus]) {
      router.replace(`/actions?tab=${CAPABILITY_FOCUS[focus]}`);
      return;
    }
    requestAnimationFrame(() => scrollToFocus(focus));
  }, [loaded, router, scrollToFocus]);

  // 滚动跟随高亮：观察每张卡片、视口上半区内最靠前的算当前节
  useEffect(() => {
    if (!loaded) return;
    const observer = new IntersectionObserver(
      (entries) => {
        // 取「进入视口上缘区域」里最靠上的卡片
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

  // 卡片外层包稳定 id + 锚点高亮 ring；scroll-mt 给 sticky 顶栏留出定位余量
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
        {/* 选中态封装在 ChoiceButton 里（用户拍板「规范封装进组件、AI 用了就是规范」）、
            不再手拼 className */}
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
        {/* 能力入口指路（MCP / Skill / Action 已迁能力页；文案短、用户点名「太长」） */}
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

        {wrapCard(
          "api-key",
          <ApiKeyCard
            apiKey={settings.apiKey}
            info={apiKeyInfo}
            onChange={(v) => update("apiKey", v)}
            onCommit={handleApiKeyCommit}
            onValidate={validateApiKey}
            validating={modelsLoading || infoLoading}
          />,
        )}

        {/* 飞书集成紧跟 API Key（用户拍板：两个都是「接外部服务」的一等配置、放一起） */}
        {wrapCard("feishu", <FeishuCliCard />)}

        {wrapCard(
          "profile",
          <UserProfileCard
            branchTemplate={settings.branchTemplate ?? ""}
            jumpIde={settings.jumpIde ?? "cursor"}
            onJumpIdeChange={(v) => saveFieldValue("jumpIde", v)}
            onBranchTemplateChange={(v) => update("branchTemplate", v)}
            onBranchTemplateCommit={(v) => saveFieldValue("branchTemplate", v)}
          />,
        )}

        {wrapCard(
          "preference",
          <PreferenceCard
            submitShortcut={settings.submitShortcut ?? "mod-enter"}
            reuseAgentDefault={settings.reuseAgentDefault ?? false}
            onSubmitShortcutChange={(v) => saveFieldValue("submitShortcut", v)}
            onReuseAgentDefaultChange={(v) => saveFieldValue("reuseAgentDefault", v)}
          />,
        )}

        {wrapCard(
          "git",
          <GitCard
            gitHost={settings.gitHost ?? ""}
            gitToken={settings.gitToken ?? ""}
            repos={settings.repos}
            onHostChange={(v) => update("gitHost", v)}
            onTokenChange={(v) => update("gitToken", v)}
            onHostCommit={(v) => saveFieldValue("gitHost", v)}
            onTokenCommit={(v) => saveFieldValue("gitToken", v)}
          />,
        )}

        {wrapCard(
          "model",
          <ModelCard
            models={models}
            modelsError={modelsError}
            selection={settings.defaultModel}
            onChange={(next) => saveFieldValue("defaultModel", next)}
            apiKey={settings.apiKey}
            refreshing={modelsLoading}
            onRefresh={fetchModels}
          />,
        )}

        {wrapCard(
          "repos",
          <RepoCard
            repos={settings.repos}
            onChange={(next) => update("repos", next)}
            onCommit={(next) => saveFieldValue("repos", next)}
          />,
        )}

        {wrapCard("storage", <StorageCard />)}
      </div>
    </div>
  );
};

export default SettingsPage;
