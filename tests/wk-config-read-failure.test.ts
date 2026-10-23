/**
 * wk 设置卡「读取失败不许放行保存」的服务端半边 + 前端接线契约（评审 R3 · FE5）
 *
 * 前端（`use-wk-config`）防得住「HTTP 失败 / 网络抖动 / 响应缺 config」，但它的触发源要真实存在才有用：
 * 之前服务端把**所有**读失败（EACCES / EIO / EISDIR / EMFILE / 云盘离线……）都当成「空配置」返回 200，
 * 前端以为读成功、放行保存；`writeWkConfig` 读 existing 失败也当「首次写入」、以空文件重写，
 * 同事配的其它键和注释整个被抹掉；GET 里的「播种默认 Hub 地址」还会在这种状态下写文件。
 *
 * 现在：
 *  - 只有 ENOENT 才是「空 / 首次写入」；
 *  - 设置页 GET 走 `readWkConfig({ strict: true })`：读不动 → 500 `read_failed`；
 *  - `writeWkConfig`：读 existing 读不动 → 抛、不写（PUT 回 500 `write_failed`）；
 *  - 其它调用方（wk-gate / wk-activate）仍用宽松读（读不到就当没配），行为不变。
 *
 * 「文件存在但读不动」用最可移植的办法造：把配置路径本身建成目录（readFile → EISDIR）。
 */
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_HUB_BASE_URL } from "@/lib/wk-config";

// 把 home 指到临时目录——绝不能碰用户真实的 ~/.wk/config.yaml
const hoisted = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => hoisted.home };
});

const root = path.resolve(import.meta.dirname, "..");
const read = (rel: string): string => readFileSync(path.join(root, rel), "utf-8");

describe("服务端：读不动 ≠ 空配置", () => {
  const dirs: string[] = [];
  const prevDataDir = process.env.FLOWSHIP_DATA_DIR;

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fe-wk-read-failure-"));
    dirs.push(dir);
    hoisted.home = dir;
    process.env.FLOWSHIP_DATA_DIR = path.join(dir, "app-data");
  });

  afterEach(async () => {
    if (prevDataDir === undefined) delete process.env.FLOWSHIP_DATA_DIR;
    else process.env.FLOWSHIP_DATA_DIR = prevDataDir;
    await Promise.all(
      dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })),
    );
  });

  const load = async () => await import("@/lib/server/wk-config");

  /** 配置路径本身是目录：文件「存在」，但 readFile 报 EISDIR（不是 ENOENT） */
  const makeUnreadable = async (): Promise<string> => {
    const { wkConfigPath } = await load();
    const target = wkConfigPath();
    await fs.mkdir(target, { recursive: true });
    return target;
  };

  it("strict 读：EISDIR 抛出（设置页 GET 因此回 500、前端 loadError 有真实触发源）", async () => {
    const { readWkConfig } = await load();
    await makeUnreadable();
    await expect(readWkConfig({ strict: true })).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("strict 读：ENOENT 仍是「没配过」——照常播种默认地址（行为不变）", async () => {
    const { readWkConfig, wkConfigPath } = await load();
    const cfg = await readWkConfig({ strict: true });
    expect(cfg.hubBaseUrl).toBe(DEFAULT_HUB_BASE_URL);
    expect(await fs.readFile(wkConfigPath(), "utf8")).toContain(`base_url: ${DEFAULT_HUB_BASE_URL}`);
  });

  it("宽松读（wk-gate / wk-activate 用）：读不动仍返回空配置、不抛——且不会借播种去覆盖它", async () => {
    const { readWkConfig } = await load();
    const target = await makeUnreadable();
    const cfg = await readWkConfig();
    expect(cfg.hubBaseUrl).toBe("");
    expect(cfg.docRepoPath).toBe("");
    // 路径还是那个目录：没被 rename 成文件，也没留临时文件
    expect((await fs.stat(target)).isDirectory()).toBe(true);
    const siblings = await fs.readdir(path.dirname(target));
    expect(siblings.filter((n) => n.includes(".tmp-"))).toEqual([]);
    // 「默认地址已处理」的标记也不能落（播种没成功、不能谎报已处理——下次文件好了还要播）
    const { dataRoot } = await import("@/lib/server/data-root");
    await expect(
      fs.access(path.join(dataRoot(), "wk-hub-default-applied")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writeWkConfig：读 existing 读不动 → 抛、不覆盖（不再当「首次写入」以空文件重写）", async () => {
    const { writeWkConfig } = await load();
    const target = await makeUnreadable();
    await expect(
      writeWkConfig({ docRepoPath: "/d", hubBaseUrl: "http://h:8088", hubToken: "" }),
    ).rejects.toMatchObject({ code: "EISDIR" });
    expect((await fs.stat(target)).isDirectory()).toBe(true);
    const siblings = await fs.readdir(path.dirname(target));
    expect(siblings.filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  // EISDIR 场景下 rename 本身就会失败、证明不了「读失败不再当首次写入」；真正会被旧实现覆盖的是
  // 「读不动（EACCES）但目录可写」：旧实现 existing="" → 写临时文件 → rename 成功 → 同事的键全没了
  const canChmod = process.platform !== "win32" && process.getuid?.() !== 0;
  it.skipIf(!canChmod)(
    "writeWkConfig：文件在、但无读权限（EACCES）→ 抛、原文件一字不动（旧实现会 rename 覆盖、同事的键全丢）",
    async () => {
      const { writeWkConfig, wkConfigPath } = await load();
      const target = wkConfigPath();
      await fs.mkdir(path.dirname(target), { recursive: true });
      const original = ["# 同事的说明", "doc_repo:", "  provider: gitlab", "  local_path: /old", ""].join("\n");
      await fs.writeFile(target, original, "utf8");
      await fs.chmod(target, 0o000);
      try {
        await expect(
          writeWkConfig({ docRepoPath: "/new", hubBaseUrl: "", hubToken: "" }),
        ).rejects.toMatchObject({ code: "EACCES" });
        await fs.chmod(target, 0o600);
        expect(await fs.readFile(target, "utf8")).toBe(original);
        const siblings = await fs.readdir(path.dirname(target));
        expect(siblings.filter((n) => n.includes(".tmp-"))).toEqual([]);
      } finally {
        await fs.chmod(target, 0o600).catch(() => {});
      }
    },
  );

  it.skipIf(!canChmod)(
    "strict 读 / 路由 GET：无读权限（EACCES）同样回 500，不播种、不写文件",
    async () => {
      const { readWkConfig, wkConfigPath } = await load();
      const { GET } = await import("@/app/api/system/wk-config/route");
      const target = wkConfigPath();
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, "doc_repo:\n  local_path: /old\n", "utf8");
      await fs.chmod(target, 0o000);
      try {
        await expect(readWkConfig({ strict: true })).rejects.toMatchObject({ code: "EACCES" });
        expect((await GET()).status).toBe(500);
        await fs.chmod(target, 0o600);
        expect(await fs.readFile(target, "utf8")).toBe("doc_repo:\n  local_path: /old\n");
      } finally {
        await fs.chmod(target, 0o600).catch(() => {});
      }
    },
  );

  it("writeWkConfig：ENOENT 仍是首次写入（行为不变）", async () => {
    const { writeWkConfig, wkConfigPath } = await load();
    await writeWkConfig({ docRepoPath: "/d", hubBaseUrl: "", hubToken: "" });
    expect(await fs.readFile(wkConfigPath(), "utf8")).toContain("local_path: /d");
  });

  it("writeWkConfig：文件存在且可读 → 键级合并、同事的其它键保留（行为不变）", async () => {
    const { writeWkConfig, wkConfigPath } = await load();
    const target = wkConfigPath();
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(
      target,
      ["# 同事的说明", "doc_repo:", "  provider: gitlab", "  local_path: /old", ""].join("\n"),
      "utf8",
    );
    await writeWkConfig({ docRepoPath: "/new", hubBaseUrl: "", hubToken: "" });
    const raw = await fs.readFile(target, "utf8");
    expect(raw).toContain("# 同事的说明");
    expect(raw).toContain("provider: gitlab");
    expect(raw).toContain("local_path: /new");
  });

  it("路由 GET：读不动 → 500 read_failed；ENOENT → 200", async () => {
    const { GET } = await import("@/app/api/system/wk-config/route");
    await makeUnreadable();
    const bad = await GET();
    expect(bad.status).toBe(500);
    expect(((await bad.json()) as { error: string }).error).toBe("read_failed");

    // 换一个干净 home：没文件 = 200 + 播种后的配置
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fe-wk-read-ok-"));
    dirs.push(dir);
    hoisted.home = dir;
    process.env.FLOWSHIP_DATA_DIR = path.join(dir, "app-data");
    const ok = await GET();
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { config: { hubBaseUrl: string } }).config.hubBaseUrl).toBe(
      DEFAULT_HUB_BASE_URL,
    );
  });

  it("路由 PUT：读 existing 读不动 → 500 write_failed、不覆盖", async () => {
    const { PUT } = await import("@/app/api/system/wk-config/route");
    const target = await makeUnreadable();
    const res = await PUT(
      new Request("http://localhost/api/system/wk-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: { docRepoPath: "", hubBaseUrl: "", hubToken: "" } }),
      }),
    );
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe("write_failed");
    expect((await fs.stat(target)).isDirectory()).toBe(true);
  });
});

describe("源码契约：GET 用 strict 读；其它调用方保持宽松读", () => {
  it("设置页 GET 走 readWkConfig({ strict: true })", () => {
    expect(read("src/app/api/system/wk-config/route.ts")).toContain(
      "readWkConfig({ strict: true })",
    );
  });

  it("wk-gate / wk-activate 不传 strict（读不到当没配，行为不变）", () => {
    for (const rel of ["src/lib/server/wk-gate.ts", "src/lib/server/wk-activate.ts"]) {
      expect(read(rel), rel).not.toMatch(/readWkConfig\(\{[^)]*strict/);
    }
  });

  it("writeWkConfig / readWkConfigFile 只对 ENOENT 放行", () => {
    const src = read("src/lib/server/wk-config.ts");
    expect(src).toContain("const isFileMissing");
    expect(src).toMatch(/if \(strict && !isFileMissing\(err\)\) throw err;/);
    expect(src).toMatch(/if \(!isFileMissing\(err\)\) throw err;/);
  });
});

describe("前端契约：use-wk-config 读失败不放行保存、卡片显示读取失败", () => {
  const hook = read("src/hooks/use-wk-config.ts");
  const card = read("src/components/settings/wk-harness-card.tsx");

  it("save 里有 readOkRef 守卫、且守卫在发请求之前", () => {
    const saveAt = hook.indexOf("const save = useCallback(");
    expect(saveAt).toBeGreaterThanOrEqual(0);
    const body = hook.slice(saveAt);
    const guardAt = body.indexOf("if (!readOkRef.current)");
    const fetchAt = body.indexOf("fetch(");
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(fetchAt).toBeGreaterThan(guardAt);
    expect(body.slice(guardAt, fetchAt)).toContain("return false;");
  });

  it("读取成功才置 readOkRef=true、失败（含重新读取开始时）置 false；loadError 对外暴露", () => {
    expect(hook).toMatch(/readOkRef\.current = true;/);
    expect(hook).toMatch(/readOkRef\.current = false;/);
    expect(hook).toMatch(/return \{[^}]*\bloadError\b[^}]*\breload\b/);
  });

  it("卡片在 loadError 时不画表单、给「重新读取」按钮", () => {
    expect(card).toContain("if (loadError) {");
    expect(card).toContain("重新读取");
    expect(card).toContain("onClick={reload}");
  });
});
