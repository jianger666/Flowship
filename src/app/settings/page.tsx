"use client";

/**
 * 设置页（壳子）
 *
 * 配置块（除 MCP 外都存 localStorage、不上服务器）：
 *   1. Cursor API Key —— 后续所有 SDK 调用要用、可点「验证」拉模型列表
 *   2. 默认模型 —— 不预设默认值、列表通过 /api/models 动态拉
 *   3. 仓库列表 —— agent 启动时作为 cwd 用、暂时只支持本地绝对路径
 *      通过 /api/fs/pick-folder 调原生 dialog（非 macOS 走「手填路径」备份入口）
 *   4. MCP servers —— 只读展示 Cursor 的 ~/.cursor/mcp.json（V0.6.2 起、不再 fe 自存）
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

import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";

import { useSettings } from "@/hooks/use-settings";
import { useModels } from "@/hooks/use-models";

import { ApiKeyCard } from "@/components/settings/api-key-card";
import { ModelCard } from "@/components/settings/model-card";
import { RepoCard } from "@/components/settings/repo-card";
import { McpCard } from "@/components/settings/mcp-card";
import { UserProfileCard } from "@/components/settings/user-profile-card";
import { GitCard } from "@/components/settings/git-card";

const SettingsPage = () => {
  const { settings, loaded, update, saveFieldValue } = useSettings();
  const { models, loading: modelsLoading, error: modelsError, fetchModels } = useModels();

  if (!loaded) {
    return <LoadingState variant="block" />;
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">
      {/* 顶部返回链接 + 页标题 */}
      <div>
        <Button
          variant="ghost"
          size="sm"
          className="px-2 -ml-2 mb-2"
          nativeButton={false}
          render={<Link href="/" className="no-underline" />}
        >
          <ArrowLeft />
          返回
        </Button>
        <h1 className="text-lg font-semibold">设置</h1>
        <p className="text-xs text-muted-foreground mt-1">
          编辑即保存、所有数据仅存浏览器 localStorage、不上传服务器
        </p>
      </div>

      <ApiKeyCard
        apiKey={settings.apiKey}
        onChange={(v) => update("apiKey", v)}
        onCommit={(v) => saveFieldValue("apiKey", v)}
        onValidate={fetchModels}
        validating={modelsLoading}
      />

      <UserProfileCard
        username={settings.username ?? ""}
        onChange={(v) => update("username", v)}
        onCommit={(v) => saveFieldValue("username", v)}
      />

      <GitCard
        gitHost={settings.gitHost ?? ""}
        gitToken={settings.gitToken ?? ""}
        onHostChange={(v) => update("gitHost", v)}
        onTokenChange={(v) => update("gitToken", v)}
        onHostCommit={(v) => saveFieldValue("gitHost", v)}
        onTokenCommit={(v) => saveFieldValue("gitToken", v)}
      />

      <ModelCard
        models={models}
        modelsError={modelsError}
        selection={settings.defaultModel}
        onChange={(next) => saveFieldValue("defaultModel", next)}
        apiKey={settings.apiKey}
        refreshing={modelsLoading}
        onRefresh={fetchModels}
      />

      <RepoCard
        repos={settings.repos}
        onChange={(next) => update("repos", next)}
        onCommit={(next) => saveFieldValue("repos", next)}
      />

      <McpCard
        disabledServers={settings.disabledMcpServers ?? []}
        onChange={(next) => saveFieldValue("disabledMcpServers", next)}
      />
    </div>
  );
};

export default SettingsPage;
