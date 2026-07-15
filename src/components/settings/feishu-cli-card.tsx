"use client";

/**
 * 「飞书集成」配置节（V0.12 P0；v1.0.x 设置整合：Card 壳退役、作为「连接」卡的一节）
 *
 * 内置两个官方 CLI（lark-cli 飞书开放平台 / meegle 飞书项目）的 安装 + 登录 + 状态。
 * 装完 agent 自动获得能力（官方 skills 注入 + PATH）、用户不用再懂 MCP。
 *
 * 交互：一键「安装 / 检查更新」（后台下载、轮询进度）→ 各自「登录」（CLI 自动开浏览器、
 * 抓到授权 URL 时给可点链接兜底）→ 状态行显示 版本 + 登录账号。
 * meegle 已登录时额外一行「默认空间」下拉（工作台看板 + 收件箱扫描唯一作用域）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Download, Loader2, LogIn, Trash2, XCircle } from "lucide-react";
import { toast } from "sonner";

import { useDialog } from "@/hooks/use-dialog";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingRow } from "@/components/ui/setting-row";
import type { FeAiFlowSettings } from "@/lib/types";

// 服务端状态形状（/api/system/feishu-cli GET）
interface ToolStatus {
  installed: boolean;
  version?: string;
  loggedIn?: boolean;
  authDetail?: string;
}
interface LoginState {
  running: boolean;
  authUrl?: string;
  error?: string;
}
interface FeishuCliState {
  larkCli: ToolStatus;
  meegle: ToolStatus;
  install: { running: boolean; log: string[]; error?: string };
  logins: { larkCli: LoginState | null; meegle: LoginState | null };
}

/** 空间列表项（对齐 /api/feishu/board 的 projects） */
interface MeegleProjectOption {
  key: string;
  name: string;
  simpleName?: string;
}

const TOOL_LABEL: Record<"larkCli" | "meegle", string> = {
  larkCli: "飞书（lark-cli）",
  meegle: "飞书项目（meegle-cli）",
};

type MeegleProjectSetting = NonNullable<FeAiFlowSettings["meegleProject"]>;

export const FeishuCliSection = ({
  meegleProject,
  onMeegleProjectChange,
}: {
  meegleProject: MeegleProjectSetting;
  /** 选中即落盘（父级 saveFieldValue） */
  onMeegleProjectChange: (next: MeegleProjectSetting) => void;
}) => {
  const { confirm } = useDialog();
  // 服务端状态快照（轮询）
  const [state, setState] = useState<FeishuCliState | null>(null);
  // 操作请求飞行中（防双击）
  const [busy, setBusy] = useState(false);
  // 可访问空间列表（登录后懒加载、失败静默）
  const [projects, setProjects] = useState<MeegleProjectOption[]>([]);
  // 有安装 / 登录流程在跑时轮询加密（2s）、否则不轮询
  const timerRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/system/feishu-cli");
      if (!res.ok) return;
      setState((await res.json()) as FeishuCliState);
    } catch {
      // 静默、下轮再试
    }
  }, []);

  // 首次拉取；有流程在跑时 2s 轮询
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const active =
      state?.install.running ||
      state?.logins.larkCli?.running ||
      state?.logins.meegle?.running;
    if (!active) return;
    timerRef.current = window.setInterval(() => void refresh(), 2000);
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, [state, refresh]);

  // meegle 已登录后懒拉空间列表（设置页下拉数据源；失败静默、下拉仍显示当前值）
  useEffect(() => {
    if (!state?.meegle.loggedIn) return;
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/feishu/board");
        if (!res.ok) return;
        const data = (await res.json()) as {
          status?: string;
          projects?: MeegleProjectOption[];
        };
        if (!alive || data.status !== "ok" || !Array.isArray(data.projects)) return;
        setProjects(data.projects);
      } catch {
        // 静默：下拉没有列表时仍能显示当前已存空间名
      }
    })();
    return () => {
      alive = false;
    };
  }, [state?.meegle.loggedIn]);

  const handleInstall = async () => {
    setBusy(true);
    try {
      await fetch("/api/system/feishu-cli", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "install" }),
      });
      toast.success("已开始下载安装（后台进行）");
      void refresh();
    } finally {
      setBusy(false);
    }
  };

  const handleLogin = async (tool: "lark-cli" | "meegle") => {
    setBusy(true);
    try {
      const res = await fetch("/api/system/feishu-cli", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "login", tool }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        toast.error(data.error ?? "登录发起失败");
        return;
      }
      toast.success("登录流程已启动、浏览器会自动打开授权页");
      void refresh();
    } finally {
      setBusy(false);
    }
  };

  const handleUninstall = async () => {
    const ok = await confirm({
      title: "卸载飞书 CLI？",
      description: "删除两个 CLI、官方 skills 和配置（含登录态）、重装后需重新登录",
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch("/api/system/feishu-cli", { method: "DELETE" });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        toast.error(data.error ?? "卸载失败");
        return;
      }
      toast.success("已卸载");
      void refresh();
    } finally {
      setBusy(false);
    }
  };

  const handlePickSpace = (key: string) => {
    const hit = projects.find((p) => p.key === key);
    // 列表未加载完时仍允许选中当前值（无 hit 不写、避免冲掉已存 name/simpleName）
    if (!hit) return;
    const next: MeegleProjectSetting = {
      key: hit.key,
      name: hit.name,
      ...(hit.simpleName ? { simpleName: hit.simpleName } : {}),
    };
    onMeegleProjectChange(next);
    toast.success("已保存默认空间");
  };

  // 单个工具的状态行
  const renderToolRow = (key: "larkCli" | "meegle") => {
    const tool = state?.[key];
    const login = key === "larkCli" ? state?.logins.larkCli : state?.logins.meegle;
    const toolId = key === "larkCli" ? "lark-cli" : "meegle";
    return (
      <div key={key} className="flex flex-wrap items-center gap-2 text-sm">
        <span className="min-w-36 font-medium">{TOOL_LABEL[key]}</span>
        {!state ? (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        ) : !tool?.installed ? (
          <Badge variant="outline" className="text-muted-foreground">未安装</Badge>
        ) : (
          <>
            {/* 版本探测可能超时（Windows Defender 首扫）、文件在盘上就先显「已安装」 */}
            <Badge variant="secondary">{tool.version ? `v${tool.version}` : "已安装"}</Badge>
            {tool.loggedIn ? (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <CheckCircle2 className="size-3.5 text-green-500" />
                已登录{tool.authDetail ? `：${tool.authDetail}` : ""}
              </span>
            ) : (
              <>
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <XCircle className="size-3.5 text-amber-500" />
                  未登录
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={busy || !!login?.running}
                  onClick={() => void handleLogin(toolId as "lark-cli" | "meegle")}
                >
                  {login?.running ? <Loader2 className="animate-spin" /> : <LogIn />}
                  登录
                </Button>
              </>
            )}
            {/* 登录中：服务端已尝试自动开浏览器（首次登录分两步：建应用 → 授权、
                两个页面会依次弹出）、链接兜底（二维码试过、用户嫌丑撤了） */}
            {login?.running && login.authUrl && (
              <a
                href={login.authUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary underline-offset-2 hover:underline"
              >
                浏览器没弹？点这里继续（建应用后还有一步授权）
              </a>
            )}
            {login?.error && (
              <span className="text-xs text-destructive">{login.error}</span>
            )}
          </>
        )}
      </div>
    );
  };

  const installing = !!state?.install.running;
  const installLog = state?.install.log ?? [];
  // 下拉选项：列表未回时至少塞进当前已存项、保证 Select 能显示名称
  const selectOptions =
    projects.length > 0
      ? projects
      : [{ key: meegleProject.key, name: meegleProject.name, simpleName: meegleProject.simpleName }];

  return (
    <div className="space-y-3">
      <div>
        <div className="text-sm font-medium">飞书集成</div>
        <p className="text-xs text-muted-foreground">
          内置官方 CLI、装完登录即可——AI 自动获得飞书 / 飞书项目全部能力
        </p>
      </div>
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || installing}
            onClick={() => void handleInstall()}
          >
            {installing ? <Loader2 className="animate-spin" /> : <Download />}
            {/* 两个都装了叫「检查更新」（点了会先比对版本、已最新直接跳过——原文案「更新」
                让用户以为总有新版可更）；缺任何一个叫「安装」 */}
            {state?.larkCli.installed && state?.meegle.installed ? "检查更新" : "安装"}
          </Button>
          {/* 最后一条安装日志装完也保留（「已是最新、跳过」这类结果用户要看得到） */}
          {!state?.install.error && installLog.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {installLog[installLog.length - 1]}
            </span>
          )}
          {!installing && state?.install.error && (
            <span className="text-xs text-destructive">{state.install.error}</span>
          )}
          {/* 卸载（用户点名「万一想卸载后重装」）：装了任一才显示 */}
          {!installing && (state?.larkCli.installed || state?.meegle.installed) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void handleUninstall()}
              className="ml-auto text-muted-foreground hover:text-destructive"
            >
              <Trash2 />
              卸载
            </Button>
          )}
        </div>
        {renderToolRow("larkCli")}
        {renderToolRow("meegle")}
        {/* 默认空间：仅 meegle 已登录时展示——看板 / 收件箱只扫这一个空间 */}
        {state?.meegle.loggedIn && (
          <SettingRow
            label="默认空间"
            hint="工作台与收件箱只处理这个空间"
            className="py-2"
            control={
              <Select
                value={meegleProject.key}
                onValueChange={(v) => {
                  if (v) handlePickSpace(v);
                }}
              >
                <SelectTrigger className="w-56">
                  <SelectValue placeholder="选择空间">
                    {selectOptions.find((p) => p.key === meegleProject.key)?.name ??
                      meegleProject.name}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {selectOptions.map((p) => (
                    <SelectItem key={p.key} value={p.key}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
        )}
      </div>
    </div>
  );
};
