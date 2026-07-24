"use client";

/**
 * 「环境配置」节（并入设置页「连接」卡尾部）
 *
 * 折叠小节 + 状态摘要：默认全部收起，一眼扫绿/灰点；点开再编表单。
 * 服务器 / PG / XXL / Nacos / ELK / HTTP API 本质是外部服务凭据，与 API Key / GitLab / 飞书同属「连接」。
 */

import {
  ChevronDown,
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
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  companyEnvTemplateJson,
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
  CompanyEnvHttpApiAuth,
  CompanyEnvNacos,
  CompanyEnvPg,
  CompanyEnvServer,
  CompanyEnvXxlJob,
} from "@/lib/types";

type SectionId =
  | "servers"
  | "pg"
  | "logs"
  | "xxljob"
  | "nacos"
  | "elk"
  | "httpApis";

interface CompanyEnvSectionProps {
  value: CompanyEnv;
  /** 草稿变更（输入中） */
  onChange: (next: CompanyEnv) => void;
  /** 落盘（失焦 / 增删 / 导入） */
  onCommit: (next: CompanyEnv) => void;
}

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
    {children}
  </label>
);

/** 小节顶部「只读」开关（软约束落盘 + brief；无多余说明） */
const ReadonlySwitchRow = ({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
}) => (
  <div className="flex items-center justify-between gap-3">
    <span className="text-sm">只读</span>
    <Switch checked={checked} onCheckedChange={onCheckedChange} />
  </div>
);

const emptyHttpAuth = (type: CompanyEnvHttpApiAuth["type"]): CompanyEnvHttpApiAuth => {
  if (type === "header") {
    return { type: "header", headerName: "", headerValue: "" };
  }
  if (type === "login") {
    return {
      type: "login",
      loginUrl: "",
      username: "",
      password: "",
      tokenPath: "token",
      authHeaderName: "Authorization",
      authHeaderTemplate: "Bearer {token}",
    };
  }
  return { type: "none" };
};

/** 认证方式下拉展示文案（SelectValue 不自动取 Item 中文，需显式映射） */
const HTTP_AUTH_TYPE_LABEL: Record<CompanyEnvHttpApiAuth["type"], string> = {
  none: "无",
  header: "固定 Header",
  login: "登录换 token",
};

/** 逐条字符串列表（替代大 textarea）：每行 Input + 删 X + 底部添加 */
const StringListEditor = ({
  lines,
  onChange,
  onCommit,
  placeholder,
  addLabel = "添加",
}: {
  lines: string[];
  /** 输入中改草稿 */
  onChange: (next: string[]) => void;
  /** 失焦 / 增删 落盘 */
  onCommit: (next: string[]) => void;
  placeholder?: string;
  addLabel?: string;
}) => (
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
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 text-muted-foreground"
          title="删除"
          onClick={() => onCommit(lines.filter((_, j) => j !== i))}
        >
          <X className="size-3.5" />
        </Button>
      </div>
    ))}
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 px-2 text-xs text-muted-foreground"
      onClick={() => onCommit([...lines, ""])}
    >
      <Plus className="size-3.5" />
      {addLabel}
    </Button>
  </div>
);

/** 折叠小节壳：收起 = 图标 + 名 + 状态摘要 + chevron */
const EnvSection = ({
  id,
  icon: Icon,
  title,
  configured,
  summary,
  open,
  onToggle,
  children,
}: {
  id: SectionId;
  icon: LucideIcon;
  title: string;
  configured: boolean;
  summary: string;
  open: boolean;
  onToggle: (id: SectionId) => void;
  children: ReactNode;
}) => (
  <div className="border-b last:border-b-0">
    <button
      type="button"
      className="flex w-full items-center gap-2.5 py-2.5 text-left transition-colors hover:bg-muted/40"
      onClick={() => onToggle(id)}
      aria-expanded={open}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
      <span className="flex min-w-0 max-w-[55%] items-center gap-1.5 shrink-0">
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            configured ? "bg-emerald-500" : "bg-muted-foreground/40",
          )}
          aria-hidden
        />
        <span
          className={cn(
            "truncate text-xs",
            configured ? "text-foreground/80" : "text-muted-foreground",
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
    {open ? <div className="space-y-2.5 pb-3 pl-6">{children}</div> : null}
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
  pg: CompanyEnvPg | undefined,
): { configured: boolean; summary: string } => {
  if (!pg?.host?.trim()) return { configured: false, summary: "未配置" };
  const n = pg.dbTemplates.filter((t) => t.trim()).length;
  return {
    configured: true,
    summary: n > 0 ? `${pg.host.trim()} · ${n} 库模板` : pg.host.trim(),
  };
};

const logsSummary = (
  lines: string[],
): { configured: boolean; summary: string } => {
  const n = lines.filter((s) => s.trim()).length;
  if (n === 0) return { configured: false, summary: "未配置" };
  return { configured: true, summary: `${n} 条路径` };
};

const xxlSummary = (
  rows: CompanyEnvXxlJob[],
): { configured: boolean; summary: string } => {
  const filled = rows.filter((x) => x.baseUrl.trim());
  if (filled.length === 0) return { configured: false, summary: "未配置" };
  return { configured: true, summary: `${filled.length} 个环境` };
};

const nacosSummary = (
  nacos: CompanyEnvNacos | undefined,
): { configured: boolean; summary: string } => {
  if (!nacos?.baseUrl?.trim()) return { configured: false, summary: "未配置" };
  const n = nacos.namespaces.filter((s) => s.trim()).length;
  return {
    configured: true,
    summary: n > 0 ? `已填 · ${n} 命名空间` : "host 已填",
  };
};

const elkSummary = (
  elk: CompanyEnvElk | undefined,
): { configured: boolean; summary: string } => {
  if (!elk?.baseUrl?.trim()) return { configured: false, summary: "未配置" };
  return {
    configured: true,
    summary: elk.dataView.trim() ? elk.dataView.trim() : "host 已填",
  };
};

const httpApiSummary = (
  rows: CompanyEnvHttpApi[],
): { configured: boolean; summary: string } => {
  const filled = rows.filter((h) => h.baseUrl.trim());
  if (filled.length === 0) return { configured: false, summary: "未配置" };
  return { configured: true, summary: `${filled.length} 条` };
};

export const CompanyEnvSection = ({
  value,
  onChange,
  onCommit,
}: CompanyEnvSectionProps) => {
  // 导入飞行中（防双击）
  const [importing, setImporting] = useState(false);
  // 模板预览 dialog
  const [templateOpen, setTemplateOpen] = useState(false);
  // 当前展开的小节（默认全收起；同时只开一个，扫完再编）
  const [openId, setOpenId] = useState<SectionId | null>(null);

  const commit = (next: CompanyEnv) => {
    onChange(next);
    onCommit(next);
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
      // 导入后保持收起——摘要变绿即感知生效
      setOpenId(null);
      commit(parsed.value);
      if (!isCompanyEnvConfigured(parsed.value)) {
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

  const handleExport = () => {
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
  const pg = value.pg ?? {
    host: "",
    port: 5432,
    user: "",
    password: "",
    dbTemplates: [],
    readonly: true,
  };
  const nacos = value.nacos ?? {
    baseUrl: "",
    username: "",
    password: "",
    namespaces: [],
    readonly: true,
  };
  const elk = value.elk ?? {
    baseUrl: "",
    username: "",
    password: "",
    dataView: "",
  };

  const httpApis = value.httpApis ?? [];

  const sStat = serverSummary(servers);
  const pStat = pgSummary(value.pg);
  const lStat = logsSummary(value.logPathTemplates);
  const xStat = xxlSummary(value.xxljob);
  const nStat = nacosSummary(value.nacos);
  const eStat = elkSummary(value.elk);
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
              onClick={handleExport}
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

        <div className="rounded-md border border-border/60 px-3">
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
              {servers.map((s, i) => (
                <div
                  key={i}
                  className="space-y-1.5 rounded-md border border-border/60 bg-muted/20 p-2.5"
                >
                  <div className="flex flex-wrap gap-1.5">
                    <MiniField label="名称">
                      <Input
                        value={s.name}
                        onChange={(e) => {
                          const next = servers.map((row, j) =>
                            j === i ? { ...row, name: e.target.value } : row,
                          );
                          patch({ servers: next });
                        }}
                        onBlur={() => onCommit(value)}
                        className="h-8"
                      />
                    </MiniField>
                    <MiniField
                      label="环境"
                      className="w-24 shrink-0 space-y-0.5"
                    >
                      <Select
                        value={s.env}
                        onValueChange={(v) => {
                          const env: CompanyEnvServer["env"] =
                            v === "dev" ? "dev" : "test";
                          const next: CompanyEnvServer[] = servers.map(
                            (row, j) => (j === i ? { ...row, env } : row),
                          );
                          commit({ ...value, servers: next });
                        }}
                      >
                        <SelectTrigger className="h-8 w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="test">test</SelectItem>
                          <SelectItem value="dev">dev</SelectItem>
                        </SelectContent>
                      </Select>
                    </MiniField>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="mt-4 size-8 shrink-0"
                      title="删除"
                      onClick={() => {
                        commit({
                          ...value,
                          servers: servers.filter((_, j) => j !== i),
                        });
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <MiniField label="主机">
                      <Input
                        value={s.host}
                        onChange={(e) => {
                          const next = servers.map((row, j) =>
                            j === i ? { ...row, host: e.target.value } : row,
                          );
                          patch({ servers: next });
                        }}
                        onBlur={() => onCommit(value)}
                        className="h-8 font-mono text-xs"
                      />
                    </MiniField>
                    <MiniField
                      label="端口"
                      className="w-20 shrink-0 space-y-0.5"
                    >
                      <Input
                        type="number"
                        value={s.port}
                        onChange={(e) => {
                          const port = Number(e.target.value) || 22;
                          const next = servers.map((row, j) =>
                            j === i ? { ...row, port } : row,
                          );
                          patch({ servers: next });
                        }}
                        onBlur={() => onCommit(value)}
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
                        onBlur={() => onCommit(value)}
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
                        onBlur={() => onCommit(value)}
                        autoComplete="off"
                        className="h-8"
                      />
                    </MiniField>
                  </div>
                </div>
              ))}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-muted-foreground"
                onClick={() => {
                  const row: CompanyEnvServer = {
                    name: "",
                    env: "test",
                    host: "",
                    port: 22,
                    user: "",
                    password: "",
                  };
                  commit({ ...value, servers: [...servers, row] });
                }}
              >
                <Plus className="size-3.5" />
                添加服务器
              </Button>
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
              <ReadonlySwitchRow
                checked={pg.readonly !== false}
                onCheckedChange={(checked) =>
                  commit({
                    ...value,
                    pg: { ...pg, readonly: checked },
                  })
                }
              />
              <div className="flex flex-wrap gap-1.5">
              <MiniField label="主机">
                <Input
                  value={pg.host}
                  onChange={(e) =>
                    patch({
                      pg: { ...pg, host: e.target.value } satisfies CompanyEnvPg,
                    })
                  }
                  onBlur={() => onCommit(value)}
                  className="h-8 font-mono text-xs"
                />
              </MiniField>
              <MiniField label="端口" className="w-20 shrink-0 space-y-0.5">
                <Input
                  type="number"
                  value={pg.port}
                  onChange={(e) =>
                    patch({
                      pg: { ...pg, port: Number(e.target.value) || 5432 },
                    })
                  }
                  onBlur={() => onCommit(value)}
                  className="h-8"
                />
              </MiniField>
              <MiniField label="用户">
                <Input
                  value={pg.user}
                  onChange={(e) =>
                    patch({ pg: { ...pg, user: e.target.value } })
                  }
                  onBlur={() => onCommit(value)}
                  className="h-8"
                />
              </MiniField>
              <MiniField label="密码">
                <PasswordInput
                  value={pg.password}
                  onChange={(e) =>
                    patch({ pg: { ...pg, password: e.target.value } })
                  }
                  onBlur={() => onCommit(value)}
                  autoComplete="off"
                  className="h-8"
                />
              </MiniField>
            </div>
            <div className="space-y-1">
              <div className="text-[11px] text-muted-foreground">库名模板</div>
              <StringListEditor
                lines={pg.dbTemplates}
                placeholder="{project}-test"
                addLabel="添加模板"
                onChange={(dbTemplates) =>
                  patch({ pg: { ...pg, dbTemplates } })
                }
                onCommit={(dbTemplates) =>
                  commit({ ...value, pg: { ...pg, dbTemplates } })
                }
              />
            </div>
            </div>
          </EnvSection>

          <EnvSection
            id="logs"
            icon={ScrollText}
            title="日志路径"
            configured={lStat.configured}
            summary={lStat.summary}
            open={openId === "logs"}
            onToggle={toggle}
          >
            <StringListEditor
              lines={value.logPathTemplates}
              placeholder="/apps/{project}/logs/console.log*"
              addLabel="添加路径"
              onChange={(logPathTemplates) => patch({ logPathTemplates })}
              onCommit={(logPathTemplates) =>
                commit({ ...value, logPathTemplates })
              }
            />
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
              <ReadonlySwitchRow
                checked={isXxljobReadonly(value.xxljob)}
                onCheckedChange={(checked) => {
                  commit({
                    ...value,
                    xxljob: value.xxljob.map((row) => ({
                      ...row,
                      readonly: checked,
                    })),
                  });
                }}
              />
              {value.xxljob.map((x, i) => (
                <div
                  key={i}
                  className="flex flex-wrap gap-1.5 rounded-md border border-border/60 bg-muted/20 p-2.5"
                >
                  <MiniField label="环境" className="w-24 shrink-0 space-y-0.5">
                    <Input
                      value={x.env}
                      onChange={(e) => {
                        const next = value.xxljob.map((row, j) =>
                          j === i ? { ...row, env: e.target.value } : row,
                        );
                        patch({ xxljob: next });
                      }}
                      onBlur={() => onCommit(value)}
                      className="h-8"
                    />
                  </MiniField>
                  <MiniField
                    label="Base URL"
                    className="min-w-[10rem] flex-[2] space-y-0.5"
                  >
                    <Input
                      value={x.baseUrl}
                      onChange={(e) => {
                        const next = value.xxljob.map((row, j) =>
                          j === i ? { ...row, baseUrl: e.target.value } : row,
                        );
                        patch({ xxljob: next });
                      }}
                      onBlur={() => onCommit(value)}
                      className="h-8 font-mono text-xs"
                    />
                  </MiniField>
                  <MiniField label="用户名">
                    <Input
                      value={x.username}
                      onChange={(e) => {
                        const next = value.xxljob.map((row, j) =>
                          j === i ? { ...row, username: e.target.value } : row,
                        );
                        patch({ xxljob: next });
                      }}
                      onBlur={() => onCommit(value)}
                      className="h-8"
                    />
                  </MiniField>
                  <MiniField label="密码">
                    <PasswordInput
                      value={x.password}
                      onChange={(e) => {
                        const next = value.xxljob.map((row, j) =>
                          j === i ? { ...row, password: e.target.value } : row,
                        );
                        patch({ xxljob: next });
                      }}
                      onBlur={() => onCommit(value)}
                      autoComplete="off"
                      className="h-8"
                    />
                  </MiniField>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="mt-4 size-8 shrink-0"
                    title="删除"
                    onClick={() => {
                      commit({
                        ...value,
                        xxljob: value.xxljob.filter((_, j) => j !== i),
                      });
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-muted-foreground"
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
              >
                <Plus className="size-3.5" />
                添加环境
              </Button>
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
              <ReadonlySwitchRow
                checked={nacos.readonly !== false}
                onCheckedChange={(checked) =>
                  commit({
                    ...value,
                    nacos: { ...nacos, readonly: checked },
                  })
                }
              />
              <div className="flex flex-wrap gap-1.5">
              <MiniField
                label="Base URL"
                className="min-w-[10rem] flex-[2] space-y-0.5"
              >
                <Input
                  value={nacos.baseUrl}
                  onChange={(e) =>
                    patch({
                      nacos: {
                        ...nacos,
                        baseUrl: e.target.value,
                      } satisfies CompanyEnvNacos,
                    })
                  }
                  onBlur={() => onCommit(value)}
                  className="h-8 font-mono text-xs"
                />
              </MiniField>
              <MiniField label="用户名">
                <Input
                  value={nacos.username}
                  onChange={(e) =>
                    patch({ nacos: { ...nacos, username: e.target.value } })
                  }
                  onBlur={() => onCommit(value)}
                  className="h-8"
                />
              </MiniField>
              <MiniField label="密码">
                <PasswordInput
                  value={nacos.password}
                  onChange={(e) =>
                    patch({ nacos: { ...nacos, password: e.target.value } })
                  }
                  onBlur={() => onCommit(value)}
                  autoComplete="off"
                  className="h-8"
                />
              </MiniField>
            </div>
            <div className="space-y-1">
              <div className="text-[11px] text-muted-foreground">命名空间</div>
              <StringListEditor
                lines={nacos.namespaces}
                addLabel="添加命名空间"
                onChange={(namespaces) =>
                  patch({ nacos: { ...nacos, namespaces } })
                }
                onCommit={(namespaces) =>
                  commit({ ...value, nacos: { ...nacos, namespaces } })
                }
              />
            </div>
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
            <div className="flex flex-wrap gap-1.5">
              <MiniField
                label="Base URL"
                className="min-w-[10rem] flex-[2] space-y-0.5"
              >
                <Input
                  value={elk.baseUrl}
                  onChange={(e) =>
                    patch({
                      elk: {
                        ...elk,
                        baseUrl: e.target.value,
                      } satisfies CompanyEnvElk,
                    })
                  }
                  onBlur={() => onCommit(value)}
                  className="h-8 font-mono text-xs"
                />
              </MiniField>
              <MiniField label="用户名">
                <Input
                  value={elk.username}
                  onChange={(e) =>
                    patch({ elk: { ...elk, username: e.target.value } })
                  }
                  onBlur={() => onCommit(value)}
                  className="h-8"
                />
              </MiniField>
              <MiniField label="密码">
                <PasswordInput
                  value={elk.password}
                  onChange={(e) =>
                    patch({ elk: { ...elk, password: e.target.value } })
                  }
                  onBlur={() => onCommit(value)}
                  autoComplete="off"
                  className="h-8"
                />
              </MiniField>
              <MiniField label="Data View">
                <Input
                  value={elk.dataView}
                  onChange={(e) =>
                    patch({ elk: { ...elk, dataView: e.target.value } })
                  }
                  onBlur={() => onCommit(value)}
                  className="h-8 font-mono text-xs"
                />
              </MiniField>
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
            <div className="space-y-3">
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
                const auth = h.auth;
                return (
                  <div
                    key={i}
                    className="space-y-1.5 rounded-md border border-border/60 p-2"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                        <MiniField label="名称">
                          <Input
                            value={h.name}
                            onChange={(e) =>
                              patchApi({ ...h, name: e.target.value })
                            }
                            onBlur={() => onCommit(value)}
                            placeholder="CRM"
                            className="h-8"
                          />
                        </MiniField>
                        <MiniField
                          label="环境"
                          className="w-24 shrink-0 space-y-0.5"
                        >
                          <Input
                            value={h.env}
                            onChange={(e) =>
                              patchApi({ ...h, env: e.target.value })
                            }
                            onBlur={() => onCommit(value)}
                            placeholder="test"
                            className="h-8"
                          />
                        </MiniField>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8 shrink-0 text-muted-foreground"
                        aria-label="删除"
                        onClick={() => {
                          commit({
                            ...value,
                            httpApis: httpApis.filter((_, j) => j !== i),
                          });
                        }}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                    <MiniField
                      label="Base URL"
                      className="min-w-0 w-full space-y-0.5"
                    >
                      <Input
                        value={h.baseUrl}
                        onChange={(e) =>
                          patchApi({ ...h, baseUrl: e.target.value })
                        }
                        onBlur={() => onCommit(value)}
                        className="h-8 font-mono text-xs"
                      />
                    </MiniField>
                    <MiniField
                      label="认证方式"
                      className="min-w-[8rem] space-y-0.5"
                    >
                      <Select
                        value={auth.type}
                        onValueChange={(v) => {
                          const type = (v ??
                            "none") as CompanyEnvHttpApiAuth["type"];
                          commitApi({ ...h, auth: emptyHttpAuth(type) });
                        }}
                      >
                        <SelectTrigger className="h-8">
                          <SelectValue>
                            {HTTP_AUTH_TYPE_LABEL[auth.type]}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">无</SelectItem>
                          <SelectItem value="header">固定 Header</SelectItem>
                          <SelectItem value="login">登录换 token</SelectItem>
                        </SelectContent>
                      </Select>
                    </MiniField>
                    {auth.type === "header" && (
                      <div className="flex flex-wrap gap-1.5">
                        <MiniField label="Header 名">
                          <Input
                            value={auth.headerName}
                            onChange={(e) =>
                              patchApi({
                                ...h,
                                auth: {
                                  type: "header",
                                  headerName: e.target.value,
                                  headerValue: auth.headerValue,
                                },
                              })
                            }
                            onBlur={() => onCommit(value)}
                            placeholder="Authorization"
                            className="h-8 font-mono text-xs"
                          />
                        </MiniField>
                        <MiniField
                          label="Header 值"
                          className="min-w-[10rem] flex-[2] space-y-0.5"
                        >
                          <PasswordInput
                            value={auth.headerValue}
                            onChange={(e) =>
                              patchApi({
                                ...h,
                                auth: {
                                  type: "header",
                                  headerName: auth.headerName,
                                  headerValue: e.target.value,
                                },
                              })
                            }
                            onBlur={() => onCommit(value)}
                            autoComplete="off"
                            className="h-8 font-mono text-xs"
                          />
                        </MiniField>
                      </div>
                    )}
                    {auth.type === "login" && (
                      <>
                        <MiniField
                          label="登录 URL"
                          className="min-w-0 w-full space-y-0.5"
                        >
                          <Input
                            value={auth.loginUrl}
                            onChange={(e) =>
                              patchApi({
                                ...h,
                                auth: { ...auth, loginUrl: e.target.value },
                              })
                            }
                            onBlur={() => onCommit(value)}
                            className="h-8 font-mono text-xs"
                          />
                        </MiniField>
                        <div className="flex flex-wrap gap-1.5">
                          <MiniField label="用户名">
                            <Input
                              value={auth.username}
                              onChange={(e) =>
                                patchApi({
                                  ...h,
                                  auth: { ...auth, username: e.target.value },
                                })
                              }
                              onBlur={() => onCommit(value)}
                              className="h-8"
                            />
                          </MiniField>
                          <MiniField label="密码">
                            <PasswordInput
                              value={auth.password}
                              onChange={(e) =>
                                patchApi({
                                  ...h,
                                  auth: { ...auth, password: e.target.value },
                                })
                              }
                              onBlur={() => onCommit(value)}
                              autoComplete="off"
                              className="h-8"
                            />
                          </MiniField>
                          <MiniField label="Token 路径">
                            <Input
                              value={auth.tokenPath}
                              onChange={(e) =>
                                patchApi({
                                  ...h,
                                  auth: { ...auth, tokenPath: e.target.value },
                                })
                              }
                              onBlur={() => onCommit(value)}
                              placeholder="token"
                              className="h-8 font-mono text-xs"
                            />
                          </MiniField>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          <MiniField label="Auth Header">
                            <Input
                              value={auth.authHeaderName}
                              onChange={(e) =>
                                patchApi({
                                  ...h,
                                  auth: {
                                    ...auth,
                                    authHeaderName: e.target.value,
                                  },
                                })
                              }
                              onBlur={() => onCommit(value)}
                              placeholder="Authorization"
                              className="h-8 font-mono text-xs"
                            />
                          </MiniField>
                          <MiniField
                            label="Header 模板"
                            className="min-w-[10rem] flex-[2] space-y-0.5"
                          >
                            <Input
                              value={auth.authHeaderTemplate}
                              onChange={(e) =>
                                patchApi({
                                  ...h,
                                  auth: {
                                    ...auth,
                                    authHeaderTemplate: e.target.value,
                                  },
                                })
                              }
                              onBlur={() => onCommit(value)}
                              placeholder="Bearer {token}"
                              className="h-8 font-mono text-xs"
                            />
                          </MiniField>
                        </div>
                      </>
                    )}
                    <div className="space-y-0.5">
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
                        onBlur={() => onCommit(value)}
                        placeholder="给 AI 看的用法提示，选填"
                        className="min-h-14 text-xs"
                      />
                    </div>
                  </div>
                );
              })}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => {
                  const row: CompanyEnvHttpApi = {
                    name: "",
                    env: "test",
                    baseUrl: "",
                    auth: emptyHttpAuth("none"),
                  };
                  commit({ ...value, httpApis: [...httpApis, row] });
                }}
              >
                <Plus className="size-3.5" />
                添加 API
              </Button>
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
