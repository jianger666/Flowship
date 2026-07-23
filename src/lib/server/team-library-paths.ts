/**
 * 组共享库路径 + skill 名白名单（零业务依赖）
 *
 * 为什么独立小模块、不放进 team-library.ts：
 *   skills-loader / custom-action-fs / team-library 都要拼
 *   `<dataRoot>/team-library/repo`；若路径 helper 挂在 team-library，
 *   skills-loader import 它会与「team-library → skills-loader」形成循环。
 * 本模块只依赖 data-root + path，三方可安全引用。
 */

import path from "node:path";

import { dataRoot } from "./data-root";

export const teamLibraryRoot = (): string =>
  path.join(dataRoot(), "team-library");

export const teamLibraryRepoDir = (): string =>
  path.join(teamLibraryRoot(), "repo");

export const teamLibraryKnowledgeSrcDir = (): string =>
  path.join(teamLibraryRoot(), "knowledge-src");

/** 共享库内组沉淀 skills/ */
export const getTeamLibrarySkillsDir = (): string =>
  path.join(teamLibraryRepoDir(), "skills");

/** 知识库镜像内 skills/（agent 用相对路径时需配 kbRoot） */
export const getTeamLibraryKnowledgeSkillsDir = (): string =>
  path.join(teamLibraryRepoDir(), "knowledge", "skills");

/** knowledge/ 根（kbRoot 指向这里） */
export const getTeamLibraryKnowledgeRoot = (): string =>
  path.join(teamLibraryRepoDir(), "knowledge");

/**
 * skill 名白名单（与 app-skills 的 isSafeSkillName 同构、放此处避免循环 import）：
 * 字母数字中文 + ._-、首字符不能是点（拦 `..`）；天然拒绝 / 与 \（路径穿越）。
 */
export const isSafeTeamSkillName = (name: string): boolean =>
  /^[a-zA-Z0-9\u4e00-\u9fa5][a-zA-Z0-9\u4e00-\u9fa5._-]{0,63}$/.test(name);
