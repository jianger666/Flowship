"use client";

/**
 * 任务详情页头部的 MR 链接条：ship / dev action 落档后出现，多仓 task 每个 MR 一个入口（R14 Q3-01）。
 *
 * 为什么有这个文件：v1.7.1 头部重构（74f8d71）整块删掉了页面上的 MR 链接，之后 `task.mrs`
 * 在 UI 里只剩推进弹窗的 placeholder 在读——提了 MR 却没有地方点开。现在做成叶子组件放回
 * `WorkspaceActions` 下面。
 *
 * 和旧实现不同的几处（别回退）：
 * - 只吃 `mrs` + 两份分支快照、不吃整个 task，并 memo。注意 memo 的实际收益有限：每个 `task` 事件到来时
 *   `task.mrs` 都是新数组引用（task-store 的 SSE 逐帧 JSON.parse、没有结构共享），所以它只在页面因别的
 *   本地状态（弹窗开关 / 输入框…）重渲染、而 task 引用没变时，才省掉这一次渲染
 * - 仓名用 `pathBasename`——旧实现 `split("/")` 在 Windows 路径（`C:\a\b`）上会把整条路径当仓名
 * - **不展示 MR 状态**（进行中 / 已合并 / 已关闭）：`task.mrs[].status` 提交时固定写 "open"
 *   （task-runner.ts），之后全仓没有任何地方更新它（types.ts 的注释写着「polling 状态更新留 V0.6.4+」，
 *   一直没做）——展示出来只会对已经合并的 MR 说「进行中」，是错误陈述。要展示，得先做状态同步，是另开的一项
 * - tooltip 用多行元素——旧实现用 `\n` 拼字符串，HTML 里不换行，几行字挤成一行
 * - url 不是 http(s)（空串：gitlab-client 个别路径会兜底成 ""；或别的协议）就不渲染成链接：
 *   `<a href="">` 点开会在新标签页里再打开一遍当前页面
 * - 记录字段缺失（老数据 title / url 不是字符串）也不能让整个头部渲染抛错，所以派生逻辑对字段宽容
 *
 * 展示所需的派生数据都在纯函数 `buildMrViews` 里，组件只负责摆放。
 */

import { ExternalLink } from "lucide-react";
import { memo } from "react";

import { Badge } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/tooltip";
import { pathBasename } from "@/lib/path-utils";
import { MR_KIND_LABEL, mrKindOf, mrTargetBranchOf } from "@/lib/task-display";
import type { MRRecord } from "@/lib/types";

/** 一个 MR 入口展示所需的全部派生数据 */
export interface MrView {
  /** React key：仓 + 目标分支 + 版本 + 位置（位置只是兜底，见 buildMrViews） */
  key: string;
  kind: "ship" | "dev";
  kindLabel: string;
  /** 有效目标分支（老记录缺 targetBranch 时兜底该仓测试分支） */
  target: string;
  /** 只认 http(s)；null = 不渲染成链接 */
  href: string | null;
  /** 仓名（路径末段）+ 版本号（>1 才带，如「web-app v2」） */
  repoLabel: string;
  /** tooltip 的几行字：类型 → 目标分支 / 标题 / 地址 */
  tooltipLines: string[];
}

const asText = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export const buildMrViews = (
  mrs: readonly MRRecord[],
  repoTestBranches?: Record<string, string>,
  repoDevBranches?: Record<string, string>,
): MrView[] =>
  mrs.map((mr, i) => {
    const target = mrTargetBranchOf(mr, repoTestBranches);
    const kind = mrKindOf(mr, repoTestBranches, repoDevBranches);
    const kindLabel = MR_KIND_LABEL[kind];
    const title = asText(mr.title);
    const url = asText(mr.url);
    const repoPath = typeof mr.repoPath === "string" ? mr.repoPath : "";
    const repoName = pathBasename(repoPath) || repoPath;
    const versionTag = Number.isFinite(mr.version) && mr.version > 1 ? ` v${mr.version}` : "";
    const tooltipLines = [`${kindLabel} → ${target}`];
    if (title) tooltipLines.push(title);
    if (url) tooltipLines.push(url);
    return {
      // 末尾的 i 是兜底：数据层按「仓 + 目标分支」去重，正常数据下前三段就唯一；
      // 老数据里仓路径是空串、目标分支又相同时会撞 key
      key: `${repoPath}-${target}-${mr.version}-${i}`,
      kind,
      kindLabel,
      target,
      href: /^https?:\/\//i.test(url) ? url : null,
      repoLabel: `${repoName}${versionTag}`,
      tooltipLines,
    };
  });

interface Props {
  mrs: readonly MRRecord[];
  /** 每仓测试分支快照（老记录缺 targetBranch 时兜底用） */
  repoTestBranches?: Record<string, string>;
  /** 每仓 dev 分支快照（目标分支等于它 = 联调） */
  repoDevBranches?: Record<string, string>;
}

const TaskMrLinksImpl = ({ mrs, repoTestBranches, repoDevBranches }: Props) => {
  if (!mrs || mrs.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      {buildMrViews(mrs, repoTestBranches, repoDevBranches).map((v) => {
        const inner = (
          <>
            {v.href ? <ExternalLink className="size-3" /> : null}
            <Badge variant="outline" size="xs" className="font-normal">
              {v.kindLabel}
            </Badge>
            {v.repoLabel}
          </>
        );
        return (
          <Tooltip
            key={v.key}
            content={
              <div className="space-y-0.5">
                {v.tooltipLines.map((line, i) => (
                  <div key={i} className="break-all">
                    {line}
                  </div>
                ))}
              </div>
            }
          >
            {v.href ? (
              <a
                href={v.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
              >
                {inner}
              </a>
            ) : (
              <span className="inline-flex items-center gap-1 text-muted-foreground">{inner}</span>
            )}
          </Tooltip>
        );
      })}
    </div>
  );
};

export const TaskMrLinks = memo(TaskMrLinksImpl);
