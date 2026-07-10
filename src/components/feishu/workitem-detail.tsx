"use client";

/**
 * 飞书工作项详情渲染（V0.14、预览页 + 任务详情融合共用）
 *
 * 数据源 /api/feishu/workitem——meegle workitem get 的响应没有公开 schema、
 * 这里做「已知字段精排 + 其余字段兜底表格」两层渲染：
 * - 精排：名称 / 状态 / 描述（markdown）/ 排期
 * - 兜底：workitem_fields 里 value 非空的字段两列表格（field_name: value）
 */

import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";

import { LoadingState } from "@/components/ui/loading-state";
import { EmptyHint } from "@/components/ui/empty-hint";
import { MarkdownText } from "@/components/tasks/event-stream/rows";
import { settingsUrl } from "@/lib/settings-link";

interface Props {
  /** 二选一：直接给 id+project、或给工作项 URL（服务端本地 decode） */
  workItemId?: string;
  projectKey?: string;
  url?: string;
}

type FetchState =
  | { phase: "loading" }
  | { phase: "unavailable"; reason: string; showAuthLink: boolean }
  | { phase: "ok"; detail: Record<string, unknown> };

// meegle workitem_fields 单项 → 展示行（value 为空 / 对象太深的丢弃）
const fieldRows = (detail: Record<string, unknown>): Array<[string, string]> => {
  const fields = detail.workitem_fields ?? detail.fields;
  if (!Array.isArray(fields)) return [];
  const rows: Array<[string, string]> = [];
  for (const f of fields as Array<Record<string, unknown>>) {
    const name =
      (typeof f.field_name === "string" && f.field_name) ||
      (typeof f.field_key === "string" && f.field_key) ||
      "";
    if (!name) continue;
    const v = f.value ?? f.field_value;
    let text = "";
    if (typeof v === "string") text = v;
    else if (typeof v === "number") text = String(v);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      text =
        (typeof o.label === "string" && o.label) ||
        (typeof o.name === "string" && o.name) ||
        "";
    }
    if (text.trim()) rows.push([name, text.trim()]);
  }
  return rows.slice(0, 30);
};

const pickStr = (detail: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = detail[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
};

export const WorkitemDetail = ({ workItemId, projectKey, url }: Props) => {
  const [state, setState] = useState<FetchState>({ phase: "loading" });

  useEffect(() => {
    let alive = true;
    const qs = new URLSearchParams();
    if (workItemId) qs.set("id", workItemId);
    if (projectKey) qs.set("project", projectKey);
    if (!workItemId && url) qs.set("url", url);
    setState({ phase: "loading" });
    void fetch(`/api/feishu/workitem?${qs.toString()}`)
      .then((r) => r.json())
      .then(
        (d: { status: string; message?: string; detail?: Record<string, unknown> }) => {
          if (!alive) return;
          if (d.status === "ok" && d.detail) {
            setState({ phase: "ok", detail: d.detail });
          } else if (d.status === "not_installed" || d.status === "not_authed") {
            setState({
              phase: "unavailable",
              reason:
                d.status === "not_installed"
                  ? "飞书项目 CLI 未安装、看不了需求详情"
                  : "飞书项目未授权、看不了需求详情",
              showAuthLink: true,
            });
          } else if (d.status === "not_workitem") {
            setState({
              phase: "unavailable",
              reason: "链接不是工作项详情页、无法展示",
              showAuthLink: false,
            });
          } else {
            setState({
              phase: "unavailable",
              reason: d.message ?? "详情拉取失败",
              showAuthLink: false,
            });
          }
        },
      )
      .catch((err) => {
        if (!alive) return;
        setState({
          phase: "unavailable",
          reason: err instanceof Error ? err.message : String(err),
          showAuthLink: false,
        });
      });
    return () => {
      alive = false;
    };
  }, [workItemId, projectKey, url]);

  if (state.phase === "loading") return <LoadingState variant="inline" />;
  if (state.phase === "unavailable") {
    return (
      <EmptyHint size="sm">
        {state.reason}
        {state.showAuthLink && (
          <>
            ——
            <a
              href={settingsUrl("feishu")}
              className="text-primary underline-offset-2 hover:underline"
            >
              去设置页处理
            </a>
          </>
        )}
      </EmptyHint>
    );
  }

  const { detail } = state;
  const name = pickStr(detail, ["name", "work_item_name", "title"]);
  const description = pickStr(detail, ["description", "desc"]);
  const rows = fieldRows(detail);
  // description 常同时出现在 workitem_fields 里、精排展示过就从兜底表格剔除
  const restRows = rows.filter(([k]) => !["描述", "description"].includes(k));

  return (
    <div className="flex flex-col gap-4">
      {name && (
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold leading-snug">{name}</h2>
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="size-3.5" />
              飞书打开
            </a>
          )}
        </div>
      )}

      {description ? (
        <div className="rounded-md border bg-card/50 px-4 py-3 text-sm leading-relaxed">
          <MarkdownText text={description} />
        </div>
      ) : (
        <EmptyHint size="sm">工作项没有描述内容</EmptyHint>
      )}

      {restRows.length > 0 && (
        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-sm">
            <tbody>
              {restRows.map(([k, v]) => (
                <tr key={k} className="border-b last:border-b-0">
                  <td className="w-32 shrink-0 border-r bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
                    {k}
                  </td>
                  <td className="px-3 py-1.5 wrap-anywhere">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
