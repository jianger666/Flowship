/**
 * `@` 文件联想 · git 优先建索引的补洞用例（R14 B6-5 / Q21-01）。
 *
 * 起因：B6-5 自己做的变异验证里，下面这些变异被所有既有用例放过——它们改了之后，**最终的索引条目和改前一模一样**
 * （git 的参数 / 环境 / 容量选项、退回遍历的分支、缓存的过期），光看 `getRepoFileIndex` 的结果测不出来；
 * 必须看 git 这一层的原始清单、子进程真正看到的环境变量，或者时间推进之后的行为：
 *   G5  主清单不带 denylist 的 `--exclude=<名>/`        → 新仓（还没有 .gitignore）里未跟踪的 node_modules 被整个列进来
 *   G6  `--exclude=` 去掉尾部 `/`                        → 连「名字恰好叫 out / build 的未跟踪**文件**」也被排掉
 *   G9  去掉 `GIT_OPTIONAL_LOCKS=0`                     → 和用户 / agent 的 git 抢 index 锁
 *   G11 execFile 去掉 maxBuffer、G12 上限缩到 1MiB      → 1MiB 以上的清单（大仓很常见）被当成失败、白白退回遍历
 *   B3  git 过滤后一条不剩也不让遍历再确认
 *   B5  退回遍历时上限写成 100
 *   C2  TTL 永不过期、C7 建好后不清 in-flight           → 60 秒之后仍读到旧索引
 *   C4  缓存里不存 truncated、C6 命中缓存时返回 truncated=false → 截断提示在第二次打开菜单时消失
 *   S11 遍历时某个子目录读不了就整个中止          → 一个没权限的目录让它后面的兄弟目录全丢
 *   S12 遍历的默认上限写成一千万                  → 退回遍历时大仓不再有上限、不再 truncated
 *   S13 遍历时把 FIFO / socket 当普通文件收        → 菜单里出现选了也读不了的「文件」
 *   S5  遍历时同一层的条目不排序（交给文件系统）   → 额度用完时留下的不是字母序靠前的。POSIX 上 libuv 的 scandir
 *       已经按字节序排过一遍，所以去掉 `entries.sort` 在真实目录里几乎看不出来；这一条得把「文件系统吐出的顺序」
 *       固定成倒序（在 `fs.promises.readdir` 这个边界上注入）才测得到。macOS 的文件系统大小写不敏感，也没法靠大小写混排造差异
 *   RT5 路由不把合法的 `root` 参数交给搜索         → 选了某个仓却搜到全部仓
 * 不测（已在交接文档里 B6-5 的小节披露）：
 *   G15 `windowsHide` 只在 Windows 上才有可观察的效果（要看到它得 mock `execFile` 的选项，本批不为它写）。
 * （`humanItems` 的「整五千」「非整万」分支也不在这里：它没导出，靠 mock `REPO_FILES_MAX_ENTRIES`，在 at-mention-truncated.test.ts 里测。）
 *
 * 全部是行为级：真 git + 假 git（PATH 最前面的 shell 脚本，POSIX 才跑）；只有路由那一条 mock 了 `task-fs.getTaskMeta`
 * （造 task 元数据），搜索与索引都是真的。夹具照 `repo-files-git-index.test.ts` 的写法（各测试文件自带，互不依赖）。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { REPO_FILES_MAX_ENTRIES } from "@/lib/repo-files-shared";
import {
  getRepoFileIndex,
  getRepoFileIndexWithMeta,
  listGitPaths,
  scanRepoRoot,
} from "@/lib/server/repo-files";

// 只造 task 元数据；repo-files 本身不 mock（RT5 要看真实的「只搜这一个仓」）
const { getTaskMeta } = vi.hoisted(() => ({ getTaskMeta: vi.fn() }));
vi.mock("@/lib/server/task-fs", () => ({ getTaskMeta }));
const repoFilesRoute = await import("@/app/api/repo-files/route");

const CACHE_KEY = "__flowshipRepoFilesCacheV3__";
const isWindows = process.platform === "win32";

// 隔离外层 git 环境 / 用户的 git 配置；另外清掉 GIT_OPTIONAL_LOCKS，免得宿主进程里本来就有它、让 G9 的断言空转
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
  "GIT_OPTIONAL_LOCKS",
  "GIT_TERMINAL_PROMPT",
] as const;
const savedEnv: Record<string, string | undefined> = {};
const savedPath = process.env.PATH;

// macOS 的 tmpdir 在 /var → /private/var 的软链下，统一取 realpath
const TMP = fs.realpathSync.native(
  fs.mkdtempSync(path.join(os.tmpdir(), "flowship-repo-files-gaps-")),
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
  vi.useRealTimers();
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

/** 索引里的全部路径，排好序便于整体比较 */
const pathsOf = async (root: string): Promise<string[]> =>
  (await getRepoFileIndex(root)).map((e) => e.path).sort();

let fakeSeq = 0;

/**
 * 假 git：listBody / deletedBody 是 sh 片段，分别在「主清单」和「--deleted」两种调用里执行；
 * 每次被调用往 log 里记一行 list / deleted。root 是一个真实存在、没有 .gitmodules 的空目录。
 */
const installFakeGit = (
  listBody: string | ((dir: string) => string),
  deletedBody = "exit 0",
): { root: string; log: string } => {
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

/** 假 git 的主清单：生成 n 条路径、每条约 `pad + 13` 字节，用 node 脚本一次性吐出（NUL 分隔） */
const genListBody =
  (n: number, pad: number) =>
  (dir: string): string => {
    const gen = path.join(dir, "gen.js");
    fs.writeFileSync(
      gen,
      [
        "const out = [];",
        `for (let i = 0; i < ${n}; i++) out.push("d/" + String(i).padStart(5, "0") + "-" + "x".repeat(${pad}) + ".txt");`,
        'process.stdout.write(out.join("\\0") + "\\0");',
      ].join("\n"),
    );
    return `exec '${process.execPath}' '${gen}'`;
  };

// ---------------------------------------------------------------------- G5 G6 G9 G11 G12：git 这一层

describe("git 调用本身：原始清单 / 子进程环境 / 输出容量", () => {
  it("新仓还没有 .gitignore：未跟踪的 denylist 目录不会被列进主清单（G5）；名字恰好叫 out / build 的未跟踪「文件」不会被误排除（G6）", async () => {
    const root = mkRepo("exclude-fresh-repo");
    put(root, "src/app.ts");
    put(root, "node_modules/pkg/a.js"); // 未跟踪、没有 .gitignore：全靠 --exclude=node_modules/ 剪掉
    put(root, "out/gen.js"); // 同上（out 是 denylist 目录名）
    put(root, "lib/out", "x"); // 文件，不是目录——`--exclude=out/` 带尾斜杠只匹配目录，不碰它；去掉斜杠就会连它一起排掉
    put(root, "build", "x"); // 同上，根下的文件

    const paths = await listGitPaths(root);

    // 这是 listGitPaths 的原始返回（entriesFromPaths 的过滤之前）：G5 没有 --exclude，node_modules/out 目录里的文件就会混进来
    expect(paths).not.toBeNull();
    expect([...(paths ?? [])].sort()).toEqual(["build", "lib/out", "src/app.ts"]);
  });

  it.skipIf(isWindows)(
    "子进程真的看到 GIT_OPTIONAL_LOCKS=0（主清单与 --deleted 两次都是）、也没有凭据提示（G9）",
    async () => {
      const dir = path.join(TMP, `env-git-${++fakeSeq}`);
      const bin = path.join(dir, "bin");
      const root = path.join(dir, "env-root");
      fs.mkdirSync(bin, { recursive: true });
      fs.mkdirSync(root, { recursive: true });
      const log = path.join(dir, "env.log");
      const script = [
        "#!/bin/sh",
        `echo "$* | LOCKS=$GIT_OPTIONAL_LOCKS | PROMPT=$GIT_TERMINAL_PROMPT" >> '${log}'`,
        'case "$*" in',
        "  *--deleted*) exit 0 ;;",
        "  *) printf 'a.ts\\0' ;;",
        "esac",
        "",
      ].join("\n");
      fs.writeFileSync(path.join(bin, "git"), script);
      fs.chmodSync(path.join(bin, "git"), 0o755);
      process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ""}`;

      expect(await listGitPaths(root)).toEqual(["a.ts"]);

      const lines = fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
      expect(lines).toHaveLength(2); // 主清单 1 次 + --deleted 1 次
      expect(lines.filter((l) => l.includes("--deleted"))).toHaveLength(1);
      for (const l of lines) {
        expect(l).toContain("| LOCKS=0 |"); // G9 去掉它：这里是空的
        expect(l).toContain("| PROMPT=0"); // 走的是 gitEnv()，不是裸的 process.env
      }
    },
  );

  it.skipIf(isWindows)(
    "清单大于 1MiB、远小于 64MiB（约 3MB）：照样算成功、一条不少——不是「超容量」（G11、G12）",
    async () => {
      const N = 30_000; // 每条约 103 字节 → 约 3.1MB；Node 默认的 maxBuffer 只有 1MiB
      const fake = installFakeGit(genListBody(N, 90));

      const paths = await listGitPaths(fake.root);

      expect(paths).not.toBeNull(); // maxBuffer 缺失 / 缩到 1MiB 都会溢出 → null
      expect(paths).toHaveLength(N);
      expect(readCalls(fake.log)).toEqual({ list: 1, deleted: 1 });
    },
  );
});

// ---------------------------------------------------------------------- B3 B5：退回遍历

describe("退回目录遍历的两个分支", () => {
  it("git 过滤后一条不剩（仓里只有 node_modules 下的已跟踪文件）：让遍历再确认——遍历能找到被 .git/info/exclude 忽略的文件（B3）", async () => {
    const root = mkRepo("filtered-to-nothing");
    put(root, "node_modules/pkg/index.js", "x");
    git(root, "add", "-f", "node_modules/pkg/index.js"); // 强制跟踪 denylist 目录里的文件
    fs.appendFileSync(path.join(root, ".git", "info", "exclude"), "ignored.txt\n"); // 不建 .gitignore，免得它自己成了一条
    put(root, "ignored.txt", "x");

    // 前提自检：git 的清单非空（只有那个已跟踪文件），被 info/exclude 忽略的 ignored.txt 不在里面——否则这个用例走不到 B3 要测的分支
    expect(await listGitPaths(root)).toEqual(["node_modules/pkg/index.js"]);
    // entriesFromPaths 会按路径段把 node_modules 下的文件滤光 → 0 条 → 退回遍历；遍历不读 ignore 规则，能看到 ignored.txt
    expect(await pathsOf(root)).toEqual(["ignored.txt"]);
  });

  it("根上有 .gitmodules（直接走遍历）：130 个文件一条不少、没有 truncated——退回遍历的上限不是 100（B5）", async () => {
    const root = mkRepo("submodules-big");
    put(root, ".gitmodules", "");
    for (let i = 0; i < 130; i++) put(root, `src/f${String(i).padStart(3, "0")}.ts`);

    const { entries, truncated } = await getRepoFileIndexWithMeta(root);

    expect(truncated).toBe(false);
    expect(entries.filter((e) => !e.isDir)).toHaveLength(131); // 130 个源文件 + .gitmodules
    expect(entries.some((e) => e.path === "src/f129.ts")).toBe(true);
  });
});

// ---------------------------------------------------------------------- C2 C7 C4 C6：缓存

describe("缓存：过期之后会重建；截断提示随缓存走", () => {
  it("TTL 内命中缓存、过了 TTL 就重建（C2 永不过期、C7 建好后不清 in-flight：都会让它一直读到旧索引）", async () => {
    // 只伪造 Date：真 git 的子进程、超时用的是真实定时器，不受影响
    vi.useFakeTimers({ toFake: ["Date"] });
    const T0 = new Date("2026-03-01T00:00:00Z").getTime();
    vi.setSystemTime(T0);
    const root = mkRepo("ttl-repo");
    put(root, "a.txt");

    expect(await pathsOf(root)).toEqual(["a.txt"]); // 建缓存
    put(root, "b.txt");

    vi.setSystemTime(T0 + 59_000); // TTL（60 秒）之内：命中缓存，看不到新文件
    expect(await pathsOf(root)).toEqual(["a.txt"]);

    vi.setSystemTime(T0 + 61_000); // 过了 TTL：重建，新文件出现
    expect(await pathsOf(root)).toEqual(["a.txt", "b.txt"]);
  });

  it.skipIf(isWindows)(
    "截断提示随缓存走：第二次（命中缓存）仍然 truncated=true、条目相同，假 git 只被调用了一次（C4、C6）",
    async () => {
      // 比上限多 100 条的深层文件 + 一个浅层的 src/App.tsx：必然截断
      const body = (dir: string): string => {
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
      const fake = installFakeGit(body);

      const first = await getRepoFileIndexWithMeta(fake.root);
      const second = await getRepoFileIndexWithMeta(fake.root);

      expect(first.truncated).toBe(true);
      expect(first.entries).toHaveLength(REPO_FILES_MAX_ENTRIES);
      // 第二次是缓存命中（不是重建）：git 的主清单只拉起过 1 次；命中时也要把 truncated 带出来
      expect(readCalls(fake.log).list).toBe(1);
      expect(second.truncated).toBe(true); // C4 缓存里存成 false、C6 命中时返回 false，都会在这里红
      expect(second.entries).toEqual(first.entries);
    },
  );
});

// ---------------------------------------------------------------------- S11 S12 S13：遍历的边角

describe("目录遍历（scanRepoRoot）的边角", () => {
  it.skipIf(isWindows || process.getuid?.() === 0)(
    "某个子目录读不了（没权限）：跳过它，排在它后面的兄弟目录照常收（S11）",
    async () => {
      const root = path.join(TMP, "unreadable-sub");
      put(root, "a-locked/hidden.txt");
      put(root, "b-ok/visible.txt"); // 目录项按名字排序，a-locked 先处理、b-ok 后处理
      const locked = path.join(root, "a-locked");
      fs.chmodSync(locked, 0o000);
      try {
        const r = await scanRepoRoot(root);

        // a-locked/ 自己在根层就已经收进去了；进它里面时 readdir 失败 → 跳过，而不是整个中止
        expect(r.entries.map((e) => e.path).sort()).toEqual(["a-locked/", "b-ok/", "b-ok/visible.txt"]);
        expect(r.truncated).toBe(false);
      } finally {
        fs.chmodSync(locked, 0o755); // 还原权限，afterAll 才删得掉
      }
    },
  );

  it(
    "遍历的默认上限是 REPO_FILES_MAX_ENTRIES：2 万多个文件 → 只留上限条、truncated=true（S12）",
    async () => {
      const root = path.join(TMP, "scan-default-cap");
      const dir = path.join(root, "d");
      fs.mkdirSync(dir, { recursive: true });
      for (let i = 0; i < REPO_FILES_MAX_ENTRIES + 50; i++) {
        fs.writeFileSync(path.join(dir, `f${String(i).padStart(5, "0")}.txt`), "");
      }

      const r = await scanRepoRoot(root); // 不传 maxEntries：吃的是默认值

      expect(r.truncated).toBe(true); // 默认上限写成一千万 → 一条不丢、truncated=false
      expect(r.entries).toHaveLength(REPO_FILES_MAX_ENTRIES);
      expect(r.entries[0]).toEqual({ path: "d/", isDir: true }); // 浅层的目录先收
    },
    120_000,
  );

  it.skipIf(isWindows)("FIFO（命名管道）不是普通文件：遍历直接跳过，不收进索引（S13）", async () => {
    const root = path.join(TMP, "scan-fifo");
    put(root, "real.txt");
    execFileSync("mkfifo", [path.join(root, "pipe")]);

    const r = await scanRepoRoot(root);

    expect(r.entries.map((e) => e.path)).toEqual(["real.txt"]);
  });

  it("同一层的条目按名字排序后才收：额度用完时留下的是字母序靠前的，与文件系统吐出的顺序无关（S5）", async () => {
    const root = path.join(TMP, "scan-sorted");
    for (const n of ["e", "b", "f", "a", "d", "c"]) put(root, `${n}.ts`); // 乱序创建
    // 把「文件系统吐出的顺序」固定成倒序（f e d c b a）；被测代码本身是真的，只在 readdir 这个边界上注入
    const realReaddir = fs.promises.readdir.bind(fs.promises) as (
      p: string,
      o: { withFileTypes: true },
    ) => Promise<unknown[]>;
    const spy = vi
      .spyOn(fs.promises, "readdir")
      .mockImplementation((async (p: string, o: { withFileTypes: true }) =>
        [...(await realReaddir(p, o))].reverse()) as never);
    try {
      const r = await scanRepoRoot(root, 3);

      expect(spy).toHaveBeenCalled(); // 注入确实生效了，否则这条用例在空转
      // 去掉 `entries.sort`（S5）→ 按倒序收 → 留下的是 f.ts e.ts d.ts
      expect(r.entries.map((e) => e.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
      expect(r.truncated).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------- RT5：路由的 root 参数

describe("路由 GET /api/repo-files：合法的 root 参数只搜这一个仓（RT5）", () => {
  it("带 root：只返回该仓的候选；不带 root：合并全部仓。多仓时候选都带仓短名前缀", async () => {
    const a = mkRepo("repo-a");
    const b = mkRepo("repo-b");
    put(a, "a-only.ts");
    put(b, "b-only.ts");
    getTaskMeta.mockResolvedValue({ id: "t1", repoPaths: [a, b], readonlyRepoPaths: [], events: [] });

    const search = async (extraQuery: string): Promise<string[]> => {
      const resp = await repoFilesRoute.GET(
        new Request(`http://localhost/api/repo-files?taskId=t1&q=only${extraQuery}`),
      );
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { files: Array<{ path: string }> };
      return body.files.map((f) => f.path).sort();
    };

    // 路由把 root 交给搜索 → 只扫 a；不交（RT5）→ a、b 两个仓都出现在结果里
    expect(await search(`&root=${encodeURIComponent(a)}`)).toEqual(["repo-a/a-only.ts"]);
    expect(await search("")).toEqual(["repo-a/a-only.ts", "repo-b/b-only.ts"]);
  });
});
