"use client";

/**
 * 「飞书集成」卡片（V0.12 P0）
 *
 * 内置两个官方 CLI（lark-cli 飞书开放平台 / meegle 飞书项目）的 安装 + 登录 + 状态。
 * 装完 agent 自动获得能力（官方 skills 注入 + PATH）、用户不用再懂 MCP。
 *
 * 交互：一键「安装 / 更新」（后台下载、轮询进度）→ 各自「登录」（CLI 自动开浏览器、
 * 抓到授权 URL 时给可点链接兜底）→ 状态行显示 版本 + 登录账号。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Download, Loader2, LogIn, XCircle } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

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

const TOOL_LABEL: Record<"larkCli" | "meegle", string> = {
  larkCli: "飞书（lark-cli）",
  meegle: "飞书项目（meegle）",
};

export const FeishuCliCard = () => {
  // 服务端状态快照（轮询）
  const [state, setState] = useState<FeishuCliState | null>(null);
  // 操作请求飞行中（防双击）
  const [busy, setBusy] = useState(false);
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
            <Badge variant="secondary">v{tool.version}</Badge>
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
            {/* 登录中：浏览器没自动弹时给可点授权链接兜底 */}
            {login?.running && login.authUrl && (
              <a
                href={login.authUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary underline-offset-2 hover:underline"
              >
                浏览器没弹？点这里授权
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

  return (
    <Card>
      <CardHeader>
        <CardTitle>飞书集成</CardTitle>
        <CardDescription>
          内置官方 CLI、装完登录即可——AI 自动获得飞书 / 飞书项目全部能力
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || installing}
            onClick={() => void handleInstall()}
          >
            {installing ? <Loader2 className="animate-spin" /> : <Download />}
            {/* 两个都装了才叫「更新」；缺任何一个都叫「安装」（用户踩过：meegle 没装、
                按钮却只有「更新」、以为装不了）。装过的且已最新会自动跳过、不重复下载 */}
            {state?.larkCli.installed && state?.meegle.installed ? "更新" : "安装"}
          </Button>
          {installing && installLog.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {installLog[installLog.length - 1]}
            </span>
          )}
          {!installing && state?.install.error && (
            <span className="text-xs text-destructive">{state.install.error}</span>
          )}
        </div>
        {renderToolRow("larkCli")}
        {renderToolRow("meegle")}
      </CardContent>
    </Card>
  );
};
