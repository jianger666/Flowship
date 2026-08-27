"use client";

/**
 * 任务启动表单（V0.14、原 NewTaskDialog 的表单核心内联成页面组件）
 *
 * 两条入口：
 * - 看板点工作项 → 预览页（工作项详情 + 本表单）→ 标题 / 飞书链接预填（恒为需求任务）
 * - 看板「手动建任务」→ `/workitems/new`（无预填）→ 顶部显式二选「需求任务 / 日常任务」
 *
 * 手动路径任务类型（纯 UI、不落 schema）：
 * - 需求任务（默认）：飞书链接必填；QA 可填被测业务分支；非测试角色可选 worktree
 * - 日常任务：隐藏链接与分支相关字段；提交 storyUrl 空 → 服务端轻量态（原仓当前分支）
 * 切换模式草稿保留（切走再切回链接 / 分支仍在 state）
 *
 * 目标仓库每次留空、用户自己选。缺项点启动：对应 Field 标 warning，不在按钮旁挂黄字。
 */

import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Plug, Rocket } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { CheckboxRow } from "@/components/ui/checkbox-row";
import { ChoiceButton } from "@/components/ui/choice-button";
import { Combobox } from "@/components/ui/combobox";
import { EmptyHint } from "@/components/ui/empty-hint";
import { Field } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Label } from "@/components/ui/label";
import { ProviderModelPicker } from "@/components/ui/provider-model-picker";
import { MultiSelect } from "@/components/ui/multi-select";
import { Input } from "@/components/ui/input";
import { McpToggleList } from "@/components/tasks/mcp-toggle-list";
import { WkActivateFields } from "@/components/tasks/wk-activate-fields";
import { useCursorMcp } from "@/hooks/use-cursor-mcp";
import { useModels } from "@/hooks/use-models";
import { useRepoBranches } from "@/hooks/use-repo-branches";
import { resolveBranchTemplate } from "@/lib/branch-template";
import { getSettings, initSettings } from "@/lib/local-store";
import {
  activateWkRequirement,
  fetchWkActivateContext,
  matchHubOwnerValue,
  wkActivateFieldErrors,
  type HubOwnerOption,
  type WkActivateFieldErrors,
} from "@/lib/wk-activate";
import {
  getModelCredsForProvider,
  hasModelCredsForProvider,
} from "@/lib/agent-provider";
import { reqIdPatchValue } from "@/lib/req-id";
import {
  resolveLaunchIsolateWorktree,
  roleSupportsWorktree,
} from "@/lib/role-worktree";
import { settingsUrl } from "@/lib/settings-link";
import { buildDefaultDailyTaskTitle } from "@/lib/task-display";
import { createTask } from "@/lib/task-store";

import {
  CURSOR_PROVIDER_ID,
  defaultModelForProvider,
  type ModelSelection,
  type RepoConfig,
  type Task,
  type UserRole,
} from "@/lib/types";

/** 手动建任务时的显式模式（看板预填路径不展示、恒走需求） */
type LaunchKind = "requirement" | "daily";

type LaunchFieldErrorKey =
  | "title"
  | "storyUrl"
  | "repos"
  | keyof WkActivateFieldErrors;

interface Props {
  /** 工作项名（标题预填、可改；手动入口传空） */
  initialTitle: string;
  /** 工作项详情页 URL；有值则固定带入、空则表单内可粘贴 */
  feishuStoryUrl: string;
  onCreated: (task: Task) => void;
}

export const TaskLaunchForm = ({ initialTitle, feishuStoryUrl, onCreated }: Props) => {
  // 任务标题（预填工作项名、可改）
  const [title, setTitle] = useState(initialTitle);
  // 飞书链接：预填路径用 prop；手动路径本地可编辑（初始空时放开输入）
  const [storyUrl, setStoryUrl] = useState(feishuStoryUrl);
  // wk 需求编号（团队规范的 REQ-ID）：手填或启动时激活写入；空 = 没有编号
  const [reqId, setReqId] = useState("");
  // 启动时激活（给技术 Owner 用）：默认关；Hub 没配 / 已手填编号则整块不出现
  const [wantActivate, setWantActivate] = useState(false);
  const [activateHubReady, setActivateHubReady] = useState(false);
  const [activateOwners, setActivateOwners] = useState<HubOwnerOption[]>([]);
  const [techOwner, setTechOwner] = useState("");
  const [semanticCode, setSemanticCode] = useState("");
  const [businessLine, setBusinessLine] = useState("");
  const [plannedOnlineDate, setPlannedOnlineDate] = useState("");
  // 有预填则隐藏链接框（看板进）；无预填才露出可编辑输入 + 模式二选
  const urlEditable = !feishuStoryUrl.trim();
  // 手动路径：需求任务（默认）/ 日常任务；切走再切回不丢草稿
  const [launchKind, setLaunchKind] = useState<LaunchKind>("requirement");
  // 目标仓库：每次留空，用户自己选
  const [repoPaths, setRepoPaths] = useState<string[]>([]);
  // QA 被测业务分支（日常模式隐藏、state 保留）
  const [featureBranches, setFeatureBranches] = useState<Record<string, string>>({});
  // 仓库下拉源（settings）
  const [repos, setRepos] = useState<RepoConfig[]>([]);
  // MCP 黑名单（默认设置页快照、可临时增减）
  const { names: availableMcp } = useCursorMcp(true);
  const [disabledMcp, setDisabledMcp] = useState<string[]>([]);
  const [mcpExpanded, setMcpExpanded] = useState(false);
  // 逃生口：直接在原仓库运行
  const [runInRepo, setRunInRepo] = useState(false);
  // null = 设置尚未加载；测试角色不渲染 worktree UI，提交时也强制不隔离。
  const [userRole, setUserRole] = useState<UserRole | undefined | null>(null);
  // 本单提供方（默认设置页默认项，可在表单里改、不改全局）
  const [pickedProvider, setPickedProvider] = useState(CURSOR_PROVIDER_ID);
  // 模型（默认：当前 pickedProvider 的 defaultModelForProvider）
  const [pickedModel, setPickedModel] = useState<ModelSelection>({ id: "" });
  const [defaultModelId, setDefaultModelId] = useState("");
  const { models: availableModels, fetchModels } = useModels();
  const branchMap = useRepoBranches(repoPaths);
  const [submitting, setSubmitting] = useState(false);
  // 点启动后才出现的字段校验（Field.error，warning 色）
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<LaunchFieldErrorKey, string>>
  >({});

  // 手动 + 选了日常 → 轻量态 UI；看板预填恒为需求任务
  const isDailyLaunch = urlEditable && launchKind === "daily";

  // mount：await initSettings 后再读 cache 预填（冷启动同步 getSettings 会拿到 DEFAULT_SETTINGS）
  useEffect(() => {
    let alive = true;
    void (async () => {
      await initSettings();
      if (!alive) return;
      const s = getSettings();
      const providerId = s.provider ?? CURSOR_PROVIDER_ID;
      const defaultModel = defaultModelForProvider(s, providerId);
      setPickedProvider(providerId);
      setUserRole(s.userRole);
      setRepos(s.repos);
      setDisabledMcp(s.disabledMcpServers ?? []);
      setDefaultModelId(defaultModel?.id ?? "");
      setPickedModel(defaultModel?.id?.trim() ? defaultModel : { id: "" });
      // v1.1.x：隔离工作区默认值走设置页偏好（只读型用法可默认直跑原仓）、表单可临时改
      setRunInRepo(s.isolateWorktreeDefault === false);
      void fetchWkActivateContext()
        .then((ctx) => {
          if (!alive) return;
          setActivateHubReady(ctx.hubReady);
          setActivateOwners(ctx.owners);
          setTechOwner((prev) => prev || matchHubOwnerValue(ctx.owners, ctx.ownerName));
        })
        .catch(() => {
          /* 读不到就当没配 Hub，不挡启动 */
        });
      if (hasModelCredsForProvider(s, providerId)) {
        void fetchModels({
          ...getModelCredsForProvider(s, providerId),
          provider: providerId,
        });
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅 mount 预填一次
  }, []);

  // initialTitle 异步到位（详情拉回来）时回填未被用户改过的标题
  useEffect(() => {
    setTitle((cur) => (cur.trim() ? cur : initialTitle));
  }, [initialTitle]);

  // 预填 URL 晚到（query 异步）时补上；手动路径不覆盖用户已粘贴的
  useEffect(() => {
    if (feishuStoryUrl.trim()) {
      setStoryUrl((cur) => (cur.trim() ? cur : feishuStoryUrl));
    }
  }, [feishuStoryUrl]);

  // 日常模式强制原仓（不建分支 / worktree）
  const forceOriginalRepo = isDailyLaunch;
  const showWorktreeOptions =
    userRole !== null && roleSupportsWorktree(userRole);

  // 激活块：需求任务 + Hub 已配 + 没手填编号 + 非 QA
  const showActivate = Boolean(
    !isDailyLaunch &&
      userRole !== "qa" &&
      activateHubReady &&
      !reqId.trim(),
  );
  const activateEnabled = showActivate && wantActivate;
  const canEnableActivate = activateOwners.length > 0;

  const clearFieldError = (key: LaunchFieldErrorKey) => {
    setFieldErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const collectLaunchErrors = (): Partial<
    Record<LaunchFieldErrorKey, string>
  > => {
    const errors: Partial<Record<LaunchFieldErrorKey, string>> = {};
    if (!isDailyLaunch) {
      if (!title.trim()) errors.title = "请填写";
      if (!storyUrl.trim()) {
        errors.storyUrl = urlEditable
          ? "请填写"
          : "工作项链接缺失、回看板重新进入";
      }
    }
    if (repoPaths.length === 0) errors.repos = "请选择";
    if (activateEnabled) {
      Object.assign(
        errors,
        wkActivateFieldErrors({
          semanticCode,
          businessLine,
          plannedOnlineDate,
          techOwner,
        }),
      );
    }
    return errors;
  };

  const handleLaunch = async () => {
    if (submitting) return;
    const errors = collectLaunchErrors();
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      if (errors.storyUrl && !urlEditable) {
        toast.error(errors.storyUrl);
      }
      return;
    }
    setFieldErrors({});
    // 点下去就冻结：激活等待期间再改 worktree 勾选，不能改到即将创建的任务
    const isolateWorktree = resolveLaunchIsolateWorktree({
      role: userRole ?? undefined,
      forceOriginalRepo,
      runInRepo,
    });
    setSubmitting(true);
    try {
      const settings = getSettings();
      const model = pickedModel.id?.trim() ? pickedModel : undefined;

      // 从 settings 快照选中仓的分支配置（settings 在 localStorage、server 读不到、建 task 时固化）
      const repoBaseBranches: Record<string, string> = {};
      const repoTestBranches: Record<string, string> = {};
      const repoDevBranches: Record<string, string> = {};
      const repoBranchTemplates: Record<string, string> = {};
      const repoFeatureBranches: Record<string, string> = {};
      for (const p of repoPaths) {
        const repo = settings.repos.find((r) => r.path === p);
        const ob = repo?.onlineBranch?.trim();
        if (ob) repoBaseBranches[p] = ob;
        const tb = repo?.testBranch?.trim();
        if (tb) repoTestBranches[p] = tb;
        const db = repo?.devBranch?.trim();
        if (db) repoDevBranches[p] = db;
        repoBranchTemplates[p] = resolveBranchTemplate(
          repo?.branchTemplate,
          settings.branchTemplate,
        );
        // 仅 QA 提交被测业务分支；日常 / fe/be 不走 repoFeatureBranches
        if (!isDailyLaunch && userRole === "qa") {
          const fb = featureBranches[p]?.trim();
          if (fb) repoFeatureBranches[p] = fb;
        }
      }

      let launchedReqId = isDailyLaunch
        ? undefined
        : (reqIdPatchValue(reqId) ?? undefined);
      if (activateEnabled) {
        const ownerOpt = activateOwners.find((o) => o.value === techOwner);
        const activated = await activateWkRequirement({
          projectUrl: storyUrl.trim(),
          projectName: title.trim(),
          semanticCode,
          businessLine,
          plannedOnlineDate,
          techOwner,
          techOwnerName: ownerOpt?.label,
        });
        launchedReqId = activated.reqId;
        toast.success(
          activated.alreadyActivated
            ? `该工作项已激活，使用 ${activated.reqId}`
            : `已激活 ${activated.reqId}`,
        );
      }

      const task = await createTask({
        mode: "task",
        // 角色语义随任务固化，后续全局切角色不改变旧任务的分支行为。
        workRole: userRole ?? undefined,
        // 日常留空 → 自动「日常 · <首仓短名> · MM-DD HH:mm」；需求任务提交前 Field 已拦空标题
        title: title.trim()
          ? title.trim()
          : buildDefaultDailyTaskTitle(repoPaths),
        repoPaths,
        // 日常 → 空链接触发服务端轻量态；需求 → 必有链接
        feishuStoryUrl: isDailyLaunch ? undefined : storyUrl.trim() || undefined,
        reqId: launchedReqId,
        repoBaseBranches:
          Object.keys(repoBaseBranches).length > 0 ? repoBaseBranches : undefined,
        repoFeatureBranches:
          Object.keys(repoFeatureBranches).length > 0
            ? repoFeatureBranches
            : undefined,
        repoTestBranches:
          Object.keys(repoTestBranches).length > 0 ? repoTestBranches : undefined,
        repoDevBranches:
          Object.keys(repoDevBranches).length > 0 ? repoDevBranches : undefined,
        repoBranchTemplates:
          Object.keys(repoBranchTemplates).length > 0
            ? repoBranchTemplates
            : undefined,
        disabledMcpServers: disabledMcp.length > 0 ? disabledMcp : undefined,
        // 测试角色永不创建 worktree；其它角色仍按日常 / 用户选择决定。
        isolateWorktree,
        model,
        provider: pickedProvider,
      });
      onCreated(task);
    } catch (err) {
      toast.error(`启动失败：${(err as Error).message}`);
      setSubmitting(false);
    }
  };

  return (
    <Form
      disabled={submitting}
      className="flex flex-col gap-4 rounded-xl bg-card p-4 text-card-foreground ring-1 ring-foreground/10"
    >
      {/* 手动入口：显式二选，避免「留空链接」隐式触发日常 */}
      {urlEditable && (
        <div className="grid gap-1.5">
          <Label>任务类型</Label>
          <div className="flex flex-wrap gap-1.5">
            <ChoiceButton
              shape="chip"
              selected={launchKind === "requirement"}
              onClick={() => setLaunchKind("requirement")}
            >
              需求任务
            </ChoiceButton>
            <ChoiceButton
              shape="chip"
              selected={launchKind === "daily"}
              onClick={() => setLaunchKind("daily")}
            >
              日常任务
            </ChoiceButton>
          </div>
        </div>
      )}

      {/* 标题：需求任务必填；日常选填（留空提交时自动命名） */}
      <Field
        htmlFor="l-title"
        label="任务标题"
        required={!isDailyLaunch}
        error={fieldErrors.title}
      >
          <Input
            id="l-title"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              clearFieldError("title");
            }}
            placeholder={isDailyLaunch ? "留空自动命名" : "任务标题"}
          />
      </Field>

      {/* 飞书链接：需求任务必填（手动可编辑 / 看板预填隐藏）；日常任务整段隐藏、草稿保留 */}
      {urlEditable && !isDailyLaunch && (
        <Field
          htmlFor="l-story-url"
          label="飞书工作项链接"
          required
          error={fieldErrors.storyUrl}
        >
          <Input
            id="l-story-url"
            value={storyUrl}
            onChange={(e) => {
              setStoryUrl(e.target.value);
              clearFieldError("storyUrl");
            }}
            placeholder="粘贴飞书工作项链接"
          />
        </Field>
      )}

      {/* 激活在 REQ-ID 上面：勾上后编号由 Hub 生成，不必先填 */}
      {showActivate && (
        <WkActivateFields
          enabled={wantActivate}
          onEnabledChange={(next) => {
            setWantActivate(next);
            if (!next) {
              setFieldErrors((prev) => {
                const nextErrors = { ...prev };
                delete nextErrors.semanticCode;
                delete nextErrors.businessLine;
                delete nextErrors.plannedOnlineDate;
                delete nextErrors.techOwner;
                return nextErrors;
              });
            }
          }}
          canEnable={canEnableActivate}
          owners={activateOwners}
          techOwner={techOwner}
          onTechOwnerChange={(next) => {
            setTechOwner(next);
            clearFieldError("techOwner");
          }}
          semanticCode={semanticCode}
          onSemanticCodeChange={(next) => {
            setSemanticCode(next);
            clearFieldError("semanticCode");
          }}
          businessLine={businessLine}
          onBusinessLineChange={(next) => {
            setBusinessLine(next);
            clearFieldError("businessLine");
          }}
          plannedOnlineDate={plannedOnlineDate}
          onPlannedOnlineDateChange={(next) => {
            setPlannedOnlineDate(next);
            clearFieldError("plannedOnlineDate");
          }}
          errors={{
            semanticCode: fieldErrors.semanticCode,
            businessLine: fieldErrors.businessLine,
            plannedOnlineDate: fieldErrors.plannedOnlineDate,
            techOwner: fieldErrors.techOwner,
          }}
        />
      )}

      {/* wk 需求编号：选填、拿到编号后也能在任务详情页补。
          日常任务不出现（推进面板本来就不给日常任务出 wk 流程组） */}
      {!isDailyLaunch && userRole !== "qa" && (
        <Field
          htmlFor="l-req-id"
          label="REQ-ID"
          description={
            activateEnabled ? "激活后由 Hub 生成" : "可后补"
          }
        >
          <Input
            id="l-req-id"
            value={activateEnabled ? "" : reqId}
            disabled={activateEnabled}
            onChange={(e) => setReqId(e.target.value)}
          />
        </Field>
      )}

      <Field
        label="目标仓库"
        required
        error={fieldErrors.repos}
      >
        {repos.length > 0 ? (
          <MultiSelect<RepoConfig>
            options={repos}
            value={repoPaths}
            onChange={(next) => {
              setRepoPaths(next);
              if (next.length > 0) clearFieldError("repos");
            }}
            getKey={(r) => r.path}
            placeholder="选择仓库（可多选）"
            renderOption={(r) => (
              <>
                <span className="block w-full truncate font-medium">{r.name}</span>
                <span className="block w-full truncate text-xs text-muted-foreground">
                  {r.path}
                </span>
              </>
            )}
            renderTrigger={(selected) => {
              if (selected.length === 1) {
                const r = selected[0]!;
                return (
                  <>
                    <span className="shrink-0 font-medium">{r.name}</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                      {r.path}
                    </span>
                  </>
                );
              }
              return (
                <>
                  <span className="shrink-0 font-medium">已选 {selected.length} 个</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {selected.map((r) => r.name).join(" + ")}
                  </span>
                </>
              );
            }}
          />
        ) : (
          <EmptyHint size="sm">
            还没配置仓库——
            <a
              href={settingsUrl("repos")}
              className="text-primary underline-offset-2 hover:underline"
            >
              去设置页添加
            </a>
          </EmptyHint>
        )}
      </Field>

      {/* 角色选择已隐藏（v1.1.x 用户拍板「去掉」）：默认自适应——AI 从需求 + 仓库
          自己判断视角、比每单点一次枚举更省；字段保留在数据层、editing 兜底 */}

      {/* QA 需求任务：被测业务分支（可后补）；fe/be 不再展示分支字段 */}
      {!isDailyLaunch && userRole === "qa" && repoPaths.length > 0 && (
        <div className="grid gap-1.5">
          <Label>被测业务分支（可后补）</Label>
          <p className="text-xs text-muted-foreground">
            开发分支还没建立时可以留空，先做需求分析和测试用例；分支就绪后可在任务内编辑补上
          </p>
          <div className="grid gap-2">
            {repoPaths.map((p) => {
              const repo = repos.find((r) => r.path === p);
              const entry = branchMap[p];
              return (
                <div key={p} className="flex items-center gap-2">
                  <Tooltip content={repo?.name ?? p}>
                    <span className="w-28 shrink-0 truncate text-sm text-muted-foreground">
                      {repo?.name ?? p}
                    </span>
                  </Tooltip>
                  <Combobox
                    value={featureBranches[p] ?? ""}
                    onValueChange={(v) =>
                      setFeatureBranches((prev) => ({ ...prev, [p]: v }))
                    }
                    options={entry?.branches ?? []}
                    emptyHint="暂无候选，可在上方直接输入业务分支"
                    placeholder={
                      entry?.isRepo === false
                        ? entry.pathMissing
                          ? "路径不存在"
                          : entry.gitMissing
                            ? "未检测到 git、可手填分支"
                            : "非 git 仓库"
                        : "选择或填写业务分支"
                    }
                    className="min-w-0 flex-1"
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 模型 */}
      <div className="grid gap-1.5">
        <Label>模型</Label>
        <ProviderModelPicker
          variant="full"
          providerId={pickedProvider}
          onProviderChange={(nextId) => {
            const s = getSettings();
            setPickedProvider(nextId);
            const nextModel = defaultModelForProvider(s, nextId);
            setDefaultModelId(nextModel?.id ?? "");
            setPickedModel(nextModel?.id?.trim() ? nextModel : { id: "" });
            if (hasModelCredsForProvider(s, nextId)) {
              void fetchModels({
                ...getModelCredsForProvider(s, nextId),
                provider: nextId,
              });
            }
          }}
          models={availableModels}
          selection={pickedModel}
          onModelChange={setPickedModel}
          emptyPlaceholder={
            defaultModelId
              ? `默认: ${defaultModelId}（API Key 没填、改不了）`
              : "选择模型"
          }
        />
        {pickedModel.id && defaultModelId && pickedModel.id !== defaultModelId && (
          <p className="text-xs text-warning">已切到非默认模型</p>
        )}
      </div>

      {/* MCP 开关（默认全开、折叠） */}
      {availableMcp.length > 0 && (
        <div className="rounded-md border bg-card">
          <Button
            type="button"
            variant="ghost"
            disabled={submitting}
            onClick={() => setMcpExpanded((v) => !v)}
            className="h-auto w-full justify-start rounded-none rounded-t-md px-3 py-2 text-sm font-medium text-foreground/90"
          >
            {mcpExpanded ? <ChevronUp /> : <ChevronDown />}
            <Plug />
            <span>启用的 MCP servers</span>
            <span className="text-xs text-muted-foreground">
              {/* 黑名单可能残留已删除的 server 名（设置页快照）、直接减长度会出负数——按有效交集算 */}
              （{availableMcp.filter((n) => !disabledMcp.includes(n)).length}/
              {availableMcp.length}）
            </span>
          </Button>
          {mcpExpanded && (
            <div className="border-t p-3">
              <McpToggleList
                availableServers={availableMcp}
                disabled={disabledMcp}
                onChange={setDisabledMcp}
              />
            </div>
          )}
        </div>
      )}

      {/* 测试角色不出现 worktree 概念；日常任务强制原仓并隐藏勾选 */}
      {showWorktreeOptions &&
        (forceOriginalRepo ? (
          <p className="text-xs text-muted-foreground">
            日常任务直接在原仓库当前分支运行
          </p>
        ) : (
          <CheckboxRow
            checkboxId="l-use-worktree"
            checked={!runInRepo}
            onCheckedChange={(v) => setRunInRepo(!v)}
          >
            <span className="text-sm font-normal leading-none">
              使用 worktree 隔离运行（不影响原仓库、并行任务互不干扰）
            </span>
          </CheckboxRow>
        ))}

      {/* 启动：缺项点下去对应 Field 闪红圈，不在按钮旁跟黄字 */}
      <div className="flex items-center gap-3">
        <Button onClick={handleLaunch} disabled={submitting} className="gap-1.5">
          <Rocket className="size-4" />
          {submitting
            ? activateEnabled
              ? "激活中…"
              : "创建中…"
            : "启动任务"}
        </Button>
      </div>
    </Form>
  );
};
