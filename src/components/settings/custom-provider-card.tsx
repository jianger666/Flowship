"use client";

/**
 * 自定义 provider 目录——Cursor SDK 固定在设置页上方，这里只管可增删的 HTTP 条目。
 * 折叠行跟环境配置 EnvSection 同款：图标 + 标题 + 状态点 + 摘要 + chevron；点开再填。
 */

import { ChevronDown, Cloud, Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { DefaultModelSection } from "@/components/settings/api-key-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Picker } from "@/components/ui/picker";
import { SettingRow } from "@/components/ui/setting-row";
import { Tooltip } from "@/components/ui/tooltip";
import { useDialog } from "@/hooks/use-dialog";
import { useModels } from "@/hooks/use-models";
import {
  countTasksBoundToProvider,
  customProviderDisplayName,
  emptyCustomProvider,
  hostNameFromUrl,
  isCustomProviderReady,
  listProviderOptions,
} from "@/lib/agent-provider";
import {
  customBaseUrlNotice,
  formatFromCustomBaseUrl,
  validateCustomBaseUrl,
} from "@/lib/custom-provider-url";
import { fetchTasks } from "@/lib/task-store";
import { CURSOR_PROVIDER_ID, CUSTOM_PROVIDER_FORMAT_LABEL } from "@/lib/types";
import type {
  AgentProviderId,
  CustomProviderConfig,
  CustomProviderFormat,
  FeAiFlowSettings,
  ModelSelection,
} from "@/lib/types";
import { cn } from "@/lib/utils";

export const DefaultProviderSection = ({
  value,
  settings,
  onChange,
  className,
}: {
  value: AgentProviderId;
  settings: Pick<FeAiFlowSettings, "customProviders">;
  onChange: (next: AgentProviderId) => void;
  className?: string;
}) => (
  <SettingRow
    stacked
    className={className}
    label="默认提供方"
    hint="先配好上面的提供方，再选新建对话用哪一个"
    control={
      <Picker
        value={value || CURSOR_PROVIDER_ID}
        onChange={onChange}
        options={listProviderOptions(settings)}
      />
    }
  />
);

interface CustomProviderListProps {
  items: CustomProviderConfig[];
  onChange: (next: CustomProviderConfig[]) => void;
  onCommit: (next: CustomProviderConfig[]) => void | Promise<unknown>;
  defaultProvider: AgentProviderId;
  onDefaultProviderChange: (next: AgentProviderId) => void;
}

export const CustomProviderList = ({
  items,
  onChange,
  onCommit,
  defaultProvider,
  onDefaultProviderChange,
}: CustomProviderListProps) => {
  const { confirm } = useDialog();
  // 同时只展开一条；只有一条时默认打开，新增后打开刚加的那条
  const [expandedId, setExpandedId] = useState<string | null>(
    () => (items.length === 1 ? items[0]!.id : null),
  );

  const patchAt = (id: string, nextRow: CustomProviderConfig) => {
    const next = items.map((p) => (p.id === id ? nextRow : p));
    onChange(next);
    return next;
  };

  const handleAdd = () => {
    const row = emptyCustomProvider();
    const next = [...items, row];
    onChange(next);
    setExpandedId(row.id);
    void onCommit(next);
  };

  const handleDelete = async (id: string) => {
    const row = items.find((p) => p.id === id);
    // 统计还有多少对话 / 任务绑着它：删除后（或「删了重加」换了新 id）它们要重新选提供方才能继续发送（D1-03）。
    // 拉不到列表就不说数字，只说后果——不因统计失败挡住删除
    let boundCount: number | null = null;
    try {
      boundCount = countTasksBoundToProvider(await fetchTasks(), id);
    } catch {
      boundCount = null;
    }
    const consequence =
      boundCount === null
        ? "已经绑定它的对话 / 任务删除后需要重新选择提供方才能继续发送。"
        : boundCount > 0
          ? `有 ${boundCount} 个对话 / 任务正绑定它：删除后它们需要重新选择提供方才能继续发送（不会自动改走别家）。`
          : "";
    const ok = await confirm({
      title: "删除这个提供方？",
      description: row
        ? `「${customProviderDisplayName(row)}」会从目录里去掉。${consequence}`
        : undefined,
      destructive: true,
    });
    if (!ok) return;
    const next = items.filter((p) => p.id !== id);
    onChange(next);
    if (expandedId === id) setExpandedId(null);
    await Promise.resolve(onCommit(next));
    if (defaultProvider === id) onDefaultProviderChange(CURSOR_PROVIDER_ID);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <div className="text-sm">自定义提供方</div>
        <Button type="button" variant="outline" size="sm" onClick={handleAdd}>
          <Plus />
          新增
        </Button>
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">还没有自定义提供方</p>
      ) : (
        <div className="overflow-hidden rounded-md border border-border/60">
          {items.map((row) => (
            <CustomProviderRow
              key={row.id}
              value={row}
              open={expandedId === row.id}
              isDefault={defaultProvider === row.id}
              onToggle={() =>
                setExpandedId((cur) => (cur === row.id ? null : row.id))
              }
              onChange={(v) => patchAt(row.id, v)}
              onCommit={(v) => {
                void onCommit(patchAt(row.id, v));
                if (
                  defaultProvider === row.id &&
                  !isCustomProviderReady(v)
                ) {
                  onDefaultProviderChange(CURSOR_PROVIDER_ID);
                }
              }}
              onDelete={() => void handleDelete(row.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
};

const CustomProviderRow = ({
  value,
  open,
  isDefault,
  onToggle,
  onChange,
  onCommit,
  onDelete,
}: {
  value: CustomProviderConfig;
  open: boolean;
  isDefault: boolean;
  onToggle: () => void;
  onChange: (next: CustomProviderConfig) => void;
  onCommit: (next: CustomProviderConfig) => void;
  onDelete: () => void;
}) => {
  const [showKey, setShowKey] = useState(false);
  const { models, loading, error, fetchModels } = useModels();
  const valueRef = useRef(value);
  valueRef.current = value;

  const setField = <K extends keyof CustomProviderConfig>(
    key: K,
    v: CustomProviderConfig[K],
  ) => onChange({ ...value, [key]: v });

  const pullModels = useCallback(
    (row: CustomProviderConfig, manual?: boolean) => {
      if (!row.baseUrl.trim()) return;
      // 地址本身不合法（含 userinfo / 缺协议头…）就别发请求：红字已经说明原因，发出去只会回显一串错误（第四轮 Q2-06）
      if (validateCustomBaseUrl(row.baseUrl)) return;
      void fetchModels(
        {
          apiKey: row.apiKey,
          baseUrl: row.baseUrl,
          format: row.format,
          provider: row.id,
        },
        manual ? { manual: true } : undefined,
      );
    },
    [fetchModels],
  );

  const commit = (next: CustomProviderConfig, shouldPull?: boolean) => {
    onCommit(next);
    if (shouldPull) pullModels(next);
  };

  // 展开才拉模型，收起的条目不打接口
  useEffect(() => {
    if (!open) return;
    pullModels(valueRef.current);
  }, [open, value.id, fetchModels, pullModels]);

  const ready = isCustomProviderReady(value);
  const host = hostNameFromUrl(value.baseUrl);
  const summary = ready ? host || value.baseUrl.trim() : "未配置";
  const baseUrlError = validateCustomBaseUrl(value.baseUrl);
  // 「已自动处理」的黄字提示（带 ?# / 粘了具体接口地址）：不是错误，不用红字、不设 aria-invalid
  const baseUrlNotice = baseUrlError ? null : customBaseUrlNotice(value.baseUrl);
  // 拉不到模型列表（没有 /models 的网关 / 列表为空）时给「手填模型 ID」出口（D1-04）
  const showManualModel = !loading && (!!error || models.length === 0);

  return (
    <div className="border-b last:border-b-0">
      <button
        type="button"
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-muted/40"
        onClick={onToggle}
        aria-expanded={open}
      >
        <Cloud className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="min-w-0 truncate text-sm font-medium">
            {customProviderDisplayName(value)}
          </span>
          {isDefault ? (
            <Badge variant="secondary" size="xs" className="shrink-0">
              默认
            </Badge>
          ) : null}
        </span>
        <span className="flex min-w-0 max-w-[55%] shrink-0 items-center gap-1.5">
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              ready ? "bg-success" : "bg-muted-foreground/40",
            )}
            aria-hidden
          />
          <span
            className={cn(
              "truncate text-xs",
              ready ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {summary}
          </span>
        </span>
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150",
            !open && "-rotate-90",
          )}
        />
      </button>
      {open ? (
        <div className="space-y-2.5 border-t border-border/60 px-6 pb-3 pt-2.5">
          <div>
            <div className="mb-1 text-[11px] text-muted-foreground">名称</div>
            <Input
              type="text"
              value={value.name}
              onChange={(e) => setField("name", e.target.value)}
              onBlur={(e) => commit({ ...value, name: e.target.value.trim() })}
            />
          </div>
          <div>
            <div className="mb-1 text-[11px] text-muted-foreground">接口地址</div>
            <Input
              type="text"
              value={value.baseUrl}
              onChange={(e) => setField("baseUrl", e.target.value)}
              onBlur={(e) => {
                const baseUrl = e.target.value.trim();
                const format = formatFromCustomBaseUrl(baseUrl, value.format);
                const next = { ...value, baseUrl, format };
                onChange(next);
                commit(next, true);
              }}
              placeholder="https://api.example.com/v1"
              aria-invalid={baseUrlError ? true : undefined}
              className="font-mono"
            />
            {baseUrlError ? (
              <div className="mt-1 text-[11px] text-destructive">
                {baseUrlError}
              </div>
            ) : baseUrlNotice ? (
              <div className="mt-1 text-[11px] text-warning">{baseUrlNotice}</div>
            ) : (
              <div className="mt-1 text-[11px] text-muted-foreground">
                末尾写了 /v1 就保留；没写时，路径里已有版本段（如 /v4、/v3、/v1beta）则原样使用，否则自动补 /v1。
                暂不支持「不带版本段、又不能带 /v1」的地址（如 GitHub Models、Azure 经典部署）
              </div>
            )}
          </div>
          <div>
            <div className="mb-1 text-[11px] text-muted-foreground">API Key</div>
            <div className="flex gap-2">
              <Input
                type={showKey ? "text" : "password"}
                value={value.apiKey}
                onChange={(e) => setField("apiKey", e.target.value)}
                onBlur={(e) =>
                  commit({ ...value, apiKey: e.target.value }, true)
                }
                className="font-mono"
              />
              <Tooltip content={showKey ? "隐藏" : "显示"}>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => setShowKey((s) => !s)}
                  aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
                  aria-pressed={showKey}
                >
                  {showKey ? <EyeOff /> : <Eye />}
                </Button>
              </Tooltip>
            </div>
          </div>
          <div>
            <div className="mb-1 text-[11px] text-muted-foreground">协议</div>
            <Picker
              value={value.format}
              onChange={(v) => {
                const format: CustomProviderFormat =
                  v === "anthropic"
                    ? "anthropic"
                    : v === "openai"
                      ? "openai"
                      : "auto";
                const next = { ...value, format };
                onChange(next);
                commit(next, true);
              }}
              options={(
                Object.keys(CUSTOM_PROVIDER_FORMAT_LABEL) as CustomProviderFormat[]
              ).map((id) => ({
                value: id,
                label: CUSTOM_PROVIDER_FORMAT_LABEL[id],
              }))}
            />
            {value.format === "auto" ? (
              <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
                按模型自动选协议（models.dev 目录）；目录外的端点走 OpenAI 兼容
              </p>
            ) : null}
          </div>
          <DefaultModelSection
            models={models}
            modelSelection={
              value.defaultModel?.id?.trim() ? value.defaultModel : { id: "" }
            }
            onModelChange={(next: ModelSelection) => {
              const row = { ...value, defaultModel: next };
              onChange(row);
              onCommit(row);
            }}
            canRefreshModels={!!value.baseUrl.trim()}
            onModelsRefresh={() => pullModels(value, true)}
            modelsRefreshing={loading}
            modelsError={error}
            providerId={value.id}
          />
          {showManualModel ? (
            <div>
              <div className="mb-1 text-[11px] text-muted-foreground">
                手填模型 ID
              </div>
              <Input
                type="text"
                value={value.defaultModel?.id ?? ""}
                onChange={(e) =>
                  setField("defaultModel", { id: e.target.value })
                }
                onBlur={(e) => {
                  const id = e.target.value.trim();
                  const row = { ...value, defaultModel: id ? { id } : undefined };
                  onChange(row);
                  onCommit(row);
                }}
                placeholder="例如 gpt-4o-mini"
                className="font-mono"
                spellCheck={false}
              />
              <div className="mt-1 text-[11px] text-muted-foreground">
                {error
                  ? "拉不到模型列表时（有些网关没有 /models）可以直接填模型 ID"
                  : "这个端点没有返回模型列表，可以直接填模型 ID"}
              </div>
            </div>
          ) : null}
          <div className="flex justify-end border-t border-border/60 pt-2">
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={onDelete}
            >
              <Trash2 />
              删除
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
};
