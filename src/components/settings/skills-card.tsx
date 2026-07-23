"use client";

/**
 * Skills 卡片（能力页 Skill tab）
 *
 * 布局：顶栏（搜索 + 创建按钮）+ 左来源导航（5 项）+ 右列表（chip 过滤 + 行）。
 * team 源：共享走市场装卸；团队规范走 Switch 启停（底层同 install/uninstall API）；
 * 自管走 disabledSkills 开关；内置 / 飞书 CLI 必备只读。
 * 子组件拆在 skills-panel/，本文件负责数据拉取与业务 handler。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, Sparkles } from "lucide-react";
import { toast } from "sonner";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoadingState } from "@/components/ui/loading-state";
import { useDialog } from "@/hooks/use-dialog";
import { useSettings } from "@/hooks/use-settings";
import { useTeamLibrary } from "@/hooks/use-team-library";
import {
  deleteCustomActionReq,
  fetchCustomActions,
} from "@/lib/custom-action-client";
import { getSettings, initSettings, saveSettings } from "@/lib/local-store";
import { setPendingSlashSkill } from "@/components/slash-skills";
import { createTask } from "@/lib/task-store";

import { SkillEditDialog, SkillViewDialog } from "./skills-panel/edit-dialogs";
import { ImportSkillsDialog } from "./skills-panel/import-dialog";
import { SkillListPane } from "./skills-panel/skill-list-pane";
import { SourceNav, type NavNode } from "./skills-panel/source-nav";
import { UploadToTeamLibraryButton } from "./skills-panel/upload-to-team-library";
import {
  applyCategoryChip,
  categoryChipsFor,
  isSharedTeamCategory,
  skillsForNav,
  type CursorGlobalSkill,
  type SkillRow,
  type SourceNavKey,
} from "./skills-panel/types";

/** 互斥 dialog：同时最多开一个（编辑 / 查看 / 导入） */
type DialogState =
  | null
  | { kind: "edit"; name: string; content: string }
  | { kind: "view"; name: string; content: string }
  | { kind: "import" };

/** 请求飞行态合并：busy=通用；busyName=行内装卸；syncing/mirroring=顶栏 */
type RequestState = {
  busy: boolean;
  busyName: string | null;
  syncing: boolean;
  mirroring: boolean;
};

const INITIAL_REQUEST: RequestState = {
  busy: false,
  busyName: null,
  syncing: false,
  mirroring: false,
};

export const SkillsCard = () => {
  const { confirm } = useDialog();
  const router = useRouter();
  const { settings, saveFieldValue, loaded: settingsLoaded } = useSettings();
  // 团队规范总开关（共享无总开关、市场模型）
  const knowledgeEnabled = settings.teamKnowledgeEnabled !== false;

  const { status: teamStatus, refresh: refreshTeam } = useTeamLibrary(true);

  // 全部来源 skill（null = 加载中）
  const [skills, setSkills] = useState<SkillRow[] | null>(null);
  // Cursor 全局可导入清单
  const [cursorGlobal, setCursorGlobal] = useState<CursorGlobalSkill[]>([]);
  // 自管 skills 目录（对话创建 cwd）
  const [appSkillsDir, setAppSkillsDir] = useState("");

  // 搜索关键词
  const [query, setQuery] = useState("");
  // 左栏选中来源
  const [selected, setSelected] = useState<SourceNavKey>("app");
  // 右侧分类 chip（"all" 或分类名；切来源 / 分类被清空时重置）
  const [activeChip, setActiveChip] = useState("all");

  // 互斥 dialog（edit / view / import）
  const [dialog, setDialog] = useState<DialogState>(null);
  // 请求飞行态（busy / busyName / syncing / mirroring）
  const [request, setRequest] = useState<RequestState>(INITIAL_REQUEST);
  // ref 与 busyName 同步：useState 异步，同帧双击两次 handler 都会读到 null——
  // ref 同步置位挡同帧重入；state 管 spinner / 行禁用渲染
  const busyNameRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [skillsRes, actionsRes] = await Promise.all([
        fetch("/api/skills", { cache: "no-store" }),
        fetchCustomActions().catch(() => [] as Awaited<
          ReturnType<typeof fetchCustomActions>
        >),
      ]);
      const data = (await skillsRes.json()) as {
        skills?: SkillRow[];
        cursorGlobal?: CursorGlobalSkill[];
        appSkillsDir?: string;
      };
      // 被 custom action 挂载的 skill 名（自管行亮「action」tag；team 源由 server 填）
      const mounted = new Set(
        actionsRes
          .filter((a) => a.skill && !a.legacyPlaybook)
          .map((a) => a.skill),
      );
      setSkills(
        (data.skills ?? []).map((s) =>
          s.source === "app" && mounted.has(s.name)
            ? { ...s, teamAction: true }
            : s,
        ),
      );
      setCursorGlobal(data.cursorGlobal ?? []);
      setAppSkillsDir(data.appSkillsDir ?? "");
    } catch (err) {
      toast.error(
        `读取 skills 失败：${err instanceof Error ? err.message : String(err)}`,
      );
      setSkills([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleAiCreate = async () => {
    const s = getSettings();
    if (!s.apiKey?.trim() || !s.defaultModel?.id?.trim()) {
      toast.error("先在设置页配好 API Key 和默认模型");
      return;
    }
    if (s.disabledSkills?.includes("skill-creator")) {
      toast.error("skill-creator 已停用，先在列表里打开");
      return;
    }
    if (!appSkillsDir) {
      toast.error("skills 目录还没就绪，稍后重试");
      return;
    }
    setRequest((prev) => ({ ...prev, busy: true }));
    try {
      const task = await createTask({
        mode: "chat",
        title: "创建 skill",
        repoPaths: [appSkillsDir],
        model: s.defaultModel,
        disabledMcpServers:
          s.disabledMcpServers && s.disabledMcpServers.length > 0
            ? s.disabledMcpServers
            : undefined,
      });
      setPendingSlashSkill("skill-creator");
      router.push(`/tasks/${task.id}`);
    } catch (err) {
      toast.error(
        `发起失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setRequest((prev) => ({ ...prev, busy: false }));
    }
  };

  const fetchSkillContent = async (
    name: string,
    source: SkillRow["source"],
  ): Promise<string | null> => {
    try {
      const res = await fetch(
        `/api/skills/content?name=${encodeURIComponent(name)}&source=${encodeURIComponent(source)}`,
        { cache: "no-store" },
      );
      const data = (await res.json()) as { content?: string; error?: string };
      if (!res.ok) {
        toast.error(data.error ?? "读取失败");
        return null;
      }
      return data.content ?? "";
    } catch (err) {
      toast.error(
        `读取失败：${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  };

  const openEdit = async (name: string) => {
    const content = await fetchSkillContent(name, "app");
    if (content === null) return;
    setDialog({ kind: "edit", name, content });
  };

  const openView = async (name: string, source: SkillRow["source"]) => {
    const content = await fetchSkillContent(name, source);
    if (content === null) return;
    setDialog({ kind: "view", name, content });
  };

  const handleDelete = async (name: string) => {
    let mounted: Array<{ id: string; label: string }> = [];
    try {
      const defs = await fetchCustomActions();
      // 只联动自建 action；team 派生同名不算挂载本自管 skill
      mounted = defs
        .filter((d) => d.skill === name && d.origin === "app-skill")
        .map((d) => ({ id: d.id, label: d.label }));
    } catch {
      // ignore
    }
    const description =
      mounted.length > 0
        ? `有 ${mounted.length} 个 action 挂载此 skill、将一并删除：${mounted
            .map((a) => `「${a.label}」`)
            .join("、")}`
        : "整个 skill 目录（含附属脚本）会被删除";
    const ok = await confirm({
      title: `删除 skill「${name}」？`,
      description,
      destructive: true,
      confirmLabel: "删除",
    });
    if (!ok) return;
    try {
      for (const action of mounted) {
        try {
          await deleteCustomActionReq(action.id);
        } catch (err) {
          toast.error(
            `删除 action「${action.label}」失败：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      const res = await fetch(`/api/skills?name=${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        toast.error(data?.error ?? "删除失败");
        return;
      }
      // 成功：列表行消失自表达，不 toast
      void refresh();
    } catch (err) {
      toast.error(
        `删除失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  /** 自管源开关：settings.disabledSkills；挂自建 action 关闭前二次确认（推进面板会隐藏） */
  const handleToggleApp = async (row: SkillRow, enabled: boolean) => {
    const name = row.name;
    if (!enabled) {
      let mounted: Array<{ label: string }> = [];
      try {
        const defs = await fetchCustomActions();
        // 只计自建挂载（team 派生走 skill-states、不受 disabledSkills 影响）
        mounted = defs
          .filter(
            (d) =>
              d.skill === name &&
              !d.legacyPlaybook &&
              d.origin === "app-skill",
          )
          .map((d) => ({ label: d.label }));
      } catch {
        // ignore
      }
      if (mounted.length > 0) {
        const ok = await confirm({
          title: `关闭 skill「${name}」？`,
          description: `有 ${mounted.length} 个 action 挂载：${mounted
            .map((a) => `「${a.label}」`)
            .join("、")}。关闭后这些 action 将从推进面板隐藏`,
          confirmLabel: "关闭",
        });
        if (!ok) return;
      }
    }

    // 乐观更新（app 源 name 唯一、按 name+source 匹配即可）
    const patchRow = (value: boolean) =>
      setSkills((prev) =>
        prev
          ? prev.map((s) =>
              s.name === name && s.source === "app"
                ? { ...s, enabled: value }
                : s,
            )
          : prev,
      );
    patchRow(enabled);
    await initSettings();
    const s = getSettings();
    const cur = new Set(s.disabledSkills ?? []);
    if (enabled) cur.delete(name);
    else cur.add(name);
    const ok = await saveSettings({ ...s, disabledSkills: [...cur] });
    if (!ok) {
      patchRow(!enabled);
      toast.error("开关保存失败，请重试");
    }
  };

  /** team 行乐观 patch（name+teamCategory 精确匹配、防同名跨分组误改） */
  const patchTeamRow = (row: SkillRow, enabled: boolean) =>
    setSkills((prev) =>
      prev
        ? prev.map((s) =>
            s.name === row.name &&
            s.source === "team" &&
            s.teamCategory === row.teamCategory
              ? { ...s, enabled }
              : s,
          )
        : prev,
    );

  /**
   * 启用 / 安装 team skill（API 同为 install）：
   * shared = 市场「安装」文案；knowledge = Switch「启用」文案。
   * 带 action 标记的 server 顺带挂推进 action。
   */
  const handleInstall = async (row: SkillRow) => {
    if (busyNameRef.current) return;
    busyNameRef.current = row.name;
    const asToggle = !isSharedTeamCategory(row.teamCategory);
    setRequest((prev) => ({ ...prev, busyName: row.name }));
    patchTeamRow(row, true);
    try {
      const res = await fetch("/api/team-library/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: row.name }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        actionLabel?: string;
        error?: string;
      };
      if (!res.ok) {
        patchTeamRow(row, false);
        toast.error(data.error ?? (asToggle ? "启用失败" : "安装失败"));
        return;
      }
      // 成功：行状态（安装标 / Switch）自表达，不 toast
      void refresh();
    } catch (err) {
      patchTeamRow(row, false);
      toast.error(
        `${asToggle ? "启用" : "安装"}失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      busyNameRef.current = null;
      setRequest((prev) => ({ ...prev, busyName: null }));
    }
  };

  /**
   * 关闭 / 卸载 team skill（API 同为 uninstall）：
   * 有挂载 action 先确认（说明推进面板会少哪个按钮）。
   */
  const handleUninstall = async (row: SkillRow) => {
    if (busyNameRef.current) return;
    // 确认弹窗打开期间也要挡其它行——先于 await confirm 置位
    busyNameRef.current = row.name;
    setRequest((prev) => ({ ...prev, busyName: row.name }));
    const asToggle = !isSharedTeamCategory(row.teamCategory);
    let mounted: Array<{ label: string }> = [];
    try {
      const defs = await fetchCustomActions();
      mounted = defs
        .filter((d) => d.skill === row.name && !d.legacyPlaybook)
        .map((d) => ({ label: d.label }));
    } catch {
      // ignore
    }
    if (mounted.length > 0) {
      const ok = await confirm({
        title: asToggle
          ? `关闭「${row.name}」？`
          : `卸载「${row.name}」？`,
        description: `推进面板的 ${mounted
          .map((a) => `「${a.label}」`)
          .join("、")}会一并移除`,
        destructive: true,
        confirmLabel: asToggle ? "关闭" : "卸载",
      });
      if (!ok) {
        busyNameRef.current = null;
        setRequest((prev) => ({ ...prev, busyName: null }));
        return;
      }
    }

    patchTeamRow(row, false);
    try {
      const res = await fetch("/api/team-library/uninstall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: row.name }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) {
        patchTeamRow(row, true);
        toast.error(data.error ?? (asToggle ? "关闭失败" : "卸载失败"));
        return;
      }
      // 成功：行状态自表达，不 toast
      void refresh();
    } catch (err) {
      patchTeamRow(row, true);
      toast.error(
        `${asToggle ? "关闭" : "卸载"}失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      busyNameRef.current = null;
      setRequest((prev) => ({ ...prev, busyName: null }));
    }
  };

  /**
   * 从共享库远端删除（误上传清理）：全组 sync 后消失。
   * knowledge 镜像不允许删——UI 只在共享行露出入口。
   */
  const handleDeleteFromLibrary = async (row: SkillRow) => {
    if (busyNameRef.current) return;
    if (!isSharedTeamCategory(row.teamCategory)) return;
    busyNameRef.current = row.name;
    setRequest((prev) => ({ ...prev, busyName: row.name }));
    const ok = await confirm({
      title: `从共享库删除「${row.name}」？`,
      description: "从共享库删除、全组同步后消失",
      destructive: true,
      confirmLabel: "从库删除",
    });
    if (!ok) {
      busyNameRef.current = null;
      setRequest((prev) => ({ ...prev, busyName: null }));
      return;
    }
    try {
      const res = await fetch("/api/team-library/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: row.name }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        pendingReview?: boolean;
        mrUrl?: string;
      };
      if (!res.ok) {
        toast.error(data.error ?? "从库删除失败");
        return;
      }
      if (data.pendingReview && data.mrUrl) {
        toast.success("已提交删除 MR，合并后全组生效", {
          action: {
            label: "查看 MR",
            onClick: () => window.open(data.mrUrl, "_blank", "noopener"),
          },
        });
      } else {
        toast.success(`已从共享库删除「${row.name}」`);
      }
      void refresh();
      void refreshTeam();
    } catch (err) {
      toast.error(
        `从库删除失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      busyNameRef.current = null;
      setRequest((prev) => ({ ...prev, busyName: null }));
    }
  };

  const handleImport = async (dirNames: string[]) => {
    setRequest((prev) => ({ ...prev, busy: true }));
    try {
      const res = await fetch("/api/skills/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names: dirNames }),
      });
      const data = (await res.json()) as {
        imported?: string[];
        failed?: Array<{ name: string; error: string }>;
        error?: string;
      };
      if (!res.ok) {
        toast.error(data.error ?? "导入失败");
        return;
      }
      if ((data.imported?.length ?? 0) > 0) {
        toast.success(`已导入 ${data.imported!.length} 个 skill`);
      }
      for (const f of data.failed ?? []) {
        toast.error(`「${f.name}」导入失败：${f.error}`);
      }
      setDialog(null);
      void refresh();
    } finally {
      setRequest((prev) => ({ ...prev, busy: false }));
    }
  };

  const runSync = async (): Promise<boolean> => {
    try {
      const res = await fetch("/api/team-library/sync", { method: "POST" });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok) {
        toast.error(data.error ?? "同步失败");
        return false;
      }
      await Promise.all([refresh(), refreshTeam()]);
      return true;
    } catch (err) {
      toast.error(
        `同步失败：${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  };

  const handleSync = async () => {
    if (request.syncing || request.mirroring) return;
    setRequest((prev) => ({ ...prev, syncing: true }));
    try {
      // 成功：同步时间戳自更新；失败才 toast（runSync 内）
      await runSync();
    } finally {
      setRequest((prev) => ({ ...prev, syncing: false }));
    }
  };

  const handleMirror = async () => {
    if (request.syncing || request.mirroring) return;
    const ok = await confirm({
      title: "更新知识库镜像？",
      description: "约需 1～2 分钟",
      confirmLabel: "开始更新",
    });
    if (!ok) return;
    setRequest((prev) => ({ ...prev, mirroring: true }));
    try {
      const res = await fetch("/api/team-library/mirror", { method: "POST" });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) {
        toast.error(data.error ?? "镜像失败");
        return;
      }
      toast.success("知识库镜像已更新");
      setRequest((prev) => ({ ...prev, syncing: true }));
      try {
        await runSync();
      } finally {
        setRequest((prev) => ({ ...prev, syncing: false }));
      }
    } catch (err) {
      toast.error(
        `镜像失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setRequest((prev) => ({ ...prev, mirroring: false }));
    }
  };

  // ---------- 派生：导航 / chip / 过滤列表 ----------

  const allSkills = useMemo(() => skills ?? [], [skills]);
  const q = query.trim().toLowerCase();
  const searching = q.length > 0;

  const appSkills = useMemo(
    () => skillsForNav(allSkills, "app"),
    [allSkills],
  );

  const navNodes: NavNode[] = useMemo(
    () => [
      { key: "app", label: "自管", count: appSkills.length },
      {
        key: "shared",
        label: "共享",
        count: skillsForNav(allSkills, "shared").length,
      },
      {
        key: "knowledge",
        label: "团队规范",
        count: skillsForNav(allSkills, "knowledge").length,
      },
      {
        key: "builtin",
        label: "内置",
        count: skillsForNav(allSkills, "builtin").length,
      },
      {
        key: "feishu-cli",
        label: "飞书 CLI",
        count: skillsForNav(allSkills, "feishu-cli").length,
      },
    ],
    [allSkills, appSkills.length],
  );

  const chips = useMemo(
    () => categoryChipsFor(allSkills, selected),
    [allSkills, selected],
  );

  // 分类被卸载清空后 activeChip 可能指向不存在的分类 → 重置为 all
  useEffect(() => {
    if (activeChip === "all") return;
    if (!chips.some((c) => c.value === activeChip)) {
      setActiveChip("all");
    }
  }, [chips, activeChip]);

  const filteredSkills = useMemo(() => {
    if (searching) {
      return allSkills.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q),
      );
    }
    return applyCategoryChip(allSkills, selected, activeChip);
  }, [searching, q, selected, activeChip, allSkills]);

  // 切来源时重置 chip
  const handleSelectNav = (key: SourceNavKey) => {
    setSelected(key);
    setActiveChip("all");
  };

  const { busy, busyName, syncing, mirroring } = request;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Skills</CardTitle>
        <CardDescription>
          agent 按场景自动取用的能力扩展；自管可编辑，其余只读
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* 顶栏：搜索 + 创建按钮 */}
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="min-w-0 flex-1"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索 skill…"
            aria-label="搜索 skill"
          />
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <UploadToTeamLibraryButton
              mode="skill"
              onUploaded={() => {
                void refresh();
                void refreshTeam();
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void handleAiCreate()}
            >
              <Sparkles />
              对话创建
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setDialog({ kind: "import" })}
            >
              <Download />
              从 Cursor 导入
            </Button>
          </div>
        </div>

        {skills === null || !settingsLoaded ? (
          <LoadingState variant="inline" />
        ) : (
          <div className="flex gap-3">
            {!searching && (
              <SourceNav
                nodes={navNodes}
                selected={selected}
                onSelect={handleSelectNav}
                knowledgeDisabled={!knowledgeEnabled}
              />
            )}
            <SkillListPane
              skills={filteredSkills}
              searching={searching}
              selected={selected}
              chips={chips}
              activeChip={activeChip}
              onChipChange={setActiveChip}
              knowledgeEnabled={knowledgeEnabled}
              onKnowledgeEnabledChange={(v) =>
                void saveFieldValue("teamKnowledgeEnabled", v)
              }
              teamStatus={teamStatus}
              syncing={syncing}
              mirroring={mirroring}
              onSync={() => void handleSync()}
              onMirror={() => void handleMirror()}
              busyName={busyName}
              onEdit={(name) => void openEdit(name)}
              onView={(name, source) => void openView(name, source)}
              onDelete={(name) => void handleDelete(name)}
              onToggleApp={(row, enabled) =>
                void handleToggleApp(row, enabled)
              }
              onInstall={(row) => void handleInstall(row)}
              onUninstall={(row) => void handleUninstall(row)}
              onDeleteFromLibrary={(row) => void handleDeleteFromLibrary(row)}
            />
          </div>
        )}
      </CardContent>

      {dialog?.kind === "edit" && (
        <SkillEditDialog
          initialName={dialog.name}
          initialContent={dialog.content}
          busy={busy}
          onClose={() => setDialog(null)}
          onSave={async (name, content) => {
            setRequest((prev) => ({ ...prev, busy: true }));
            try {
              const res = await fetch("/api/skills", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, content }),
              });
              if (!res.ok) {
                const data = (await res.json().catch(() => null)) as {
                  error?: string;
                } | null;
                toast.error(data?.error ?? "保存失败");
                return;
              }
              toast.success(`已保存「${name}」`);
              setDialog(null);
              void refresh();
            } finally {
              setRequest((prev) => ({ ...prev, busy: false }));
            }
          }}
        />
      )}

      {dialog?.kind === "view" && (
        <SkillViewDialog
          name={dialog.name}
          content={dialog.content}
          onClose={() => setDialog(null)}
        />
      )}

      <ImportSkillsDialog
        open={dialog?.kind === "import"}
        busy={busy}
        cursorGlobal={cursorGlobal}
        appNames={new Set(appSkills.map((s) => s.name))}
        onClose={() => setDialog(null)}
        onImport={(names) => void handleImport(names)}
      />
    </Card>
  );
};
