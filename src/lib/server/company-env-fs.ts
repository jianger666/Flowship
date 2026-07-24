/**
 * 公司环境运行时文件：`<dataRoot>/company-env.json`
 *
 * SDK LocalAgentOptions 不支持 env 透传（仅 cloud 有 envVars）——
 * 启动 agent 前把 settings.companyEnv 原子写到本固定路径，skill 脚本从这里读。
 * 不把凭据注入 prompt。
 */

import path from "node:path";

import {
  cloneCompanyEnv,
  emptyCompanyEnv,
  normalizeCompanyEnv,
  buildCompanyEnvBrief,
} from "@/lib/company-env";
import type { CompanyEnv } from "@/lib/types";

import { dataRoot, writePrivateFileAtomic } from "./data-root";
import { readSettingsFile } from "./settings-fs";

export const companyEnvFilePath = (): string =>
  path.join(dataRoot(), "company-env.json");

/**
 * 从 settings 读 companyEnv → 常驻 prompt 声明（无实质配置返空串）。
 * chat / task 注入共用；内部用 {@link buildCompanyEnvBrief} + 本机绝对路径。
 */
export const loadCompanyEnvBriefSection = async (): Promise<string> => {
  try {
    const result = await readSettingsFile();
    if (result.status !== "ok") return "";
    const env = normalizeCompanyEnv(result.settings.companyEnv);
    return buildCompanyEnvBrief(env, companyEnvFilePath());
  } catch {
    return "";
  }
};

/** 同步版：调用方已持有 CompanyEnv（避免重复读盘） */
export const companyEnvBriefFromEnv = (
  env: CompanyEnv | null | undefined,
): string => buildCompanyEnvBrief(env ?? null, companyEnvFilePath());

/** 把 CompanyEnv 原子写到 company-env.json（0600） */
export const writeCompanyEnvFile = async (env: CompanyEnv): Promise<void> => {
  const normalized = normalizeCompanyEnv(env);
  await writePrivateFileAtomic(
    companyEnvFilePath(),
    `${JSON.stringify(normalized, null, 2)}\n`,
  );
};

/**
 * 从 config.json 读 companyEnv 并同步到 company-env.json。
 * Agent.create 前调用；失败只 warn、不挡启动（skill 自己处理缺文件）。
 */
export const syncCompanyEnvFileFromSettings = async (): Promise<void> => {
  try {
    const result = await readSettingsFile();
    let env: CompanyEnv = emptyCompanyEnv();
    if (result.status === "ok") {
      env = normalizeCompanyEnv(result.settings.companyEnv);
    }
    await writeCompanyEnvFile(env);
  } catch (err) {
    console.warn(
      "[company-env-fs] 同步 company-env.json 失败:",
      err instanceof Error ? err.message : err,
    );
  }
};

/** settings PUT 后：用刚落盘的对象同步（避免再读盘） */
export const syncCompanyEnvFileFromObject = async (
  companyEnv: unknown,
): Promise<void> => {
  try {
    await writeCompanyEnvFile(
      cloneCompanyEnv(normalizeCompanyEnv(companyEnv)),
    );
  } catch (err) {
    console.warn(
      "[company-env-fs] 写 company-env.json 失败:",
      err instanceof Error ? err.message : err,
    );
  }
};
