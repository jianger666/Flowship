/**
 * 仓库文件索引走 git 的行为（R14 B6-5 / Q21-01）：真 git、真文件系统、真大仓；git 起不来的情形用「假 git」造真实样本。
 *
 * 为什么要改：改前的目录遍历是按字母序的深度优先、只认一份固定的 denylist、额度 2 万。只要有一个排在 `src` 前面、
 * 又不在名单里的大目录（`aaa-cache/`、`.nuxt/`、`DerivedData/`……），额度被它吃光，`src/` 一条都收不到——
 * `@` 菜单里搜不到任何源码。现在优先用 `git ls-files`：被 .gitignore 的目录，git 根本不会进。
 *
 * 守的是：
 *  ① 改前红的核心（只用改前就有的导出）：2 万多个被 ignore 的文件，不再挤掉源码；
 *  ② 可见集：除下面 4 类（有意 / 已知的差异，详见交接文档里 B6-5 的小节）外，与改前的目录遍历对齐——
 *     4 类 = 被 .gitignore 的文件不再出现（有意：这正是 Q21-01 要的）、空目录不出现（git 不跟踪空目录）、
 *     symlink 会出现（改前遍历不收 symlink）、稀疏检出里没取出的文件仍会出现；
 *     对齐的部分：未跟踪的在、已删 / 改名但没 stage 的旧路径不在、denylist 目录与改前一致、
 *     子目录当 root、嵌套仓库（已知局限：只给目录项）、根上有 `.gitmodules` 就走遍历；
 *  ③ git 不通就退回目录遍历、可见集与改前一致，且不抛错：没同意 Xcode license（`/usr/bin/git` 退出 69，本机真实出现过）、
 *     没装 git、超时、输出超容量、主清单为空、`--deleted` 失败；
 *  ④ 热路径：并发共用一次建索引（主清单 1 次 + `--deleted` 1 次），TTL 内不再拉起 git；
 *  ⑤ 截断：超过上限时丢最深的、带 `truncated`，一路透传到 `searchTaskRepoFiles`。
 *
 * 「假 git」= 临时目录里一个 `git` shell 脚本，放在 PATH 最前面：只用在需要 git 失败 / 很慢 / 输出巨大的用例里，POSIX 才跑。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { REPO_FILES_MAX_ENTRIES } from "@/lib/repo-files-shared";
import {
  filterRepoFiles,
  getRepoFileIndex,
  getRepoFileIndexWithMeta,
  listGitPaths,
  searchTaskRepoFiles,
} from "@/lib/server/repo-files";

const CACHE_KEY = "__flowshipRepoFilesCacheV3__";
const isWindows = process.platform === "win32";

// 在 git hook 里跑测试时这些变量会指向「外层仓」，让测试里的 git 命令全跑偏；
// 顺手隔离用户机器上的 git 配置（autocrlf / hooksPath / 签名之类会让结果因人而异）
const LEAKY_GIT_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_PREFIX",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CEILING_DIRECTORIES",
] as const;
const savedEnv: Record<string, string | undefined> = {};
const savedPath = process.env.PATH;

// macOS 的 tmpdir 在 /var → /private/var 的软链下，统一取 realpath
const TMP = fs.realpathSync.native(
  fs.mkdtempSync(path.join(os.tmpdir(), "flowship-repo-files-git-")),
);

beforeAll(() => {
  for (const k of LEAKY_GIT_ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  const globalCfg = path.join(TMP, "gitconfig-global");
  fs.writeFileSync(globalCfg, "");
  process.env.GIT_CONFIG_GLOBAL = globalCfg;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  // 临时目录万一落在某个 git 仓里，「不是 git 仓」的用例会被外层仓干扰：不许 git 往 TMP 的上层找
  process.env.GIT_CEILING_DIRECTORIES = path.dirname(TMP);
});

afterAll(() => {
  for (const k of LEAKY_GIT_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

const resetCache = (): void => {
  delete (globalThis as Record<string, unknown>)[CACHE_KEY];
};
beforeEach(resetCache);
afterEach(() => {
  // 假 git 把 PATH 改了，每个用例后都还原
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  resetCache();
});

// ---------------------------------------------------------------------- 夹具

const git = (cwd: string, ...args: string[]): void => {
  execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args],
    { cwd, stdio: "ignore" },
  );
};

const put = (root: string, rel: string, body = ""): void => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
};

const mkRepo = (name: string): string => {
  const root = path.join(TMP, name);
  fs.mkdirSync(root, { recursive: true });
  git(root, "init", "-q");
  return root;
};

const commitAll = (root: string, ...pathspecs: string[]): void => {
  git(root, "add", ...pathspecs);
  git(root, "commit", "-q", "-m", "init");
};

/** 索引里的全部路径，排好序便于整体比较 */
const pathsOf = async (root: string): Promise<string[]> =>
  (await getRepoFileIndex(root)).map((e) => e.path).sort();

// ---------------------------------------------------------------------- ① 改前红的核心

describe("被 .gitignore 的大目录不再挤掉源码（Q21-01 的核心；只用改前就有的导出）", () => {
  // 比服务端的 2 万上限多一点：改前遍历会在 `aaa-cache/` 里把额度花光
  const BIG_IGNORED_FILES = 20_050;
  let root = "";

  beforeAll(() => {
    root = mkRepo("big-ignored");
    put(root, ".gitignore", "aaa-cache/\n");
    put(root, "README.md", "# r\n");
    put(root, "src/App.tsx");
    put(root, "src/util.ts");
    const cache = path.join(root, "aaa-cache");
    fs.mkdirSync(cache, { recursive: true });
    for (let i = 0; i < BIG_IGNORED_FILES; i++) {
      fs.writeFileSync(path.join(cache, `f${String(i).padStart(5, "0")}.txt`), "");
    }
    commitAll(root, ".gitignore", "README.md", "src");
  }, 120_000);

  it("排在 src 前面的 2 万多个被 ignore 的文件：src 下的文件照样搜得到，索引里一个 aaa-cache 都没有", async () => {
    const entries = await getRepoFileIndex(root);

    expect(entries.map((e) => e.path).sort()).toEqual([
      ".gitignore",
      "README.md",
      "src/",
      "src/App.tsx",
      "src/util.ts",
    ]);
    expect(filterRepoFiles(entries, "App").map((e) => e.path)).toEqual(["src/App.tsx"]);
  });

  it("没有被截断：被 ignore 的文件根本没进候选，条目数远低于上限", async () => {
    const { entries, truncated } = await getRepoFileIndexWithMeta(root);

    expect(truncated).toBe(false);
    expect(entries.length).toBeLessThan(REPO_FILES_MAX_ENTRIES);
  });
});

// ---------------------------------------------------------------------- ② 可见集

describe("可见集：git 路径与改前的目录遍历对齐", () => {
  it("已跟踪 + 未跟踪都在；被 .gitignore 的、denylist 目录里的（含已跟踪的）都不在；文件名叫 out 的文件不误杀", async () => {
    const root = mkRepo("visible");
    put(root, ".gitignore", "docs/ignored.md\n");
    put(root, "src/App.tsx");
    put(root, "lib/out"); // 文件名恰好叫 out：不是目录，不该被 denylist 误杀
    put(root, "out/tracked.js"); // 已跟踪，但 out/ 在 denylist 里：改前遍历看不见，保持
    put(root, "build/tracked.js"); // 同上
    put(root, "docs/ignored.md");
    put(root, "docs/guide.md");
    commitAll(root, ".gitignore", "src", "lib", "out", "build", "docs/guide.md");
    put(root, "src/new.ts"); // 未跟踪
    put(root, "node_modules/pkg/i.js"); // 未跟踪、也没有 .gitignore 写它：靠 --exclude 剪枝，不能被扫进来
    put(root, "a/node_modules/pkg/i.js"); // 任意一层的 node_modules 都一样

    expect(await pathsOf(root)).toEqual([
      ".gitignore",
      "docs/",
      "docs/guide.md",
      "lib/",
      "lib/out",
      "src/",
      "src/App.tsx",
      "src/new.ts",
    ]);
  });

  it("已跟踪但工作区里已经删了 / 改了名、还没 git add 的旧路径不出现；改名后的新路径出现", async () => {
    const root = mkRepo("deleted");
    put(root, "src/App.tsx");
    put(root, "src/gone.ts");
    put(root, "lib/old.ts");
    commitAll(root, ".");
    fs.rmSync(path.join(root, "src/gone.ts"));
    fs.renameSync(path.join(root, "lib/old.ts"), path.join(root, "lib/renamed.ts"));

    expect(await pathsOf(root)).toEqual(["lib/", "lib/renamed.ts", "src/", "src/App.tsx"]);
  });

  it("整个目录都被删了（还没 git add）：目录本身和里面的文件都不出现", async () => {
    const root = mkRepo("deleted-dir");
    put(root, "keep/a.ts");
    put(root, "dropped/x.ts");
    put(root, "dropped/deep/y.ts");
    commitAll(root, ".");
    fs.rmSync(path.join(root, "dropped"), { recursive: true });

    expect(await pathsOf(root)).toEqual(["keep/", "keep/a.ts"]);
  });

  it("子目录当 root：路径相对这个子目录，兄弟包里的文件不出现", async () => {
    const repo = mkRepo("monorepo");
    put(repo, "README.md");
    put(repo, "packages/web/package.json");
    put(repo, "packages/web/src/index.ts");
    put(repo, "packages/api/src/server.ts");
    commitAll(repo, ".");

    expect(await pathsOf(path.join(repo, "packages/web"))).toEqual([
      "package.json",
      "src/",
      "src/index.ts",
    ]);
  });

  it("未跟踪的嵌套仓库：只给一个目录项，里面的文件不展开（已知局限，钉住现状）", async () => {
    const root = mkRepo("nested-host");
    put(root, "src/App.tsx");
    commitAll(root, "src");
    const nested = path.join(root, "nested");
    fs.mkdirSync(nested, { recursive: true });
    git(nested, "init", "-q");
    put(root, "nested/n.txt");

    expect(await pathsOf(root)).toEqual(["nested/", "src/", "src/App.tsx"]);
  });

  it("根上有 .gitmodules：保持改前行为、直接遍历（子模块里的文件 git 这条路看不到）；没有它就走 git", async () => {
    const root = mkRepo("submodules");
    put(root, "src/App.tsx");
    commitAll(root, "src");
    const sub = path.join(root, "vendor-sub");
    fs.mkdirSync(sub, { recursive: true });
    git(sub, "init", "-q");
    put(root, "vendor-sub/inner.ts");
    put(root, ".gitmodules", '[submodule "vendor-sub"]\n\tpath = vendor-sub\n\turl = ./vendor-sub\n');

    expect(await pathsOf(root)).toContain("vendor-sub/inner.ts");

    fs.rmSync(path.join(root, ".gitmodules"));
    resetCache();
    const viaGit = await pathsOf(root);
    expect(viaGit).toContain("vendor-sub/");
    expect(viaGit).not.toContain("vendor-sub/inner.ts");
  });

  it("空仓（还没有任何文件）：返回空、不抛错", async () => {
    const root = mkRepo("empty-repo");

    expect(await getRepoFileIndexWithMeta(root)).toEqual({ entries: [], truncated: false });
  });

  it("不是 git 仓：退回目录遍历，照样有结果；listGitPaths 明确报「这条路不通」", async () => {
    const root = path.join(TMP, "plain");
    put(root, "p.txt");
    put(root, "sub/q.txt");

    expect(await listGitPaths(root)).toBeNull();
    expect(await pathsOf(root)).toEqual(["p.txt", "sub/", "sub/q.txt"]);
  });
});

// ---------------------------------------------------------------------- ③ git 不通

/** 假 git：listBody / deletedBody 是 sh 片段，分别在「主清单」和「--deleted」两种调用里执行 */
interface FakeGit {
  /** 一个真实存在、没有 .gitmodules 的空目录，当索引的 root */
  root: string;
  /** 每次被调用往里记一行 list / deleted */
  log: string;
}
let fakeSeq = 0;
const installFakeGit = (
  listBody: string | ((dir: string) => string),
  deletedBody = "exit 0",
): FakeGit => {
  const dir = path.join(TMP, `fake-git-${++fakeSeq}`);
  const bin = path.join(dir, "bin");
  const root = path.join(dir, `fake-root-${fakeSeq}`);
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  const log = path.join(dir, "calls.log");
  const script = [
    "#!/bin/sh",
    `LOG='${log}'`,
    'case "$*" in',
    "  *--deleted*)",
    '    echo deleted >> "$LOG"',
    `    ${deletedBody}`,
    "    ;;",
    "  *)",
    '    echo list >> "$LOG"',
    `    ${typeof listBody === "function" ? listBody(dir) : listBody}`,
    "    ;;",
    "esac",
    "",
  ].join("\n");
  const binGit = path.join(bin, "git");
  fs.writeFileSync(binGit, script);
  fs.chmodSync(binGit, 0o755);
  process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ""}`;
  return { root, log };
};

const readCalls = (log: string): { list: number; deleted: number } => {
  const lines = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  return {
    list: lines.filter((l) => l === "list").length,
    deleted: lines.filter((l) => l === "deleted").length,
  };
};

// 本机真实出现过的失败：macOS 升级后没同意 Xcode license，`/usr/bin/git` 直接退出 69
const XCODE_LICENSE_BODY = [
  `echo "You have not agreed to the Xcode license agreements. Please run 'sudo xcodebuild -license' from within a Terminal window to review and agree to the Xcode license agreements before using git." >&2`,
  "exit 69",
].join("\n    ");

describe.skipIf(isWindows)("git 不通就退回目录遍历：可见集与改前一致，不抛错（假 git 造真实样本）", () => {
  it("没同意 Xcode license（git 退出 69）：listGitPaths 判定这条路不通，真仓照样用目录遍历出结果", async () => {
    // 先在真 git 下建好一个真仓，再装假 git：这样既有「被 ignore 的文件」也有「嵌套仓库」，一看就知道走的是遍历
    const root = mkRepo("license-broken");
    put(root, ".gitignore", "docs/ignored.md\n");
    put(root, "src/App.tsx");
    put(root, "docs/ignored.md");
    put(root, "out/x.js");
    put(root, "node_modules/p/i.js");
    commitAll(root, ".gitignore", "src");
    const fake = installFakeGit(XCODE_LICENSE_BODY, XCODE_LICENSE_BODY);

    expect(await listGitPaths(root)).toBeNull();
    // 遍历不读 .gitignore：被 ignore 的 docs/ignored.md 在；denylist 目录（out / node_modules）照旧不在——与改前一致
    expect(await pathsOf(root)).toEqual([
      ".gitignore",
      "docs/",
      "docs/ignored.md",
      "src/",
      "src/App.tsx",
    ]);
    // 假 git 确实被调用过（不是别的原因让它返回了 null）
    expect(readCalls(fake.log).list).toBeGreaterThanOrEqual(1);
  });

  it("系统里根本没有 git（ENOENT）：同样退回遍历", async () => {
    const root = path.join(TMP, "no-git-binary");
    put(root, "a.txt");
    const empty = path.join(TMP, "empty-bin");
    fs.mkdirSync(empty, { recursive: true });
    process.env.PATH = empty;

    expect(await listGitPaths(root)).toBeNull();
    expect(await pathsOf(root)).toEqual(["a.txt"]);
  });

  it("git 卡住（超时）：到点就放弃，不会一直等；返回 null", async () => {
    const fake = installFakeGit("exec sleep 30");
    const t0 = Date.now();

    expect(await listGitPaths(fake.root, { timeoutMs: 150 })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("git 输出超过容量上限（64MiB）：当作失败、不把内存吃满；返回 null", async () => {
    const fake = installFakeGit("exec head -c 70000000 /dev/zero");

    expect(await listGitPaths(fake.root)).toBeNull();
  });

  it("主清单为空（git 成功但什么都没列）：当作这条路不通，由遍历再确认一遍", async () => {
    const fake = installFakeGit("exit 0");

    expect(await listGitPaths(fake.root)).toBeNull();
  });

  it("--deleted 那一次失败（主清单成功）：整体算不通，不拿半份结果", async () => {
    const fake = installFakeGit("printf 'a.ts\\0'", "exit 1");

    expect(await listGitPaths(fake.root)).toBeNull();
  });

  it("--deleted 的输出从主清单里扣掉；--deleted 为空（干净的仓，正常情形）时主清单原样返回", async () => {
    const withDeleted = installFakeGit("printf 'a.ts\\0b.ts\\0'", "printf 'b.ts\\0'");
    expect(await listGitPaths(withDeleted.root)).toEqual(["a.ts"]);

    const clean = installFakeGit("printf 'a.ts\\0b.ts\\0'", "exit 0");
    expect(await listGitPaths(clean.root)).toEqual(["a.ts", "b.ts"]);
  });
});

// ---------------------------------------------------------------------- ④ ⑤ 热路径与截断

/** 假 git 的主清单：20,100 个很深的文件 + 一个浅层的 src/App.tsx（比上限多 100 个以上，必然截断） */
const bigListBody = (dir: string): string => {
  const gen = path.join(dir, "gen.js");
  fs.writeFileSync(
    gen,
    [
      "const out = [];",
      `for (let i = 0; i < ${REPO_FILES_MAX_ENTRIES + 100}; i++) out.push("deep/a/b/f" + String(i).padStart(5, "0") + ".txt");`,
      'out.push("src/App.tsx");',
      'process.stdout.write(out.join("\\0") + "\\0");',
    ].join("\n"),
  );
  return `exec '${process.execPath}' '${gen}'`;
};

describe.skipIf(isWindows)("热路径与截断（假 git 吐 2 万多条路径）", () => {
  it("超过上限：只留 REPO_FILES_MAX_ENTRIES 条、truncated=true；留下的是浅层的，丢的是最深的", async () => {
    const fake = installFakeGit(bigListBody);

    const { entries, truncated } = await getRepoFileIndexWithMeta(fake.root);
    const got = new Set(entries.map((e) => e.path));

    expect(truncated).toBe(true);
    expect(entries.length).toBe(REPO_FILES_MAX_ENTRIES);
    expect(got.has("src/App.tsx")).toBe(true); // 浅层优先：不会被 2 万个深层文件挤掉
    expect(got.has("src/")).toBe(true);
    expect(got.has("deep/a/b/")).toBe(true); // 祖先目录都在
    expect(got.has("deep/a/b/f00000.txt")).toBe(true);
    expect(got.has(`deep/a/b/f${String(REPO_FILES_MAX_ENTRIES + 99).padStart(5, "0")}.txt`)).toBe(false);
  });

  it("searchTaskRepoFiles 把 truncated 透传出来；候选照常按 query 过滤", async () => {
    const fake = installFakeGit(bigListBody);

    expect(await searchTaskRepoFiles([fake.root], "App")).toEqual({
      files: [{ path: "src/App.tsx", isDir: false }],
      truncated: true,
    });
  });

  it("多仓：任何一个仓被截断就算 truncated；候选带仓短名前缀；只查没被截断的那个仓则是 false", async () => {
    const fake = installFakeGit(bigListBody);
    // 第二个仓有 .gitmodules → 直接遍历（不碰假 git），小、不会被截断
    const small = path.join(TMP, "walk-small");
    put(small, ".gitmodules");
    put(small, "src/App.tsx");

    const both = await searchTaskRepoFiles([fake.root, small], "App");
    expect(both.truncated).toBe(true);
    expect(both.files.map((f) => f.path).sort()).toEqual(
      [`${path.basename(fake.root)}/src/App.tsx`, "walk-small/src/App.tsx"].sort(),
    );

    const onlySmall = await searchTaskRepoFiles([small], "App");
    expect(onlySmall).toEqual({ files: [{ path: "src/App.tsx", isDir: false }], truncated: false });
  });

  it("没被截断时 truncated 明确是 false（不是缺省）；任务没有任何仓时返回空结果", async () => {
    const small = path.join(TMP, "walk-tiny");
    put(small, ".gitmodules");
    put(small, "a.ts");

    expect((await searchTaskRepoFiles([small], "")).truncated).toBe(false);
    expect(await searchTaskRepoFiles([], "x")).toEqual({ files: [], truncated: false });
  });

  it("并发三次共用一次建索引（主清单 1 次 + --deleted 1 次）；TTL 内再取不再拉起 git；清缓存后才重新建", async () => {
    const fake = installFakeGit("sleep 0.2; printf 'a.ts\\0'", "exit 0");

    await Promise.all([
      getRepoFileIndexWithMeta(fake.root),
      getRepoFileIndexWithMeta(fake.root),
      getRepoFileIndexWithMeta(fake.root),
    ]);
    expect(readCalls(fake.log)).toEqual({ list: 1, deleted: 1 });

    await getRepoFileIndexWithMeta(fake.root);
    expect(readCalls(fake.log)).toEqual({ list: 1, deleted: 1 });

    resetCache();
    await getRepoFileIndexWithMeta(fake.root);
    expect(readCalls(fake.log)).toEqual({ list: 2, deleted: 2 });
  });
});
