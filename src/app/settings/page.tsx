"use client";

/**
 * 设置页（壳子）
 *
 * 配置块（存 data/config.json、client 内存缓存）：
 *   1. Cursor API Key —— 后续所有 SDK 调用要用、可点「验证」拉模型列表
 *   2. 默认模型 —— 不预设默认值、列表通过 /api/models 动态拉
 *   3. 仓库列表 —— agent 启动时作为 cwd 用、暂时只支持本地绝对路径
 *      通过桌面端原生 picker（pickNativePaths）选本地目录
 *   4. MCP servers —— fe 自管独立配置（V0.13、条目化管理 + 从 Cursor 导入）
 *
 * 拆分约定：
 * - 状态管理 → src/hooks/use-settings.ts、use-models.ts
 * - 4 张 Card → src/components/settings/{api-key,model,repo,mcp}-card.tsx
 * - 这个文件只组合：拿 hook 出来的值、传给 Card
 *
 * 不做的事（已与用户对齐）：
 * - 不做按 phase 配模型：留给 V0.2 之后
 * - 不预选默认模型：避免误用
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";

import { useSettings } from "@/hooks/use-settings";
import { useModels } from "@/hooks/use-models";
import { useApiKeyInfo } from "@/hooks/use-api-key-info";
import { getSettings } from "@/lib/local-store";
import { cn } from "@/lib/utils";

import { ApiKeyCard } from "@/components/settings/api-key-card";
import { ModelCard } from "@/components/settings/model-card";
import { RepoCard } from "@/components/settings/repo-card";
import { McpCard } from "@/components/settings/mcp-card";
import { UserProfileCard } from "@/components/settings/user-profile-card";
import { GitCard } from "@/components/settings/git-card";
import { PreferenceCard } from "@/components/settings/preference-card";
import { CheckUpdateButton } from "@/components/settings/check-update-button";
import { DiagnosticsButton } from "@/components/settings/diagnostics-button";
import { FeishuCliCard } from "@/components/settings/feishu-cli-card";

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

  // ?focus=api-key 等锚点：滚到对应卡片并短暂高亮（toast / 链接跳转用）
  const [highlightId, setHighlightId] = useState<string | null>(null);
  useEffect(() => {
    if (!loaded) return;
    const focus = new URLSearchParams(window.location.search).get("focus");
    if (!focus) return;
    const id = `card-${focus}`;
    const el = document.getElementById(id);
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      setHighlightId(id);
    });
    const timer = window.setTimeout(() => setHighlightId(null), 2000);
    return () => window.clearTimeout(timer);
  }, [loaded]);

  // 卡片外层包稳定 id + 锚点高亮 ring
  const wrapCard = (id: string, node: ReactNode) => (
    <div
      id={id}
      className={cn(
        "rounded-xl transition-shadow duration-300",
        highlightId === id && "ring-2 ring-primary/60",
      )}
    >
      {node}
    </div>
  );

  if (!loaded) {
    return <LoadingState variant="block" />;
  }

  // 返回 = 回来路（任务详情 / 首页都可能）、无历史（直开 /settings）兜底回首页
  const handleBack = () => {
    if (window.history.length > 1) router.back();
    else router.push("/");
  };

  return (
    <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">
      {/* 顶部返回链接 + 页标题 */}
      <div>
        <Button
          variant="ghost"
          size="sm"
          className="px-2 -ml-2 mb-2"
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
        "card-api-key",
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
      {wrapCard("card-feishu", <FeishuCliCard />)}

      {wrapCard(
        "card-profile",
        <UserProfileCard
          branchTemplate={settings.branchTemplate ?? ""}
          jumpIde={settings.jumpIde ?? "cursor"}
          onJumpIdeChange={(v) => saveFieldValue("jumpIde", v)}
          onBranchTemplateChange={(v) => update("branchTemplate", v)}
          onBranchTemplateCommit={(v) => saveFieldValue("branchTemplate", v)}
        />,
      )}

      {wrapCard(
        "card-preference",
        <PreferenceCard
          submitShortcut={settings.submitShortcut ?? "mod-enter"}
          reuseAgentDefault={settings.reuseAgentDefault ?? false}
          onSubmitShortcutChange={(v) => saveFieldValue("submitShortcut", v)}
          onReuseAgentDefaultChange={(v) => saveFieldValue("reuseAgentDefault", v)}
        />,
      )}

      {wrapCard(
        "card-git",
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
        "card-model",
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
        "card-repos",
        <RepoCard
          repos={settings.repos}
          onChange={(next) => update("repos", next)}
          onCommit={(next) => saveFieldValue("repos", next)}
        />,
      )}

      {wrapCard(
        "card-mcp",
        <McpCard
          appServers={settings.mcpServers ?? {}}
          onAppServersChange={(next) => update("mcpServers", next)}
          onAppServersCommit={(next) => saveFieldValue("mcpServers", next)}
          disabledServers={settings.disabledMcpServers ?? []}
          onChange={(next) => saveFieldValue("disabledMcpServers", next)}
        />,
      )}
    </div>
  );
};

export default SettingsPage;
