/**
 * Skills 管理 API（V0.13 独立化、设置页 Skills 卡用）
 *
 * GET    /api/skills[?repos=<JSON 数组>]
 *        → 列平台/自管/飞书 CLI/全局标准/项目标准 skill（带 source）+ 可导入的 Cursor 全局清单；
 *          项目级需传已登记仓根路径列表，不传则只列非项目源
 * POST   /api/skills                    → 新增 / 覆盖 app 自管 skill { name, content }
 * DELETE /api/skills?name=<n>&source=<可管理源>&repo=<仓路径>
 *        → 删对应来源 skill；source 缺省 app（兼容旧调用方）
 *
 * cursorGlobal 仅供「从 Cursor 导入」dialog、不进列表 / 不注入 agent。
 */

import { promises as fs } from "node:fs";
import { NextResponse } from "next/server";

import {
  deleteSkillBySource,
  isManageableSkillSource,
  listCursorGlobalSkills,
  listSkillsWithSource,
  shortenHomePath,
  writeAppSkill,
} from "@/lib/server/app-skills";
import {
  getAppSkillsDir,
  readDisabledSkills,
} from "@/lib/server/skills-loader";
import { readTeamSkillStates } from "@/lib/server/team-skill-states";
import { errorResponse } from "@/lib/server/route-helpers";

export const runtime = "nodejs";

export const GET = async (req: Request) => {
  // 顺手保证自管目录存在：「AI 帮建」开对话要拿它当 cwd、不存在 agent 起不来
  const appSkillsDir = getAppSkillsDir();
  await fs.mkdir(appSkillsDir, { recursive: true }).catch(() => {});
  // 项目级源数据：客户端传已登记仓根路径列表（settings.repos）；非法 JSON 忽略
  let repoPaths: string[] | undefined;
  const rawRepos = new URL(req.url).searchParams.get("repos") ?? "";
  if (rawRepos) {
    try {
      const parsed: unknown = JSON.parse(rawRepos);
      if (Array.isArray(parsed)) {
        repoPaths = parsed.filter((p): p is string => typeof p === "string");
      }
    } catch {
      // 忽略、退化为不列项目级
    }
  }
  const [skills, cursorGlobal, disabled, teamStates] = await Promise.all([
    listSkillsWithSource({ repoPaths }),
    listCursorGlobalSkills(),
    readDisabledSkills(),
    readTeamSkillStates(),
  ]);
  return NextResponse.json({
    ok: true,
    skills: skills.map((s) => ({
      name: s.name,
      description: s.description,
      source: s.source,
      editable: s.editable,
      // 启停三分：team = skill-states（enabled=已安装）；内置 = 恒开；
      // 其余可管理源（app 自管 / 飞书 CLI / 全局标准 / 项目标准）统一查 disabledSkills——同名一关全关
      enabled:
        s.source === "team"
          ? teamStates[s.name] !== "disabled"
          : s.source === "builtin"
            ? true
            : !disabled.has(s.name),
      // absPath 必须是真绝对路径——slash 引用把它发给服务端校验 + agent read 用
      //（v1.1.x 踩过：这里缩成 ~ 短路径、skills[].absPath 校验直接 400「必须是绝对路径」）
      absPath: s.absPath,
      // 展示用短路径（设置页列表 title）、跟数据路径分开
      displayPath: shortenHomePath(s.absPath),
      // project-std 源：所在仓根（删除 API 要回传）
      ...(s.repoPath !== undefined ? { repoPath: s.repoPath } : {}),
      // team 分组：shared:<cat> = clone skills/<cat>；其余 = knowledge/skills/<dir>
      ...(s.teamCategory !== undefined
        ? { teamCategory: s.teamCategory }
        : {}),
      // team 源：带 .flowship-action.json → 安装时顺带挂推进 action
      ...(s.hasActionMarker ? { teamAction: true } : {}),
      // team 源：创建人（共享库 git 首次引入者、小字展示）
      ...(s.author ? { author: s.author } : {}),
    })),
    cursorGlobal,
    appSkillsDir,
  });
};

export const POST = async (req: Request) => {
  let body: { name?: string; content?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return errorResponse("body 不是合法 JSON", 400);
  }
  // as 断言挡不住非 string 的 name / content——.trim() 会 TypeError 变 500、显式验类型
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const content = typeof body.content === "string" ? body.content : "";
  const failure = await writeAppSkill(name, content);
  if (failure) return errorResponse(failure, 400);
  return NextResponse.json({ ok: true });
};

export const DELETE = async (req: Request) => {
  const params = new URL(req.url).searchParams;
  const name = params.get("name")?.trim() ?? "";
  if (!name) return errorResponse("name 必填", 400);
  const rawSource = params.get("source")?.trim() || "app";
  // 类型收窄：不在 SkillSource 枚举里的一律拒绝
  const ALL_SOURCES = [
    "builtin",
    "app",
    "feishu-cli",
    "global-std",
    "project-std",
    "team",
  ] as const;
  if (!ALL_SOURCES.includes(rawSource as (typeof ALL_SOURCES)[number])) {
    return errorResponse(`source 非法：${rawSource}`, 400);
  }
  const source = rawSource as (typeof ALL_SOURCES)[number];
  if (!isManageableSkillSource(source)) {
    return errorResponse(`${source} 来源的 skill 不可删除`, 400);
  }
  const failure = await deleteSkillBySource(name, source, {
    repoPath: params.get("repo")?.trim() || undefined,
  });
  if (failure) return errorResponse(failure, 400);
  return NextResponse.json({ ok: true });
};
