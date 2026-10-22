/**
 * 配置文件写 route（V0.7.16）—— 配置从 localStorage 迁到 data/config.json
 *
 * 落 `dataRoot()/config.json`（跟 FLOWSHIP_DATA_DIR、Electron 下在 userData/data）：
 * 明文 JSON、不绑 origin、主进程也能读、备份 / 同步 test 直接拷文件。
 *
 * 读配置走 `/api/settings/full`（仅 loopback、拿真值）；本 route 只保留 PUT。
 */
import { NextResponse } from "next/server";

import { syncGitTokenEnv } from "@/lib/server/git-token-env";
import { pinTrustedGitHostFromSettings } from "@/lib/server/gitlab-host";
import { errorResponse } from "@/lib/server/route-helpers";
import { invalidateMrInboxCache } from "@/lib/server/mr-inbox-scanner";
import {
  patchSettingsFile,
  putSettingsFile,
  readSettingsFile,
  validateCustomProvidersInput,
  validateNewRepoPaths,
  validateSettingsPatch,
  validateSettingsPayload,
} from "@/lib/server/settings-fs";
import { DEFAULT_MEEGLE_PROJECT } from "@/lib/types";

export const runtime = "nodejs";

/**
 * 写配置：PUT /api/settings、body = 整份 settings 对象、返 { ok, settings: 最终盘上内容 }
 * 原子写（tmp + rename）防写一半损坏（沿用 task-fs 的 meta 落盘方式）。
 *
 * CR-01：响应里的 settings 也脱敏。
 * CR-08：读改写串行化在 settings-fs.putSettingsFile（globalThis 写链）——
 * 两个快速 PUT 不会乱序互相覆盖。
 * 读失败（error）拒绝写入，避免用客户端缓存覆盖损坏但可能可修复的原文件。
 * F6-02 / 第六轮：请求体必须是「完整配置对象」——同时带 apiKey（字符串）/ defaultModel（对象）/ repos（数组），
 * 缺任一或类型不对 → 400（见 validateSettingsPayload；清 key 是「完整对象 + apiKey 置空串」）。
 * 覆盖写之前 putSettingsFile 会把当前可解析的配置备份成 config.json.bak；若这次写会清空「凭据与列表类」配置
 * （apiKey / gitToken / repos / mcpServers / customProviders 的 key / companyEnv 子系统；开关、星标等偏好不算，见 shrunkSettingsKeys），
 * 还会先把收缩前的完整配置留成 config.json.bak.shrink（只被下一次收缩写覆盖、普通保存不碰）。
 */

/** 从 settings 对象抠 meegleProject.key（缺 / 坏 → 默认悟空 key） */
const meegleProjectKeyOf = (raw: unknown): string => {
  if (!raw || typeof raw !== "object") return DEFAULT_MEEGLE_PROJECT.key;
  const key = (raw as { key?: unknown }).key;
  return typeof key === "string" && key.trim()
    ? key
    : DEFAULT_MEEGLE_PROJECT.key;
};

type WriteOutcome = Awaited<ReturnType<typeof putSettingsFile>>;

/**
 * 这次要写的 repos 里「新加的」UNC / WSL / 非本机磁盘路径 → 400 文案（第五轮 Q4-01 服务端兜底；盘上已有的旧条目放行）。
 * 读盘失败 / 没有配置文件时按「全是新增」处理——反正后面的写入也会因 unreadable 被拒。
 */
const rejectNewNonLocalRepos = async (incomingRepos: unknown): Promise<string | null> => {
  if (!Array.isArray(incomingRepos)) return null;
  const current = await readSettingsFile();
  return validateNewRepoPaths(
    incomingRepos,
    current.status === "ok" ? current.settings.repos : undefined,
  );
};

/**
 * PUT / PATCH 落盘成功后的副作用与响应（两条入口共用）：
 * 不可读 → 500 settings_unreadable；其余同步 token / 固定可信 host / 清收件箱缓存 / shell 偏好 / company-env。
 */
const finishWrite = async (
  result: WriteOutcome,
  method: "PUT" | "PATCH",
): Promise<Response> => {
  if (result.status === "unreadable") {
    console.error(
      `[/api/settings] ${method} 拒绝：config.json 不可读:`,
      result.reason,
    );
    // reason 不含文件内容（见 readSettingsFile），设置页据此给出明确提示、且不再自动重试
    return NextResponse.json(
      { error: "settings_unreadable", reason: result.reason },
      { status: 500 },
    );
  }
  const { settings: guarded, previous } = result;
  // GitLab token 同步进 process.env（agent shell 靠 $FLOWSHIP_GITLAB_TOKEN 取，见 git-token-env.ts）：
  // 每次保存都同步（改了 / 清空都立即生效，新起的 shell 就是新值）；用 guarded（掩码兜底后的盘上真值）、
  // 不能用 body——body 里可能是脱敏展示串。同步操作、失败不会挡保存。
  syncGitTokenEnv(guarded.gitToken);
  // 可信时机：用户刚改完 token / 仓库，是纯用户动作、没有 agent 介入——把仓库 origin 推出的
  // GitLab host 固定为 PAT 的可信目的地（首次绑定；已固定 / 配了白名单则不动）。
  // 有 token 才固定；失败只 warn、绝不挡保存（pinTrustedGitHostFromSettings 本身不抛，这里再兜一层）。
  if (typeof guarded.gitToken === "string" && guarded.gitToken.trim()) {
    try {
      await pinTrustedGitHostFromSettings(guarded, "settings");
    } catch (err) {
      console.warn(
        "[/api/settings] 固定可信 GitLab host 失败（配置已保存）:",
        err instanceof Error ? err.message : err,
      );
    }
  }
  // 默认空间 key 变了 → 收件箱缓存作废（否则仍显示旧空间扫到的条目）
  const oldKey = meegleProjectKeyOf(previous?.meegleProject);
  const newKey = meegleProjectKeyOf(guarded.meegleProject);
  if (oldKey !== newKey) {
    invalidateMrInboxCache();
  }
  // Windows Agent shell 偏好：落盘后立刻改 process.env.SHELL，用户拨开关不用重启
  try {
    const { applyAgentShellPreference } = await import(
      "@/lib/server/agent-shell"
    );
    await applyAgentShellPreference();
  } catch (err) {
    console.warn(
      "[/api/settings] 应用 Agent shell 偏好失败（配置已保存）:",
      err instanceof Error ? err.message : err,
    );
  }
  // 公司环境：同步到 company-env.json（skill 固定路径读取；SDK local 无 env 透传）
  try {
    const { syncCompanyEnvFileFromObject } = await import(
      "@/lib/server/company-env-fs"
    );
    await syncCompanyEnvFileFromObject(guarded.companyEnv);
  } catch (err) {
    console.warn(
      "[/api/settings] 同步 company-env.json 失败（配置已保存）:",
      err instanceof Error ? err.message : err,
    );
  }
  // 不再回传 settings：客户端（putSettings）从不读响应体，而 maskSettingsSecrets 只遮 apiKey / gitToken / provider key，
  // 响应里的公司环境密码、MCP env / headers 仍是原文——「声称脱敏、实际没脱」（第三轮 D1-09）。回 { ok } 就够了
  return NextResponse.json({ ok: true });
};

export const PUT = async (req: Request): Promise<Response> => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("无效的请求体", 400);
  }
  // 只认「完整配置对象」：整对象覆盖语义下，`{}` / `{ repos: [] }` 这类残缺体会清空配置、`[]` 会写坏配置文件
  const invalid =
    validateSettingsPayload(body) ??
    // 地址带用户名 / 密码的提供方服务端也拒（之前只有设置页红字、服务端照存，第四轮 Q2-06）
    validateCustomProvidersInput((body as Record<string, unknown>).customProviders);
  if (invalid) {
    return errorResponse(invalid, 400);
  }
  const badRepo = await rejectNewNonLocalRepos((body as Record<string, unknown>).repos);
  if (badRepo) {
    return errorResponse(badRepo, 400);
  }
  try {
    // RMW 整段在 settings-fs 写链内（审查：锁只包 write 锁不住 route 侧合并）
    const result = await putSettingsFile(body as Record<string, unknown>);
    return await finishWrite(result, "PUT");
  } catch (err) {
    console.error("[/api/settings] 写 config.json 失败:", err);
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(`保存配置失败：${message}`, 500);
  }
};

/**
 * 字段级补丁：PATCH /api/settings、body = { patch?: { key: value… }, remove?: string[] }（第三轮 D1-01）。
 * 服务端在写锁内读盘、只替换补丁里的键，再走与 PUT 同一套校验 / 掩码兜底 / 收缩备份 / 原子写——
 * 设置页每次只改一个字段，用它就不会因客户端缓存陈旧把别处刚改的 key / 仓库整体还原。
 * 盘上没有 config.json → 409（补丁没有基线，先让客户端完成初始化）。
 */
export const PATCH = async (req: Request): Promise<Response> => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("无效的请求体", 400);
  }
  const invalid = validateSettingsPatch(body);
  if (invalid) {
    return errorResponse(invalid, 400);
  }
  const badRepo = await rejectNewNonLocalRepos(
    (body as { patch?: Record<string, unknown> }).patch?.repos,
  );
  if (badRepo) {
    return errorResponse(badRepo, 400);
  }
  try {
    const { patch, remove } = body as {
      patch?: Record<string, unknown>;
      remove?: string[];
    };
    const result = await patchSettingsFile({ patch, remove });
    if (result.status === "missing") {
      return errorResponse("配置文件还不存在，无法按字段保存，请刷新页面重新加载", 409);
    }
    return await finishWrite(result, "PATCH");
  } catch (err) {
    console.error("[/api/settings] PATCH 写 config.json 失败:", err);
    const message = err instanceof Error ? err.message : String(err);
    // 合并后的整份配置没通过校验（如补丁把必备字段改成了错误类型）属于调用方错误 → 400
    const status = /^(settings|配置|apiKey|defaultModel|repos)/.test(message) ? 400 : 500;
    return errorResponse(`保存配置失败：${message}`, status);
  }
};
