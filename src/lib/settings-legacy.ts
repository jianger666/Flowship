/**
 * 设置「归一」里 client（local-store.normalizeSettings）与 server（settings-fs.patchSettingsFile）共用的几块：
 * 退役键表、defaultModel 读出校验、PATCH 合并后的补全 / 升级。
 *
 * 为什么要共用：第三轮把保存从「整包 PUT」改成「字段级 PATCH」后，PUT 路径上客户端 normalizeSettings
 * 顺带做的事（清退役键、旧单槽 customProvider 升级、必备三项补默认）在 PATCH 路径上没人做了——
 * 遗留键永驻、明文旧单槽 key 留盘、删光提供方后旧单槽「复活」、盘上缺必备项时每次保存恒 400（第四轮 Q2-03 / Q2-05）。
 * 两条路径必须用同一张表、同一套判定，否则会再次漂移。
 *
 * 无 Node-only / 浏览器依赖（client / server 都 import）。
 */

import { migrateProviderSettings } from "./agent-provider";
import type { ModelSelection } from "./types";

/**
 * 已退役的顶层键：读取时忽略、落盘时抹掉。
 * username：V0.12.x 已删；gitHost：host 按任务仓库 remote 现推；groupCollab：三个群协作开关砍掉；
 * customProvider：旧单槽，已迁进 customProviders[]（迁完必须抹掉，否则明文 key 留盘 + 删光列表后复活）。
 */
export const RETIRED_SETTINGS_KEYS = [
  "username",
  "gitHost",
  "groupCollab",
  "customProvider",
] as const;

/**
 * defaultModel 读出校验：必须是 `{ id: string }` 形态，否则回 `{ id: "" }`。
 * 老 schema 兼容（V0.5.12.2 删）：以前 defaultModel 是纯 string，残留就重配。
 */
export const readDefaultModel = (raw: unknown): ModelSelection => {
  if (
    raw &&
    typeof raw === "object" &&
    "id" in raw &&
    typeof (raw as { id: unknown }).id === "string"
  ) {
    return raw as ModelSelection;
  }
  return { id: "" };
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/**
 * PATCH 合并后、校验落盘前的归一（与客户端 normalizeSettings 同口径的最小子集，不凭空给没有的键加默认）：
 *  1. 必备三项补默认：apiKey 非字符串 → ""；defaultModel 不是 `{ id: string }` → `{ id: "" }`（旧字符串 / 缺失）；
 *     repos 非数组 → []，数组里的非对象项丢掉。盘上缺其中之一不再让每次保存恒 400。
 *  2. 提供方升级：旧单槽 `customProvider` → customProviders[]、`provider: "custom"` → 迁后那条 id、
 *     指向不存在 / 没填地址条目的 provider → cursor（都是 migrateProviderSettings 的职责）。
 *     只在盘上本来就有这些键、或迁移结果非空时才写回，不给从没配过提供方的配置凭空加 `provider` / `customProviders`。
 *  3. 退役键抹掉。
 *
 * `touchedKeys`：本次补丁碰过的键——这些键的值原样交给后面的校验（坏值 400），只补「盘上本来就缺 / 坏」的必备项。
 * `customProvidersExplicit`：本次补丁显式写了 customProviders（含 `[]`）——它是权威，必须**先**丢掉旧单槽再迁移，
 * 否则删光提供方（`customProviders: []`）时 migrateProviderSettings 会把旧单槽重新升级出来，已删条目「复活」。
 */
export const normalizeMergedSettingsForPatch = (
  merged: Record<string, unknown>,
  opts: {
    /** 本次补丁写 / 删的键（patch 键 + remove 键） */
    touchedKeys: ReadonlySet<string>;
    customProvidersExplicit: boolean;
  },
): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...merged };

  // 只补「盘上本来就缺 / 坏」的必备项；本次补丁自己写的值保持原样交给校验——
  // 客户端 bug 把 repos 写成字符串应当 400 拒绝，而不是被悄悄补成 [] 把仓库清空
  const touched = opts.touchedKeys;
  if (!touched.has("apiKey")) {
    out.apiKey = typeof out.apiKey === "string" ? out.apiKey : "";
  }
  if (!touched.has("defaultModel")) out.defaultModel = readDefaultModel(out.defaultModel);
  if (!touched.has("repos")) {
    out.repos = Array.isArray(out.repos)
      ? out.repos.filter((r) => isPlainObject(r))
      : [];
  }

  if (opts.customProvidersExplicit) delete out.customProvider;
  const migrated = migrateProviderSettings(out);
  if ("provider" in out || migrated.provider !== "cursor") {
    out.provider = migrated.provider;
  }
  if ("customProviders" in out || migrated.customProviders.length > 0) {
    out.customProviders = migrated.customProviders;
  }

  for (const k of RETIRED_SETTINGS_KEYS) delete out[k];
  return out;
};
