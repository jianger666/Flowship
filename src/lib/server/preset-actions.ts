/**
 * 出厂预置 custom action + skill 安装（启动幂等）
 *
 * 判定：`<dataRoot>/presets-installed.json` 记「装过哪些预置」。
 * - 已记过 → 永不重写（用户改过 / 删过都不覆盖）
 * - 未记过且定义已存在 → 只补记、不覆盖内容
 * - 未记过且不存在 → 写入预置 + 记装过
 *
 * action / skill 记账互相独立：删 skill 不重装、删 action 不重装。
 * 用户主动点「改bug」发现缺失时走 `reinstallBuiltinFixBugPreset`（跳记账早退、恢复出厂）。
 *
 * 存储收敛后：挂载壳写在 `skills/fix-bug/.flowship-action.json`，派生 id=`app:fix-bug`；
 * 记账 key 仍用历史 `builtin-fix-bug`（BUILTIN_FIX_BUG_ACTION_PRESET_ID）防重复安装。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import {
  BUILTIN_FIX_BUG_ACTION_ID,
  BUILTIN_FIX_BUG_ACTION_PRESET_ID,
  BUILTIN_FIX_BUG_SKILL,
  BUILTIN_FIX_BUG_SKILL_PRESET_ID,
} from "@/lib/mr-inbox";
import { isFixBugPresetUsable } from "@/lib/fix-bug-preset-usable";
import { listSkillsWithSource, writeAppSkill } from "./app-skills";
import {
  ensureCustomActionById,
  getCustomAction,
  removeActionShell,
  updateCustomAction,
} from "./custom-action-fs";
import { dataRoot, writePrivateFileAtomic } from "./data-root";
import {
  PRESET_FIX_BUG_SKILL_CONTENT,
  PRESET_FIX_BUG_SKILL_CONTENT_LEGACY_V1,
} from "./preset-skill-fix-bug";
import { findSkillByName, getAppSkillsDir } from "./skills-loader";

const presetsFilePath = (): string =>
  path.join(dataRoot(), "presets-installed.json");

type PresetsMap = Record<string, number>;

/** ensure / reinstall 共用：skipLedger=true 时跳过「已记过就早退」 */
type EnsureOpts = {
  skipLedger?: boolean;
};

const readPresets = async (): Promise<PresetsMap> => {
  try {
    const raw = await fs.readFile(presetsFilePath(), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: PresetsMap = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
      }
      return out;
    }
  } catch {
    // 缺文件 / 坏 JSON → 空
  }
  return {};
};

/**
 * 记 / 刷新预置安装时间戳。
 * refresh=true：已有记录也覆盖时间（用户主动重装要刷新）。
 */
const markPresetInstalled = async (
  id: string,
  opts?: { refresh?: boolean },
): Promise<void> => {
  const cur = await readPresets();
  if (cur[id] && !opts?.refresh) return;
  const next = { ...cur, [id]: Date.now() };
  await writePrivateFileAtomic(presetsFilePath(), JSON.stringify(next, null, 2));
};

/** 「改bug」预置 action 挂载壳内容（ensure / reinstall 共用、避免两份漂移） */
const FIX_BUG_ACTION_INPUT = {
  label: "改bug",
  skill: BUILTIN_FIX_BUG_SKILL,
  placeholder: "可贴 bug 链接 / 补充复现说明…",
  output: [
    "## 问题定位",
    "- 复现路径：",
    "- 根因：",
    "",
    "## 修复方案",
    "- 改动说明：",
    "",
    "## 验证",
    "- 自检结果：",
  ].join("\n"),
} as const;

/**
 * 确保「改bug」skill 已装到 app 自管目录。
 * 默认：记账早退（用户删过不重装）；skipLedger：目录缺失才写模板、已有不覆盖。
 */
const ensureBuiltinFixBugSkill = async (
  opts?: EnsureOpts,
): Promise<void> => {
  if (!opts?.skipLedger) {
    const installed = await readPresets();
    if (installed[BUILTIN_FIX_BUG_SKILL_PRESET_ID]) return;
  }

  const skillDir = path.join(getAppSkillsDir(), BUILTIN_FIX_BUG_SKILL);
  let dirExists = false;
  try {
    const st = await fs.stat(skillDir);
    dirExists = st.isDirectory();
  } catch {
    dirExists = false;
  }

  if (!dirExists) {
    const failure = await writeAppSkill(
      BUILTIN_FIX_BUG_SKILL,
      PRESET_FIX_BUG_SKILL_CONTENT,
    );
    if (failure) throw new Error(failure);
    console.log(
      `[presets] 已安装出厂预置 skill：${BUILTIN_FIX_BUG_SKILL}`,
    );
  }

  await markPresetInstalled(BUILTIN_FIX_BUG_SKILL_PRESET_ID, {
    refresh: !!opts?.skipLedger,
  });
};

/**
 * 一次性 label 校正：旧默认「修 BUG」→「改bug」；用户自己改过的不动。
 * 与记账无关、每次启动幂等跑一次。
 */
const maybeRelabelFixBugAction = async (): Promise<void> => {
  const existing = await getCustomAction(BUILTIN_FIX_BUG_ACTION_ID);
  if (!existing || existing.legacyPlaybook) return;
  if (existing.label !== "修 BUG") return;
  await updateCustomAction(BUILTIN_FIX_BUG_ACTION_ID, { label: "改bug" });
  console.log(
    `[presets] 已校正预置 action label：修 BUG → 改bug`,
  );
};

/**
 * 存量出厂 skill 一次性升级到 v2：磁盘内容 trim 后与 LEGACY_V1 精确相等才覆盖。
 */
const maybeUpgradeFixBugSkillContent = async (): Promise<void> => {
  const skillPath = path.join(
    getAppSkillsDir(),
    BUILTIN_FIX_BUG_SKILL,
    "SKILL.md",
  );
  let raw: string;
  try {
    raw = await fs.readFile(skillPath, "utf-8");
  } catch {
    return;
  }
  if (raw.trim() !== PRESET_FIX_BUG_SKILL_CONTENT_LEGACY_V1.trim()) return;
  const failure = await writeAppSkill(
    BUILTIN_FIX_BUG_SKILL,
    PRESET_FIX_BUG_SKILL_CONTENT,
  );
  if (failure) {
    console.warn(`[presets] 升级出厂 skill fix-bug 失败：${failure}`);
    return;
  }
  console.log(`[presets] 已升级出厂 skill：${BUILTIN_FIX_BUG_SKILL} → v2`);
};

/**
 * 确保「改bug」预置挂载壳已装（skills/fix-bug/.flowship-action.json）。
 * 记账用 PRESET_ID；存在性用派生 id app:fix-bug。
 */
const ensureBuiltinFixBugAction = async (
  opts?: EnsureOpts,
): Promise<void> => {
  if (!opts?.skipLedger) {
    const installed = await readPresets();
    if (installed[BUILTIN_FIX_BUG_ACTION_PRESET_ID]) return;
  }

  const existing = await getCustomAction(BUILTIN_FIX_BUG_ACTION_ID);
  if (existing) {
    await markPresetInstalled(BUILTIN_FIX_BUG_ACTION_PRESET_ID, {
      refresh: !!opts?.skipLedger,
    });
    return;
  }

  // ensure 忽略 id 路径、写到 skills/<skill>/；任意 id 均可
  await ensureCustomActionById(BUILTIN_FIX_BUG_ACTION_ID, {
    ...FIX_BUG_ACTION_INPUT,
  });
  await markPresetInstalled(BUILTIN_FIX_BUG_ACTION_PRESET_ID, {
    refresh: !!opts?.skipLedger,
  });
  console.log(
    `[presets] 已安装出厂预置 custom action：${BUILTIN_FIX_BUG_ACTION_ID}`,
  );
};

/** 启动入口：skill + action 互相独立记账，再做 label 校正 + 存量 skill 内容升级 */
export const ensureBuiltinFixBugPreset = async (): Promise<void> => {
  await ensureBuiltinFixBugSkill();
  await ensureBuiltinFixBugAction();
  await maybeRelabelFixBugAction();
  await maybeUpgradeFixBugSkillContent();
};

/**
 * 覆盖写出厂「改bug」挂载壳。
 * 先 removeActionShell 再 ensure（覆盖语义；legacy 旧目录不在此路径）。
 */
const writeFixBugActionFactoryShell = async (): Promise<void> => {
  const existing = await getCustomAction(BUILTIN_FIX_BUG_ACTION_ID);
  if (existing) {
    // 覆盖：删壳再 ensure（update 也行，但 ensure 路径更贴「出厂重装」）
    await removeActionShell(BUILTIN_FIX_BUG_SKILL);
  }
  await ensureCustomActionById(BUILTIN_FIX_BUG_ACTION_ID, {
    ...FIX_BUG_ACTION_INPUT,
  });
};

/**
 * 用户主动重装「改bug」预置（仅 confirm 弹窗确认后调用、覆盖语义成立）。
 *
 * 判定口径与客户端 `isFixBugPresetUsable` / `checkFixBugPreset` 一致：
 * - skill：`name=fix-bug` 不可见 → 覆盖写模板
 * - action：四条不全满足 → 整体写出厂壳
 */
export const reinstallBuiltinFixBugPreset = async (): Promise<void> => {
  const fixBugVisible = await findSkillByName(BUILTIN_FIX_BUG_SKILL);
  if (!fixBugVisible) {
    const failure = await writeAppSkill(
      BUILTIN_FIX_BUG_SKILL,
      PRESET_FIX_BUG_SKILL_CONTENT,
    );
    if (failure) throw new Error(failure);
    console.log(`[presets] 已恢复出厂 skill：${BUILTIN_FIX_BUG_SKILL}`);
  }

  const existing = await getCustomAction(BUILTIN_FIX_BUG_ACTION_ID);
  const visibleNames = new Set(
    (await listSkillsWithSource()).map((s) => s.name),
  );
  const usable = isFixBugPresetUsable({
    action: existing,
    visibleSkillNames: visibleNames,
  });
  if (!usable) {
    await writeFixBugActionFactoryShell();
    console.log(
      `[presets] 已恢复出厂 custom action：${BUILTIN_FIX_BUG_ACTION_ID}`,
    );
  }

  await markPresetInstalled(BUILTIN_FIX_BUG_SKILL_PRESET_ID, { refresh: true });
  await markPresetInstalled(BUILTIN_FIX_BUG_ACTION_PRESET_ID, { refresh: true });
};
