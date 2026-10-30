/**
 * R14 B2-1 · Q9-10（meta.json 部分）：带 UTF-8 BOM 的 meta.json 不再被判成损坏。
 *
 * 为什么逐个读取点测：meta 的解析点有 7 处——parseMetaText（.bak 校验 / 损坏识别）、readMetaRaw（正常读的主路径，
 * 审查报告没点名）、parseMetaEvidence（删除证据三态）、readSessionAgentIdSync、sdk-store-gc 的 collectLiveAgentIds、
 * 存储统计路由、启动迁移 migrate-username-templates（审查 AI 预读时补出的第 7 处）。只修其一会出现「校验说有效、主路径说解析失败」，或「任务活了、它的 SDK store 却不在活名单里」
 * ——后者会让 GC 把一个活任务的 store 当孤儿清掉。
 *
 * 另一条数据保护：改前 BOM 的有效 meta 会被 parseMetaText 判损坏，启动恢复时如果有 .bak，
 * 会用旧备份**覆盖**用户手改过的主文件（restoreMetaFromBackup）。
 *
 * 并行隔离：DATA_DIR 在 task-fs-core 加载时冻结，必须先钉 FLOWSHIP_DATA_DIR 再动态 import。
 */
import { mkdtempSync, promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-bom-meta-"));
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

const {
  DATA_DIR,
  META_BACKUP_FILE,
  META_FILE,
  inspectMetaCorruptionSync,
  readMetaRaw,
  readMetaV06,
  readMetaV06Evidence,
  readMetaV06EvidenceSync,
  readSessionAgentIdSync,
  restoreMetaFromBackup,
  taskDir,
} = await import("@/lib/server/task-fs-core");
const { migrateUsernameBranchTemplates } = await import(
  "@/lib/server/migrate-username-templates"
);
const { collectLiveAgentIds } = await import("@/lib/server/sdk-store-gc");

if (!DATA_DIR.startsWith(TMP_ROOT)) {
  throw new Error(`bom-meta DATA_DIR 未隔离到 TMP：${DATA_DIR}`);
}

const BOM = "\uFEFF";

const baseMeta = (
  id: string,
  title: string,
  over: Partial<TaskMetaV06> = {},
): TaskMetaV06 => ({
  id,
  title,
  repoStatus: "developing",
  runStatus: "idle",
  currentActionId: null,
  actions: [],
  mrs: [],
  repoPaths: [],
  createdAt: 1_000,
  updatedAt: 1_000,
  ...over,
});

const writeRaw = async (id: string, file: string, text: string): Promise<void> => {
  await fs.mkdir(taskDir(id), { recursive: true });
  await fs.writeFile(path.join(taskDir(id), file), text, "utf-8");
};

describe("meta.json 带 BOM：每个读取点都要读得出来", () => {
  it("自检：BOM + 合法 JSON 直接 JSON.parse 会抛（否则下面所有 BOM 用例都在空转）", () => {
    expect(() => JSON.parse(`${BOM}${JSON.stringify(baseMeta("x", "t"))}`)).toThrow();
  });

  it("主读取路径 readMetaRaw / readMetaV06", async () => {
    const id = "bom-main";
    await writeRaw(id, META_FILE, BOM + JSON.stringify(baseMeta(id, "手改过的标题")));
    expect(await readMetaRaw(id)).toMatchObject({ id, title: "手改过的标题" });
    expect(await readMetaV06(id)).toMatchObject({ id, title: "手改过的标题" });
  });

  it("删除证据三态 readMetaV06Evidence / Sync：读到 valid（不是 unknown）", async () => {
    const id = "bom-evidence";
    await writeRaw(id, META_FILE, BOM + JSON.stringify(baseMeta(id, "t")));
    expect((await readMetaV06Evidence(id)).kind).toBe("valid");
    expect(readMetaV06EvidenceSync(id).kind).toBe("valid");
  });

  it("损坏识别 inspectMetaCorruptionSync：内容有效、只是带 BOM → 不算损坏", async () => {
    const id = "bom-inspect";
    await writeRaw(id, META_FILE, BOM + JSON.stringify(baseMeta(id, "t")));
    expect(inspectMetaCorruptionSync(id)).toBeNull();
  });

  it("readSessionAgentIdSync：读到盘上的 sessionAgentId", async () => {
    const id = "bom-agent";
    await writeRaw(
      id,
      META_FILE,
      BOM + JSON.stringify(baseMeta(id, "t", { sessionAgentId: "agent-bom-1" })),
    );
    expect(readSessionAgentIdSync(id)).toBe("agent-bom-1");
  });

  it("SDK store GC 的活名单 collectLiveAgentIds：BOM meta 的 sessionAgentId 在名单里（否则活任务的 store 会被当孤儿）", async () => {
    const id = "bom-live";
    // 独立的 tasks 目录：共用 DATA_DIR 的话，其它用例留下的坏 meta 会让整轮返回 null（读不出 = 跳过本轮 GC）
    const tasksDir = mkdtempSync(path.join(os.tmpdir(), "fe-bom-live-"));
    try {
      await fs.mkdir(path.join(tasksDir, id), { recursive: true });
      await fs.writeFile(
        path.join(tasksDir, id, META_FILE),
        BOM +
          JSON.stringify(baseMeta(id, "t", { sessionAgentId: "agent-bom-live" })),
        "utf-8",
      );
      const live = await collectLiveAgentIds(tasksDir);
      expect(live?.has("agent-bom-live")).toBe(true);
    } finally {
      await fs.rm(tasksDir, { recursive: true, force: true });
    }
  });

  it("仅有 BOM 的文件仍按「为空」处理（去 BOM 不会把它变成别的错）", async () => {
    const id = "bom-only";
    await writeRaw(id, META_FILE, BOM);
    await expect(readMetaRaw(id)).rejects.toThrow(/为空/);
    expect(inspectMetaCorruptionSync(id)).toMatchObject({ kind: "empty" });
  });

  it("真坏的 JSON（带 BOM）仍然报解析失败 / invalid_json", async () => {
    const id = "bom-broken";
    await writeRaw(id, META_FILE, `${BOM}{"id": `);
    await expect(readMetaRaw(id)).rejects.toThrow(/解析失败/);
    expect(inspectMetaCorruptionSync(id)).toMatchObject({ kind: "invalid_json" });
  });

  it("存储统计路由（读 meta 取标题 / 状态）经 stripBom——源码契约：它的 GET 要 du / 扫工作区，不适合在单测里直接调", () => {
    const src = readFileSync(
      path.join(process.cwd(), "src/app/api/system/storage/route.ts"),
      "utf-8",
    );
    expect(src).toContain(
      'stripBom(await fs.readFile(path.join(dir, META_FILE), "utf8"))',
    );
  });

  it("启动迁移 migrateUsernameBranchTemplates：BOM 的 meta 照样被迁移，不当「损坏」跳过（改前：用户名模板永远清不掉）", async () => {
    const id = "bom-migrate";
    await writeRaw(
      id,
      META_FILE,
      BOM +
        JSON.stringify(
          baseMeta(id, "t", {
            repoBranchTemplates: {
              "repo-a": "feat/{username}/x",
              "repo-b": "fix/y",
            },
          }),
        ),
    );
    // 同一个 tasks 目录里还有别的用例留下的坏 meta：它们被跳过（warn），不影响这条；所以只断言 ≥ 1
    expect(await migrateUsernameBranchTemplates()).toBeGreaterThanOrEqual(1);
    const after = JSON.parse(
      readFileSync(path.join(taskDir(id), META_FILE), "utf-8"),
    ) as TaskMetaV06;
    expect(after.repoBranchTemplates).toEqual({ "repo-b": "fix/y" });
  });
});

describe("BOM 的 meta 与 .bak 的互动（数据保护）", () => {
  it("主文件是 BOM + 有效内容、.bak 也有效：restoreMetaFromBackup 不覆盖主文件（改前会用旧备份覆盖用户的手改）", async () => {
    const id = "bom-no-restore";
    await writeRaw(id, META_FILE, BOM + JSON.stringify(baseMeta(id, "用户手改后的标题")));
    await writeRaw(id, META_BACKUP_FILE, JSON.stringify(baseMeta(id, "旧备份的标题")));
    expect(await restoreMetaFromBackup(id)).toBe("not_needed");
    const after = await fs.readFile(path.join(taskDir(id), META_FILE), "utf-8");
    expect(after).toContain("用户手改后的标题");
    expect(after).not.toContain("旧备份的标题");
  });

  it("主文件真坏、.bak 是 BOM + 有效内容：backupValid=true，restore 恢复后主路径读得出", async () => {
    const id = "bom-bak";
    await writeRaw(id, META_FILE, "{not json");
    await writeRaw(
      id,
      META_BACKUP_FILE,
      BOM + JSON.stringify(baseMeta(id, "备份标题")),
    );
    expect(inspectMetaCorruptionSync(id)).toMatchObject({
      kind: "invalid_json",
      backupValid: true,
    });
    expect(await restoreMetaFromBackup(id)).toBe("restored");
    expect(await readMetaV06(id)).toMatchObject({ id, title: "备份标题" });
  });
});
