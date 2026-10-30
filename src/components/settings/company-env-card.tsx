"use client";

/**
 * 「环境配置」节（并入设置页「连接」卡尾部）
 *
 * 折叠小节 + 状态摘要：默认全部收起，一眼扫绿/灰点；点开再编表单。
 * 服务器 / PG / XXL / Nacos / ELK / SLS / HTTP API 本质是外部服务凭据，与 API Key / GitLab / 飞书同属「连接」。
 */

import {
  Boxes,
  ChevronDown,
  ClipboardList,
  Copy,
  Database,
  Download,
  Eye,
  FileUp,
  Globe,
  HardDrive,
  Layers,
  Plus,
  ScrollText,
  Server,
  Timer,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Tooltip } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { IntInput } from "@/components/ui/int-input";
import { PasswordInput } from "@/components/ui/password-input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useDialog } from "@/hooks/use-dialog";
import { useStableRowKeys } from "@/hooks/use-stable-row-keys";
import { PORT_MAX, PORT_MIN } from "@/lib/int-field";
import {
  companyEnvTemplateJson,
  findCompanyEnvServerIssue,
  findCompanyEnvServerRowIssue,
  isBlankCompanyEnvRow,
  isCompanyEnvConfigured,
  isXxljobReadonly,
  parseCompanyEnvImport,
} from "@/lib/company-env";
import { pickNativePaths } from "@/lib/native-picker";
import { cn } from "@/lib/utils";
import type {
  CompanyEnv,
  CompanyEnvElk,
  CompanyEnvHttpApi,
  CompanyEnvCustom,
  CompanyEnvNacos,
  CompanyEnvPg,
  CompanyEnvRedis,
  CompanyEnvServer,
  CompanyEnvSls,
  CompanyEnvXxlJob,
} from "@/lib/types";

type SectionId =
  | "servers"
  | "pg"
  | "redis"
  | "custom"
  | "xxljob"
  | "nacos"
  | "elk"
  | "sls"
  | "httpApis";

interface CompanyEnvSectionProps {
  value: CompanyEnv;
  /** 草稿变更（输入中） */
  onChange: (next: CompanyEnv) => void;
  /** 落盘（失焦 / 增删 / 导入） */
  onCommit: (next: CompanyEnv) => Promise<boolean> | boolean;
}

/** 环境字段候选（Combobox 支持自由输入其它值） */
const ENV_OPTIONS = ["dev", "test", "production"];
/** 宽到 production 单行能下；弹层 min-w 收在 Combobox 里，这里只定 trigger 宽 */
const ENV_FIELD_CLASS = "w-36 shrink-0 space-y-0.5";

/** 字段顺序无关的稳定序列化：落盘去重 key 不受对象键顺序影响 */
const stableKey = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableKey).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableKey(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

/**
 * 删除含用户填写内容的条目：有内容先确认（S13-14 / R7-01，原先一击即删 + 立即落盘、内容找不回）；
 * 刚添加还没填任何文本的空白行直接删（判定用 company-env.ts 的 isBlankCompanyEnvRow，与服务端
 * settings-fs 的收缩判定共用同一份——「添加」落盘的默认行带 env: "test"，env 等默认字段不算内容）。
 * apply 里自己调 commit / onCommit。
 * 本文件里**所有**从数组移除元素的写法都必须包在 removeRow(...) 的回调里
 * （tests/settings-safety-contract.test.ts 用 AST 枚举守住）。
 */
const useRemoveRow = () => {
  const { confirm } = useDialog();
  return async (kind: string, name: string, row: object, apply: () => void) => {
    if (!isBlankCompanyEnvRow(row)) {
      const ok = await confirm({
        title: `删除${kind}？`,
        description: `${name ? `「${name}」` : "该条目"}将立即从配置中移除并保存，已填写的内容（含密码）无法找回。`,
        confirmLabel: "删除",
        destructive: true,
      });
      if (!ok) return;
    }
    apply();
  };
};

/** 迷你 label + 控件（并排字段用、禁 placeholder-only） */
const MiniField = ({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) => (
  <label className={className ?? "min-w-0 flex-1 space-y-0.5"}>
    <span className="text-[11px] text-muted-foreground">{label}</span>
    {/* children 包一层 div：PopoverTrigger 弹层打开时会注入 FocusGuard 兄弟节点，
       直接裸露会被 space-y 当成额外子元素、给控件加 2px margin（实测抖动） */}
    <div>{children}</div>
  </label>
);

/** 实例卡外壳（一条服务器 / PG 实例 / Nacos 集群 / ELK / XXL 环境） */
const InstanceCard = ({ children }: { children: ReactNode }) => (
  <div className="space-y-1.5 rounded-md border border-border/60 bg-muted/20 p-2.5">
    {children}
  </div>
);

/** 列表底部「再加一条」按钮（各实例小节 + StringListEditor 共用） */
const AddRowButton = ({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) => (
  <Button
    type="button"
    variant="ghost"
    size="sm"
    className="h-7 px-2 text-xs text-muted-foreground"
    onClick={onClick}
  >
    <Plus className="size-3.5" />
    {label}
  </Button>
);

/** 多实例卡片头：环境 +（只读开关）+ 删除，PG / Nacos / ELK 三处共用。 */
/** 首行：环境字段（放最前）；只读 + 删除由 InstanceRowEnd 统一放行尾 */
const InstanceCardHeader = ({
  env,
  onEnvChange,
}: {
  env: string;
  onEnvChange: (next: string) => void;
}) => (
  <MiniField label="环境" className={ENV_FIELD_CLASS}>
    <Combobox
      value={env}
      onValueChange={onEnvChange}
      options={ENV_OPTIONS}
      placeholder="请选择"
      allowCustom
      className="h-8 w-full"
    />
  </MiniField>
);

/**
 * 实例行「删除」键（纯图标，读屏读不出名字——R14 Q19-01）的可访问名：「删除 <类型> 第 N 项（<环境>）」。
 * 不放 host / baseUrl：那是用户填的内网地址 / 可能带凭证的 URL，不往 DOM 属性里再抄一份；
 * 序号 + 环境已足够在一排同类卡片里分清是哪一条。
 */
const removeInstanceLabel = (kind: string, index: number, env: string): string => {
  const e = env.trim();
  return `删除 ${kind} 第 ${index + 1} 项${e ? `（${e}）` : ""}`;
};

/** 首行行尾簇：只读（可选）+ 删除——所有实例卡统一放第一排末尾 */
const InstanceRowEnd = ({
  readonly,
  onReadonlyChange,
  onRemove,
  removeLabel,
}: {
  readonly?: boolean;
  /** 不传 = 该子系统没有只读语义（ELK） */
  onReadonlyChange?: (next: boolean) => void;
  onRemove: () => void;
  /** 删除键（纯图标）的可访问名，用 removeInstanceLabel 生成；必填，新增实例类型时不会漏 */
  removeLabel: string;
}) => (
  <div className="flex shrink-0 items-end gap-1.5">
    {onReadonlyChange ? (
      <div className="flex h-8 items-center gap-1.5">
        <span className="text-[11px] text-muted-foreground">只读</span>
        <Switch
          checked={readonly !== false}
          onCheckedChange={onReadonlyChange}
        />
      </div>
    ) : null}
    <Tooltip content="删除">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8"
        aria-label={removeLabel}
        onClick={onRemove}
      >
        <Trash2 className="size-3.5" />
      </Button>
    </Tooltip>
  </div>
);

/** 逐条字符串列表（替代大 textarea）：每行 Input + 删 X + 底部添加 */
const StringListEditor = ({
  lines,
  onChange,
  onCommit,
  placeholder,
  addLabel = "添加",
  itemName = "项",
}: {
  lines: string[];
  /** 输入中改草稿 */
  onChange: (next: string[]) => void;
  /** 失焦 / 增删 落盘 */
  onCommit: (next: string[]) => void;
  placeholder?: string;
  addLabel?: string;
  /** 每行是什么（「命名空间」）——删除键（纯图标）的可访问名「删除<itemName> N」用 */
  itemName?: string;
}) => {
  const removeRow = useRemoveRow();
  return (
  <div className="space-y-1.5">
    {lines.map((line, i) => (
      <div key={i} className="flex items-center gap-1.5">
        <Input
          value={line}
          onChange={(e) => {
            const next = lines.map((row, j) =>
              j === i ? e.target.value : row,
            );
            onChange(next);
          }}
          onBlur={() => {
            const cleaned = lines.map((s) => s.trim()).filter(Boolean);
            onCommit(cleaned);
          }}
          placeholder={placeholder}
          className="h-8 font-mono text-xs"
        />
        <Tooltip content="删除">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 text-muted-foreground"
            aria-label={`删除${itemName} ${i + 1}`}
            onClick={() =>
              void removeRow("列表项", line.trim(), { line }, () =>
                onCommit(lines.filter((_, j) => j !== i)),
              )
            }
          >
            <X className="size-3.5" />
          </Button>
        </Tooltip>
      </div>
    ))}
    <AddRowButton label={addLabel} onClick={() => onCommit([...lines, ""])} />
  </div>
  );
};

/** 折叠小节壳：收起 = 图标 + 名 + 状态摘要 + chevron */
const EnvSection = ({
  id,
  icon: Icon,
  title,
  subtitle,
  configured,
  summary,
  open,
  onToggle,
  children,
}: {
  id: SectionId;
  icon: LucideIcon;
  title: string;
  /** 标题下的说明行（仅个别小节用，如「自定义」） */
  subtitle?: string;
  configured: boolean;
  summary: string;
  open: boolean;
  onToggle: (id: SectionId) => void;
  children: ReactNode;
}) => (
  <div className="border-b last:border-b-0">
    <button
      type="button"
      className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-muted/40"
      onClick={() => onToggle(id)}
      aria-expanded={open}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{title}</span>
        {subtitle && (
          <span className="truncate text-[11px] font-normal text-muted-foreground">
            {subtitle}
          </span>
        )}
      </span>
      <span className="flex min-w-0 max-w-[55%] items-center gap-1.5 shrink-0">
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            configured ? "bg-success" : "bg-muted-foreground/40",
          )}
          aria-hidden
        />
        <span
          className={cn(
            "truncate text-xs",
            configured ? "text-foreground" : "text-muted-foreground",
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
    {/* 展开内容顶部加分隔线 + 间距：标题行 hover 灰底不会和表单贴死（与行间 border-b 同风格） */}
    {open ? (
      <div className="space-y-2.5 border-t border-border/60 px-6 pb-3 pt-2.5">
        {children}
      </div>
    ) : null}
  </div>
);

// ---------- 状态摘要（收起态一眼扫） ----------

const serverSummary = (
  servers: CompanyEnvServer[],
): { configured: boolean; summary: string } => {
  const filled = servers.filter((s) => s.host.trim());
  if (filled.length === 0) return { configured: false, summary: "未配置" };
  return {
    configured: true,
    summary: `${filled.length} 台服务器`,
  };
};

const pgSummary = (
  rows: CompanyEnvPg[],
): { configured: boolean; summary: string } => {
  const filled = rows.filter((p) => p.host.trim());
  if (filled.length === 0) return { configured: false, summary: "未配置" };
  return { configured: true, summary: `${filled.length} 个实例` };
};

const redisSummary = (
  rows: CompanyEnvRedis[],
): { configured: boolean; summary: string } => {
  const filled = rows.filter((r) => r.host.trim());
  if (filled.length === 0) return { configured: false, summary: "未配置" };
  return { configured: true, summary: `${filled.length} 个实例` };
};





const customSummary = (
  rows: CompanyEnvCustom[],
): { configured: boolean; summary: string } => {
  const filled = rows.filter((c) => c.name.trim() || c.content.trim());
  if (filled.length === 0) return { configured: false, summary: "未配置" };
  return { configured: true, summary: `${filled.length} 条` };
};

const xxlSummary = (
  rows: CompanyEnvXxlJob[],
): { configured: boolean; summary: string } => {
  const filled = rows.filter((x) => x.baseUrl.trim());
  if (filled.length === 0) return { configured: false, summary: "未配置" };
  return { configured: true, summary: `${filled.length} 个环境` };
};

const nacosSummary = (
  rows: CompanyEnvNacos[],
): { configured: boolean; summary: string } => {
  const filled = rows.filter((n) => n.baseUrl.trim());
  if (filled.length === 0) return { configured: false, summary: "未配置" };
  return { configured: true, summary: `${filled.length} 个集群` };
};

const elkSummary = (
  rows: CompanyEnvElk[],
): { configured: boolean; summary: string } => {
  const filled = rows.filter((e) => e.baseUrl.trim());
  if (filled.length === 0) return { configured: false, summary: "未配置" };
  return { configured: true, summary: `${filled.length} 个实例` };
};

const slsSummary = (
  rows: CompanyEnvSls[],
): { configured: boolean; summary: string } => {
  const filled = rows.filter((s) => s.endpoint.trim() && s.project.trim());
  if (filled.length === 0) return { configured: false, summary: "未配置" };
  return { configured: true, summary: `${filled.length} 个实例` };
};

const httpApiSummary = (
  rows: CompanyEnvHttpApi[],
): { configured: boolean; summary: string } => {
  const filled = rows.filter((h) => h.url.trim());
  if (filled.length === 0) return { configured: false, summary: "未配置" };
  return { configured: true, summary: `${filled.length} 条` };
};

export const CompanyEnvSection = ({
  value,
  onChange,
  onCommit,
}: CompanyEnvSectionProps) => {
  const { confirm } = useDialog();
  // 导入飞行中（防双击）
  const [importing, setImporting] = useState(false);
  // 模板预览 dialog
  const [templateOpen, setTemplateOpen] = useState(false);
  // 当前展开的小节（默认全收起；同时只开一个，扫完再编）
  const [openId, setOpenId] = useState<SectionId | null>(null);
  // 落盘去重：同一完整状态写盘成功后不再重复 PUT；写盘期间同状态复用同一 promise
  const lastSavedRef = useRef("");
  const pendingCommitRef = useRef<{
    key: string;
    promise: Promise<boolean>;
  } | null>(null);

  /**
   * 落盘（带去重）。
   * S13-02：不再因「某台服务器缺 env / user」拒绝整份落盘——那会连带阻断 PG / Redis 等所有小节的保存、
   * 还在失焦时就弹 toast。缺项改为服务器卡里的行内提示（findCompanyEnvServerRowIssue），落盘照常。
   */
  const persist = (next: CompanyEnv): Promise<boolean> => {
    const key = stableKey(next);
    if (lastSavedRef.current === key) return Promise.resolve(true);
    const pending = pendingCommitRef.current;
    if (pending?.key === key) return pending.promise;
    const promise = (async () => {
      try {
        const ok = await onCommit(next);
        const saved = ok !== false;
        if (saved) lastSavedRef.current = key;
        return saved;
      } catch {
        return false;
      } finally {
        if (pendingCommitRef.current?.key === key) {
          pendingCommitRef.current = null;
        }
      }
    })();
    pendingCommitRef.current = { key, promise };
    return promise;
  };

  const commit = (next: CompanyEnv): Promise<boolean> => {
    onChange(next);
    return persist(next);
  };

  const patch = (partial: Partial<CompanyEnv>) => {
    onChange({ ...value, ...partial });
  };

  const toggle = (id: SectionId) => {
    setOpenId((prev) => (prev === id ? null : id));
  };

  const handleImport = async () => {
    setImporting(true);
    try {
      const paths = await pickNativePaths({
        mode: "file",
        prompt: "选择环境配置 JSON",
      });
      // 仅用户取消选文件静默；其余失败必须 toast
      if (!paths?.[0]) return;

      let res: Response;
      try {
        res = await fetch(
          `/api/system/read-text?path=${encodeURIComponent(paths[0])}`,
        );
      } catch (err) {
        toast.error(
          `导入失败：无法读取文件（${err instanceof Error ? err.message : String(err)}）`,
        );
        return;
      }
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) msg = body.error;
        } catch {
          /* 用状态码 */
        }
        toast.error(`导入失败：${msg}`);
        return;
      }
      const data = (await res.json()) as { text?: string };
      if (typeof data.text !== "string") {
        toast.error("导入失败：读取结果为空");
        return;
      }
      const parsed = parseCompanyEnvImport(data.text);
      if (!parsed.ok) {
        toast.error(`导入失败：${parsed.error}`);
        return;
      }
      // S13-10：导入是「整体覆盖」（所有小节、含已有密码），当前已有配置时先确认
      if (isCompanyEnvConfigured(value)) {
        const ok = await confirm({
          title: "覆盖当前环境配置？",
          description:
            "导入会整体替换现有的服务器 / 数据库 / 日志等全部环境配置（含已保存的密码），无法撤销。",
          confirmLabel: "覆盖导入",
          destructive: true,
          defaultFocus: "cancel",
        });
        if (!ok) return;
      }
      // 导入后保持收起——摘要变绿即感知生效
      setOpenId(null);
      const saved = await commit(parsed.value);
      if (!saved) {
        // saveFieldValue 失败时已弹「保存失败」toast，这里不重复提示
        return;
      } else if (findCompanyEnvServerIssue(parsed.value)) {
        toast.warning("已导入，但有服务器缺环境或用户，SSH 无法选中，请在服务器小节补全");
      } else if (!isCompanyEnvConfigured(parsed.value)) {
        toast.warning("已导入，但未填可用的服务器/数据库等字段");
      } else if (parsed.warnings.length > 0) {
        toast.success(
          `环境配置已导入（跳过 ${parsed.warnings.length} 处无效字段）`,
        );
      } else {
        toast.success("环境配置已导入");
      }
    } catch (err) {
      toast.error(
        `导入失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setImporting(false);
    }
  };

  const handleExport = async () => {
    // S13-10：导出文件含明文密码（跨机器迁移 / 发给同事一键导入就是靠它），导出前明示风险
    const ok = await confirm({
      title: "导出包含明文密码",
      description:
        "导出的 company-env.json 里服务器 / 数据库等密码是明文，请勿发到公开渠道或提交进仓库。",
      confirmLabel: "仍然导出",
    });
    if (!ok) return;
    const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "company-env.json";
    a.click();
    URL.revokeObjectURL(url);
    toast.success("已导出");
  };

  const handleCopyTemplate = async () => {
    try {
      await navigator.clipboard.writeText(companyEnvTemplateJson());
      toast.success("模板已复制");
    } catch {
      toast.error("复制失败");
    }
  };

  const servers = value.servers;
  const pgList = value.pg;
  const redisList = value.redis;
  const nacosList = value.nacos;
  const elkList = value.elk;
  const slsList = value.sls ?? [];
  const httpApis = value.httpApis ?? [];

  // 各含密码小节的稳定行 key（S13-17：不能用下标，否则删行后密码框「显示」状态串到别的行）
  const serverKeys = useStableRowKeys(servers, stableKey);
  const pgKeys = useStableRowKeys(pgList, stableKey);
  const redisKeys = useStableRowKeys(redisList, stableKey);
  const xxlKeys = useStableRowKeys(value.xxljob, stableKey);
  const nacosKeys = useStableRowKeys(nacosList, stableKey);
  const elkKeys = useStableRowKeys(elkList, stableKey);
  const slsKeys = useStableRowKeys(slsList, stableKey);

  const removeRow = useRemoveRow();

  const sStat = serverSummary(servers);
  const pStat = pgSummary(pgList);
  const rStat = redisSummary(redisList);
  const cStat = customSummary(value.custom);
  const xStat = xxlSummary(value.xxljob);
  const nStat = nacosSummary(nacosList);
  const eStat = elkSummary(elkList);
  const slsStat = slsSummary(slsList);
  const hStat = httpApiSummary(httpApis);

  return (
    <>
      {/* 连接卡内子区块：标题行 + 三按钮 + 折叠小节列表 */}
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm">环境配置</div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              排查类 action 使用；导出可发给同事一键导入
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={importing}
              onClick={() => void handleImport()}
            >
              <FileUp />
              导入
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void handleExport()}
            >
              <Download />
              导出
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setTemplateOpen(true)}
            >
              <Eye />
              预览模板
            </Button>
          </div>
        </div>

        {/* overflow-hidden：hover 行背景铺满整宽、首末行被容器圆角裁切 */}
        <div className="overflow-hidden rounded-md border border-border/60">
          <EnvSection
            id="servers"
            icon={Server}
            title="服务器"
            configured={sStat.configured}
            summary={sStat.summary}
            open={openId === "servers"}
            onToggle={toggle}
          >
            <div className="space-y-2">
              {servers.map((s, i) => {
                const rowIssue = findCompanyEnvServerRowIssue(s);
                return (
                  <InstanceCard key={serverKeys[i]}>
                    <div className="flex flex-wrap items-end gap-1.5">
                      <MiniField
                        label="环境"
                        className={ENV_FIELD_CLASS}
                      >
                        <Combobox
                          value={s.env}
                          onValueChange={(env) => {
                            const next: CompanyEnvServer[] = servers.map(
                              (row, j) => (j === i ? { ...row, env } : row),
                            );
                            commit({ ...value, servers: next });
                          }}
                          options={ENV_OPTIONS}
                          placeholder="请选择"
                          allowCustom
                          className="h-8 w-full"
                        />
                      </MiniField>
                      <MiniField
                        label="主机"
                        className="min-w-0 flex-1 space-y-0.5"
                      >
                        <Input
                          value={s.host}
                          onChange={(e) => {
                            const next = servers.map((row, j) =>
                              j === i ? { ...row, host: e.target.value } : row,
                            );
                            patch({ servers: next });
                          }}
                          onBlur={() => persist(value)}
                          className="h-8 font-mono text-xs"
                        />
                      </MiniField>
                      <Tooltip content="删除">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-8"
                          aria-label={removeInstanceLabel("服务器", i, s.env)}
                          onClick={() =>
                            void removeRow("服务器", s.host, s, () =>
                              commit({
                                ...value,
                                servers: servers.filter((_, j) => j !== i),
                              }),
                            )
                          }
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </Tooltip>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <MiniField
                        label="端口"
                        className="w-20 shrink-0 space-y-0.5"
                      >
                        <IntInput
                          label="端口"
                          value={s.port}
                          min={PORT_MIN}
                          max={PORT_MAX}
                          fallback={22}
                          onCommit={(port) =>
                            commit({
                              ...value,
                              servers: servers.map((row, j) =>
                                j === i ? { ...row, port } : row,
                              ),
                            })
                          }
                          className="h-8"
                        />
                      </MiniField>
                      <MiniField label="用户">
                        <Input
                          value={s.user}
                          onChange={(e) => {
                            const next = servers.map((row, j) =>
                              j === i ? { ...row, user: e.target.value } : row,
                            );
                            patch({ servers: next });
                          }}
                          onBlur={() => persist(value)}
                          className="h-8"
                        />
                      </MiniField>
                      <MiniField label="密码">
                        <PasswordInput
                          value={s.password}
                          onChange={(e) => {
                            const next = servers.map((row, j) =>
                              j === i
                                ? { ...row, password: e.target.value }
                                : row,
                            );
                            patch({ servers: next });
                          }}
                          onBlur={() => persist(value)}
                          autoComplete="off"
                          className="h-8"
                        />
                      </MiniField>
                    </div>
                    {/* 缺项只提示不拦保存（S13-02）：SSH 选不中 / 连不上，但其它小节照常存 */}
                    {rowIssue ? (
                      <p className="text-[11px] text-warning">
                        {rowIssue === "missing-env"
                          ? "缺环境名：SSH 无法选中这台"
                          : "缺用户：SSH 无法连接这台"}
                      </p>
                    ) : null}
                  </InstanceCard>
                );
              })}
              <AddRowButton
                label="添加服务器"
                onClick={() => {
                  const row: CompanyEnvServer = {
                    env: "test",
                    host: "",
                    port: 22,
                    user: "",
                    password: "",
                  };
                  commit({ ...value, servers: [...servers, row] });
                }}
              />
            </div>
          </EnvSection>

          <EnvSection
            id="pg"
            icon={Database}
            title="PostgreSQL"
            configured={pStat.configured}
            summary={pStat.summary}
            open={openId === "pg"}
            onToggle={toggle}
          >
            <div className="space-y-2">
              {pgList.map((p, i) => {
                const patchPg = (next: CompanyEnvPg) =>
                  patch({ pg: pgList.map((row, j) => (j === i ? next : row)) });
                const commitPg = (next: CompanyEnvPg) =>
                  commit({
                    ...value,
                    pg: pgList.map((row, j) => (j === i ? next : row)),
                  });
                return (
                  <InstanceCard key={pgKeys[i]}>
                    <div className="flex flex-wrap items-end gap-1.5">
                      <InstanceCardHeader
                        env={p.env}
                        onEnvChange={(env) => commitPg({ ...p, env })}
                      />
                      <MiniField
                        label="主机"
                        className="min-w-0 flex-1 space-y-0.5"
                      >
                        <Input
                          value={p.host}
                          onChange={(e) =>
                            patchPg({ ...p, host: e.target.value })
                          }
                          onBlur={() => persist(value)}
                          className="h-8 font-mono text-xs"
                        />
                      </MiniField>
                      <InstanceRowEnd
                        readonly={p.readonly}
                        onReadonlyChange={(readonly) =>
                          commitPg({ ...p, readonly })
                        }
                        onRemove={() =>
                          void removeRow("PostgreSQL 实例", p.host, p, () =>
                            commit({
                              ...value,
                              pg: pgList.filter((_, j) => j !== i),
                            }),
                          )
                        }
                        removeLabel={removeInstanceLabel("PostgreSQL 实例", i, p.env)}
                      />
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <MiniField
                        label="端口"
                        className="w-20 shrink-0 space-y-0.5"
                      >
                        <IntInput
                          label="端口"
                          value={p.port}
                          min={PORT_MIN}
                          max={PORT_MAX}
                          fallback={5432}
                          onCommit={(port) => commitPg({ ...p, port })}
                          className="h-8"
                        />
                      </MiniField>
                      <MiniField label="用户">
                        <Input
                          value={p.user}
                          onChange={(e) =>
                            patchPg({ ...p, user: e.target.value })
                          }
                          onBlur={() => persist(value)}
                          className="h-8"
                        />
                      </MiniField>
                      <MiniField label="密码">
                        <PasswordInput
                          value={p.password}
                          onChange={(e) =>
                            patchPg({ ...p, password: e.target.value })
                          }
                          onBlur={() => persist(value)}
                          autoComplete="off"
                          className="h-8"
                        />
                      </MiniField>
                    </div>
                  </InstanceCard>
                );
              })}
              <AddRowButton
                label="添加实例"
                onClick={() => {
                  const row: CompanyEnvPg = {
                    env: "test",
                    host: "",
                    port: 5432,
                    user: "",
                    password: "",
                    readonly: true,
                  };
                  commit({ ...value, pg: [...pgList, row] });
                }}
              />
            </div>
          </EnvSection>

          <EnvSection
            id="redis"
            icon={Boxes}
            title="Redis"
            configured={rStat.configured}
            summary={rStat.summary}
            open={openId === "redis"}
            onToggle={toggle}
          >
            <div className="space-y-2">
              {redisList.map((r, i) => {
                const patchRedis = (next: CompanyEnvRedis) =>
                  patch({
                    redis: redisList.map((row, j) => (j === i ? next : row)),
                  });
                const commitRedis = (next: CompanyEnvRedis) =>
                  commit({
                    ...value,
                    redis: redisList.map((row, j) => (j === i ? next : row)),
                  });
                return (
                  <InstanceCard key={redisKeys[i]}>
                    <div className="flex flex-wrap items-end gap-1.5">
                      <InstanceCardHeader
                        env={r.env}
                        onEnvChange={(env) => commitRedis({ ...r, env })}
                      />
                      <MiniField
                        label="主机"
                        className="min-w-0 flex-1 space-y-0.5"
                      >
                        <Input
                          value={r.host}
                          onChange={(e) =>
                            patchRedis({ ...r, host: e.target.value })
                          }
                          onBlur={() => persist(value)}
                          className="h-8 font-mono text-xs"
                        />
                      </MiniField>
                      <InstanceRowEnd
                        readonly={r.readonly}
                        onReadonlyChange={(readonly) =>
                          commitRedis({ ...r, readonly })
                        }
                        onRemove={() =>
                          void removeRow("Redis 实例", r.host, r, () =>
                            commit({
                              ...value,
                              redis: redisList.filter((_, j) => j !== i),
                            }),
                          )
                        }
                        removeLabel={removeInstanceLabel("Redis 实例", i, r.env)}
                      />
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <MiniField
                        label="端口"
                        className="w-20 shrink-0 space-y-0.5"
                      >
                        <IntInput
                          label="端口"
                          value={r.port}
                          min={PORT_MIN}
                          max={PORT_MAX}
                          fallback={6379}
                          onCommit={(port) => commitRedis({ ...r, port })}
                          className="h-8"
                        />
                      </MiniField>
                      <MiniField
                        label="DB"
                        className="w-16 shrink-0 space-y-0.5"
                      >
                        <IntInput
                          label="DB"
                          value={r.db}
                          min={0}
                          max={1023}
                          fallback={0}
                          onCommit={(db) => commitRedis({ ...r, db })}
                          className="h-8"
                        />
                      </MiniField>
                      <MiniField label="密码">
                        <PasswordInput
                          value={r.password}
                          onChange={(e) =>
                            patchRedis({ ...r, password: e.target.value })
                          }
                          onBlur={() => persist(value)}
                          autoComplete="off"
                          className="h-8"
                        />
                      </MiniField>
                    </div>
                  </InstanceCard>
                );
              })}
              <AddRowButton
                label="添加实例"
                onClick={() => {
                  const row: CompanyEnvRedis = {
                    env: "test",
                    host: "",
                    port: 6379,
                    db: 0,
                    password: "",
                    readonly: true,
                  };
                  commit({ ...value, redis: [...redisList, row] });
                }}
              />
            </div>
          </EnvSection>

          <EnvSection
            id="xxljob"
            icon={Timer}
            title="XXL-Job"
            configured={xStat.configured}
            summary={xStat.summary}
            open={openId === "xxljob"}
            onToggle={toggle}
          >
            <div className="space-y-2">
              {value.xxljob.map((x, i) => {
                const patchXxl = (next: CompanyEnvXxlJob) =>
                  patch({
                    xxljob: value.xxljob.map((row, j) =>
                      j === i ? next : row,
                    ),
                  });
                const commitXxl = (next: CompanyEnvXxlJob) =>
                  commit({
                    ...value,
                    xxljob: value.xxljob.map((row, j) =>
                      j === i ? next : row,
                    ),
                  });
                return (
                  <InstanceCard key={xxlKeys[i]}>
                    <div className="flex flex-wrap gap-1.5">
                      <MiniField
                        label="环境"
                        className={ENV_FIELD_CLASS}
                      >
                        <Combobox
                          value={x.env}
                          onValueChange={(env) => commitXxl({ ...x, env })}
                          options={ENV_OPTIONS}
                          placeholder="请选择"
                          allowCustom
                          className="h-8 w-full"
                        />
                      </MiniField>
                      <MiniField
                        label="Base URL"
                        className="min-w-[10rem] flex-[2] space-y-0.5"
                      >
                        <Input
                          value={x.baseUrl}
                          onChange={(e) =>
                            patchXxl({ ...x, baseUrl: e.target.value })
                          }
                          onBlur={() => persist(value)}
                          className="h-8 font-mono text-xs"
                        />
                      </MiniField>
                      {/* 只读逐条一份——与 PG / Nacos 的实例卡同款位置 */}
                      <div className="mt-4 flex h-8 shrink-0 items-center gap-1.5">
                        <span className="text-[11px] text-muted-foreground">
                          只读
                        </span>
                        <Switch
                          checked={x.readonly !== false}
                          onCheckedChange={(readonly) =>
                            commit({
                              ...value,
                              xxljob: value.xxljob.map((row, j) =>
                                j === i ? { ...row, readonly } : row,
                              ),
                            })
                          }
                        />
                      </div>
                      <Tooltip content="删除">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="mt-4 size-8 shrink-0"
                          aria-label={removeInstanceLabel("XXL-Job 环境", i, x.env)}
                          onClick={() =>
                            void removeRow("XXL-Job 环境", x.baseUrl, x, () =>
                              commit({
                                ...value,
                                xxljob: value.xxljob.filter((_, j) => j !== i),
                              }),
                            )
                          }
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </Tooltip>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <MiniField label="用户名">
                        <Input
                          value={x.username}
                          onChange={(e) =>
                            patchXxl({ ...x, username: e.target.value })
                          }
                          onBlur={() => persist(value)}
                          className="h-8"
                        />
                      </MiniField>
                      <MiniField label="密码">
                        <PasswordInput
                          value={x.password}
                          onChange={(e) =>
                            patchXxl({ ...x, password: e.target.value })
                          }
                          onBlur={() => persist(value)}
                          autoComplete="off"
                          className="h-8"
                        />
                      </MiniField>
                    </div>
                  </InstanceCard>
                );
              })}
              <AddRowButton
                label="添加环境"
                onClick={() => {
                  const row: CompanyEnvXxlJob = {
                    env: "test",
                    baseUrl: "",
                    username: "",
                    password: "",
                    readonly: isXxljobReadonly(value.xxljob),
                  };
                  commit({ ...value, xxljob: [...value.xxljob, row] });
                }}
              />
            </div>
          </EnvSection>

          <EnvSection
            id="nacos"
            icon={Layers}
            title="Nacos"
            configured={nStat.configured}
            summary={nStat.summary}
            open={openId === "nacos"}
            onToggle={toggle}
          >
            <div className="space-y-2">
              {nacosList.map((n, i) => {
                const patchNacos = (next: CompanyEnvNacos) =>
                  patch({
                    nacos: nacosList.map((row, j) => (j === i ? next : row)),
                  });
                const commitNacos = (next: CompanyEnvNacos) =>
                  commit({
                    ...value,
                    nacos: nacosList.map((row, j) => (j === i ? next : row)),
                  });
                return (
                  <InstanceCard key={nacosKeys[i]}>
                    <div className="flex flex-wrap items-end gap-1.5">
                      <InstanceCardHeader
                        env={n.env}
                        onEnvChange={(env) => commitNacos({ ...n, env })}
                      />
                      <MiniField
                        label="Base URL"
                        className="min-w-0 flex-1 space-y-0.5"
                      >
                        <Input
                          value={n.baseUrl}
                          onChange={(e) =>
                            patchNacos({ ...n, baseUrl: e.target.value })
                          }
                          onBlur={() => persist(value)}
                          className="h-8 font-mono text-xs"
                        />
                      </MiniField>
                      <InstanceRowEnd
                        readonly={n.readonly}
                        onReadonlyChange={(readonly) =>
                          commitNacos({ ...n, readonly })
                        }
                        onRemove={() =>
                          void removeRow("Nacos 集群", n.baseUrl, n, () =>
                            commit({
                              ...value,
                              nacos: nacosList.filter((_, j) => j !== i),
                            }),
                          )
                        }
                        removeLabel={removeInstanceLabel("Nacos 集群", i, n.env)}
                      />
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <MiniField label="用户名">
                        <Input
                          value={n.username}
                          onChange={(e) =>
                            patchNacos({ ...n, username: e.target.value })
                          }
                          onBlur={() => persist(value)}
                          className="h-8"
                        />
                      </MiniField>
                      <MiniField label="密码">
                        <PasswordInput
                          value={n.password}
                          onChange={(e) =>
                            patchNacos({ ...n, password: e.target.value })
                          }
                          onBlur={() => persist(value)}
                          autoComplete="off"
                          className="h-8"
                        />
                      </MiniField>
                    </div>
                    <div className="space-y-1">
                      <div className="text-[11px] text-muted-foreground">
                        命名空间
                      </div>
                      <StringListEditor
                        lines={n.namespaces}
                        addLabel="添加命名空间"
                        itemName="命名空间"
                        onChange={(namespaces) =>
                          patchNacos({ ...n, namespaces })
                        }
                        onCommit={(namespaces) =>
                          commitNacos({ ...n, namespaces })
                        }
                      />
                    </div>
                  </InstanceCard>
                );
              })}
              <AddRowButton
                label="添加集群"
                onClick={() => {
                  const row: CompanyEnvNacos = {
                    env: "test",
                    baseUrl: "",
                    username: "",
                    password: "",
                    namespaces: [],
                    readonly: true,
                  };
                  commit({ ...value, nacos: [...nacosList, row] });
                }}
              />
            </div>
          </EnvSection>

          <EnvSection
            id="elk"
            icon={HardDrive}
            title="ELK"
            configured={eStat.configured}
            summary={eStat.summary}
            open={openId === "elk"}
            onToggle={toggle}
          >
            <div className="space-y-2">
              {elkList.map((e, i) => {
                const patchElk = (next: CompanyEnvElk) =>
                  patch({
                    elk: elkList.map((row, j) => (j === i ? next : row)),
                  });
                const commitElk = (next: CompanyEnvElk) =>
                  commit({
                    ...value,
                    elk: elkList.map((row, j) => (j === i ? next : row)),
                  });
                return (
                  <InstanceCard key={elkKeys[i]}>
                    <div className="flex flex-wrap items-end gap-1.5">
                      <InstanceCardHeader
                        env={e.env}
                        onEnvChange={(env) => commitElk({ ...e, env })}
                      />
                      <MiniField
                        label="Base URL"
                        className="min-w-0 flex-1 space-y-0.5"
                      >
                        <Input
                          value={e.baseUrl}
                          onChange={(ev) =>
                            patchElk({ ...e, baseUrl: ev.target.value })
                          }
                          onBlur={() => persist(value)}
                          className="h-8 font-mono text-xs"
                        />
                      </MiniField>
                      <InstanceRowEnd
                        onRemove={() =>
                          void removeRow("ELK 实例", e.baseUrl, e, () =>
                            commit({
                              ...value,
                              elk: elkList.filter((_, j) => j !== i),
                            }),
                          )
                        }
                        removeLabel={removeInstanceLabel("ELK 实例", i, e.env)}
                      />
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <MiniField label="用户名">
                        <Input
                          value={e.username}
                          onChange={(ev) =>
                            patchElk({ ...e, username: ev.target.value })
                          }
                          onBlur={() => persist(value)}
                          className="h-8"
                        />
                      </MiniField>
                      <MiniField label="密码">
                        <PasswordInput
                          value={e.password}
                          onChange={(ev) =>
                            patchElk({ ...e, password: ev.target.value })
                          }
                          onBlur={() => persist(value)}
                          autoComplete="off"
                          className="h-8"
                        />
                      </MiniField>
                    </div>
                  </InstanceCard>
                );
              })}
              <AddRowButton
                label="添加实例"
                onClick={() => {
                  const row: CompanyEnvElk = {
                    env: "test",
                    baseUrl: "",
                    username: "",
                    password: "",
                    dataView: "",
                  };
                  commit({ ...value, elk: [...elkList, row] });
                }}
              />
            </div>
          </EnvSection>

          <EnvSection
            id="sls"
            icon={ScrollText}
            title="SLS"
            configured={slsStat.configured}
            summary={slsStat.summary}
            open={openId === "sls"}
            onToggle={toggle}
          >
            <div className="space-y-2">
              {slsList.map((s, i) => {
                const patchSls = (next: CompanyEnvSls) =>
                  patch({
                    sls: slsList.map((row, j) => (j === i ? next : row)),
                  });
                const commitSls = (next: CompanyEnvSls) =>
                  commit({
                    ...value,
                    sls: slsList.map((row, j) => (j === i ? next : row)),
                  });
                return (
                  <InstanceCard key={slsKeys[i]}>
                    <div className="flex flex-wrap items-end gap-1.5">
                      <InstanceCardHeader
                        env={s.env}
                        onEnvChange={(env) => commitSls({ ...s, env })}
                      />
                      <MiniField
                        label="Endpoint"
                        className="min-w-0 flex-1 space-y-0.5"
                      >
                        <Input
                          value={s.endpoint}
                          onChange={(ev) =>
                            patchSls({ ...s, endpoint: ev.target.value })
                          }
                          onBlur={() => persist(value)}
                          className="h-8 font-mono text-xs"
                        />
                      </MiniField>
                      <InstanceRowEnd
                        onRemove={() =>
                          void removeRow("SLS 实例", s.project, s, () =>
                            commit({
                              ...value,
                              sls: slsList.filter((_, j) => j !== i),
                            }),
                          )
                        }
                        removeLabel={removeInstanceLabel("SLS 实例", i, s.env)}
                      />
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <MiniField label="Project">
                        <Input
                          value={s.project}
                          onChange={(ev) =>
                            patchSls({ ...s, project: ev.target.value })
                          }
                          onBlur={() => persist(value)}
                          className="h-8 font-mono text-xs"
                        />
                      </MiniField>
                      <MiniField label="AccessKey ID">
                        <Input
                          value={s.accessKeyId}
                          onChange={(ev) =>
                            patchSls({ ...s, accessKeyId: ev.target.value })
                          }
                          onBlur={() => persist(value)}
                          className="h-8 font-mono text-xs"
                        />
                      </MiniField>
                      <MiniField label="AccessKey Secret">
                        <PasswordInput
                          value={s.accessKeySecret}
                          onChange={(ev) =>
                            patchSls({
                              ...s,
                              accessKeySecret: ev.target.value,
                            })
                          }
                          onBlur={() => persist(value)}
                          autoComplete="off"
                          className="h-8"
                        />
                      </MiniField>
                    </div>
                  </InstanceCard>
                );
              })}
              <AddRowButton
                label="添加实例"
                onClick={() => {
                  const row: CompanyEnvSls = {
                    env: "test",
                    endpoint: "",
                    project: "",
                    accessKeyId: "",
                    accessKeySecret: "",
                  };
                  commit({ ...value, sls: [...slsList, row] });
                }}
              />
            </div>
          </EnvSection>

          <EnvSection
            id="httpApis"
            icon={Globe}
            title="HTTP API"
            configured={hStat.configured}
            summary={hStat.summary}
            open={openId === "httpApis"}
            onToggle={toggle}
          >
            <div className="space-y-2">
              {httpApis.map((h, i) => {
                const patchApi = (next: CompanyEnvHttpApi) => {
                  const list = httpApis.map((row, j) => (j === i ? next : row));
                  patch({ httpApis: list });
                };
                const commitApi = (next: CompanyEnvHttpApi) => {
                  commit({
                    ...value,
                    httpApis: httpApis.map((row, j) => (j === i ? next : row)),
                  });
                };
                return (
                  <InstanceCard key={i}>
                    <div className="flex flex-wrap items-end gap-1.5">
                      <MiniField
                        label="环境"
                        className={ENV_FIELD_CLASS}
                      >
                        <Combobox
                          value={h.env}
                          onValueChange={(env) => commitApi({ ...h, env })}
                          options={ENV_OPTIONS}
                          placeholder="请选择"
                          allowCustom
                          className="h-8 w-full"
                        />
                      </MiniField>
                      <MiniField
                        label="URL"
                        className="min-w-0 flex-1 space-y-0.5"
                      >
                        <Input
                          value={h.url}
                          onChange={(e) =>
                            patchApi({ ...h, url: e.target.value })
                          }
                          onBlur={() => persist(value)}
                          className="h-8 font-mono text-xs"
                        />
                      </MiniField>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8 shrink-0 text-muted-foreground"
                        aria-label="删除"
                        onClick={() =>
                          void removeRow("HTTP API", h.url, h, () =>
                            commit({
                              ...value,
                              httpApis: httpApis.filter((_, j) => j !== i),
                            }),
                          )
                        }
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                    <div className="">
                      <div className="text-[11px] text-muted-foreground">
                        备注
                      </div>
                      <Textarea
                        value={h.note ?? ""}
                        onChange={(e) =>
                          patchApi({
                            ...h,
                            note: e.target.value || undefined,
                          })
                        }
                        onBlur={() => persist(value)}
                        placeholder="给 AI 看的用法提示，选填；鉴权方式（登录接口、token 取值）也写这里"
                        className="min-h-14 text-xs"
                      />
                    </div>
                  </InstanceCard>
                );
              })}
              <AddRowButton
                label="添加 API"
                onClick={() => {
                  const row: CompanyEnvHttpApi = {
                    env: "test",
                    url: "",
                  };
                  commit({ ...value, httpApis: [...httpApis, row] });
                }}
              />
            </div>
          </EnvSection>

          <EnvSection
            id="custom"
            icon={ClipboardList}
            title="自定义"
            subtitle="自由填写：路径模板 / 约定等任意信息（{project} 占位符 AI 会自动替换）"
            configured={cStat.configured}
            summary={cStat.summary}
            open={openId === "custom"}
            onToggle={toggle}
          >
            <div className="space-y-2">
              {value.custom.map((c, i) => {
                const patchCustom = (next: CompanyEnvCustom) =>
                  patch({
                    custom: value.custom.map((row, j) =>
                      j === i ? next : row,
                    ),
                  });
                return (
                  <InstanceCard key={i}>
                    <div className="flex flex-wrap gap-1.5">
                      <MiniField label="名称" className="min-w-[10rem] flex-[1] space-y-0.5">
                        <Input
                          value={c.name}
                          placeholder="如：日志路径模板"
                          onChange={(e) =>
                            patchCustom({ ...c, name: e.target.value })
                          }
                          onBlur={() => persist(value)}
                          className="h-8"
                        />
                      </MiniField>
                      <div className="w-full">
                        <MiniField label="内容（可多行，{project} 等占位符 AI 会自动替换）">
                          <Textarea
                            value={c.content}
                            rows={2}
                            onChange={(e) =>
                              patchCustom({ ...c, content: e.target.value })
                            }
                            onBlur={() => persist(value)}
                            className="min-h-8 resize-y font-mono text-xs"
                          />
                        </MiniField>
                      </div>
                      <div className="flex w-full justify-end">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label="删除"
                          onClick={() =>
                            void removeRow("自定义条目", c.name, c, () =>
                              commit({
                                ...value,
                                custom: value.custom.filter((_, j) => j !== i),
                              }),
                            )
                          }
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </div>
                  </InstanceCard>
                );
              })}
              <AddRowButton
                label="添加条目"
                onClick={() => {
                  const row: CompanyEnvCustom = { name: "", content: "" };
                  commit({ ...value, custom: [...value.custom, row] });
                }}
              />
            </div>
          </EnvSection>
        </div>
      </div>

      <Dialog open={templateOpen} onOpenChange={setTemplateOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>环境配置模板</DialogTitle>
          </DialogHeader>
          <pre className="max-h-80 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs wrap-anywhere">
            {companyEnvTemplateJson()}
          </pre>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleCopyTemplate}>
              <Copy />
              复制
            </Button>
            <Button type="button" onClick={() => setTemplateOpen(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
