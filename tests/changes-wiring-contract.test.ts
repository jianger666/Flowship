/**
 * 代码改动面板的接线契约（源码扫描）。
 *
 * 这个环境没有 DOM、点不了界面，面板各处的「连线」——入口挂在哪、切分支后怎么刷新、
 * 引用怎么进输入框、键盘不抢别处的键、只读不写——只能用源码契约钉住：
 * 谁把其中一根线悄悄剪断（重构时误删一行 import / 调用），这里立刻红。
 *
 * 另有两条安全底线放在这里一并守：服务端 git 调用只读、diff 内容永远只当文本渲染（不进 innerHTML）。
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = path.resolve(import.meta.dirname, "..", "src");
const read = (rel: string): string => readFileSync(path.join(srcDir, rel), "utf-8");

/** 去掉块注释与整行 // 注释：注释里点名某个写法不算数（避免「文档里提到 innerHTML」被误判） */
const code = (rel: string): string =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const allFiles = (): string[] =>
  (readdirSync(srcDir, { recursive: true }) as string[]).map((f) => f.replaceAll("\\", "/"));

/**
 * 「不该出现」类断言：失败时只报命中的那一小段，不把整份源码打到终端
 * （expect(src).not.toMatch 失败会打印整个 received，几百行源码淹没真正的原因）
 */
const expectNoMatch = (src: string, re: RegExp, label: string): void => {
  const m = re.exec(src);
  expect(m ? `${label}：命中「${m[0]}」` : null, label).toBeNull();
};

describe("入口：只有两处，各管一种模式", () => {
  it("chat：入口在页面头部右上角（标题栏右侧），不在输入框上方的工具行里；key 带工作目录（换目录重置面板状态）", () => {
    const src = read("components/tasks/chat-view.tsx");
    expect(src).toContain('import { TaskChangesPanel } from "@/components/tasks/task-changes-panel"');
    // 只渲染一次：别处偷偷多挂会出现两个按钮、两套轮询
    expect(src.match(/<TaskChangesPanel\b/g)).toHaveLength(1);
    const panel = src.indexOf("<TaskChangesPanel");
    // 在标题栏里：标题 <h1> 之后、事件流 <EventStream 之前
    expect(src.indexOf("<h1")).toBeGreaterThan(-1);
    expect(panel).toBeGreaterThan(src.indexOf("<h1"));
    expect(panel).toBeLessThan(src.indexOf("<EventStream"));
    // 输入框上方的工具行（composerTop：目录 / 分支 / MCP，都是「发送前要选的上下文」）里不再有它——
    // 用户反馈：混在那一串里找不到
    const topAt = src.indexOf("composerTop={");
    expect(topAt).toBeGreaterThan(-1);
    expect(src.slice(topAt)).not.toContain("<TaskChangesPanel");
    // 工具行本身没被误删：分支切换器仍在
    expect(src.slice(topAt)).toContain('<BranchSwitcher task={task} variant="select" />');
    // key 带工作目录；尺寸 xs = 标题栏一行的高度（sm 会撑高标题栏，入口异步出现时标题栏会跳一下）
    expect(src).toContain(
      '<TaskChangesPanel key={`${task.id}:${task.workCwd ?? ""}`} task={task} size="xs" />',
    );
  });

  it("入口按钮尺寸可选：默认 sm（与 task 头部 chip 行同高），chat 标题栏传 xs；尺寸透传给 Button", () => {
    const src = code("components/tasks/task-changes-panel.tsx");
    expect(src).toContain('size?: "sm" | "xs"');
    expect(src).toContain('size = "sm"');
    expect(src).toMatch(/<Button\s+type="button"\s+variant="outline"\s+size=\{size\}/);
  });

  it("task：入口在页面头部 chip 行，且在 chat 提前 return 之后——chat 页面不会出现两个入口", () => {
    const src = read("app/tasks/[id]/page.tsx");
    expect(src.match(/<TaskChangesPanel/g)).toHaveLength(1);
    expect(src.indexOf("<TaskChangesPanel")).toBeGreaterThan(src.indexOf('if (task.mode === "chat") {'));
    expect(src).toContain("<TaskChangesPanel key={task.id} task={task} />");
  });

  it("全仓只有这两处渲染入口（别处偷偷多挂会出现两个按钮、两套轮询）", () => {
    const hits = allFiles()
      .filter((f) => f.endsWith(".tsx"))
      .filter((f) => /<TaskChangesPanel\b/.test(read(f)))
      .sort();
    expect(hits).toEqual(["app/tasks/[id]/page.tsx", "components/tasks/chat-view.tsx"]);
  });

  it("入口按 chat / task 区别对待：能不能取数、要不要挂、要不要回落，都走 panel-state 里的纯函数", () => {
    const src = read("components/tasks/task-changes-panel.tsx");
    expect(src).toContain("canLoadChanges(task)");
    expect(src).toContain("shouldShowChangesEntry(data.repos, chat)");
    expect(src).toContain("shouldFallBackToBranch(scope, data?.repos ?? null, stale)");
    // 不再有「chat 一律不挂」的旧判断
    expectNoMatch(
      code("components/tasks/task-changes-panel.tsx"),
      /mode\s*[!=]==?\s*"chat"\s*\)\s*return null/,
      "chat 一律不挂的旧判断",
    );
  });

  it("面板关闭就复位范围与手动基线：chip 上的数字永远是「整条分支 + 自动基线」口径", () => {
    const src = code("components/tasks/task-changes-panel.tsx");
    const at = src.indexOf("const handleOpenChange");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("}, []);", at));
    expect(body).toContain("setOpen(next)");
    expect(body).toMatch(/if \(!next\) \{/);
    expect(body).toContain("setScope(DEFAULT_CHANGE_SCOPE)");
    // 只复位范围、漏了手动基线：关面板后 chip 仍是「相对 develop」之类的数字，却被当成整条分支
    expect(body).toContain("setBaseRef(null)");
  });
});

describe("切分支后改动自动跟随", () => {
  it("BranchSwitcher：检出成功后派发刷新信号（在成功路径上、toast 之后，不在失败分支里）", () => {
    const src = read("components/tasks/branch-switcher.tsx");
    const fn = src.indexOf("const handleCheckout = async");
    const toast = src.indexOf("toast.success(`已切到分支", fn);
    const dispatch = src.indexOf("dispatchGitBranchChanged(task.id)", fn);
    const catchAt = src.indexOf("} catch (err) {", fn);
    expect(fn).toBeGreaterThan(-1);
    expect(dispatch).toBeGreaterThan(toast);
    expect(dispatch).toBeLessThan(catchAt);
  });

  it("useTaskChanges：订阅该信号；窗口聚焦 / 标签页重新可见时刷新；只在页面可见时轮询", () => {
    const src = read("hooks/use-task-changes.ts");
    expect(src).toContain("onGitBranchChanged(taskId, kick)");
    expect(src).toContain('window.addEventListener("focus", kick)');
    expect(src).toContain('document.addEventListener("visibilitychange", onVisible)');
    expect(src).toContain('document.visibilityState === "visible"');
    // 卸载时三个监听都要解开
    expect(src).toContain('window.removeEventListener("focus", kick)');
    expect(src).toContain('document.removeEventListener("visibilitychange", onVisible)');
    expect(src).toContain("offBranch()");
  });

  it("useTaskChanges：读取走并发闸门（静默不叠加 / 显式取代 / 换任务中止），请求带 signal；轮询是「读完再排下一次」且间隔自适应", () => {
    const src = code("hooks/use-task-changes.ts");
    expect(src).toContain("createRefreshGate(");
    // 请求真的能被中止：signal 一路传到 fetch
    expect(src).toContain("fetchTaskChanges(taskId, q, signal)");
    expect(src).toContain("gate.request(opts)");
    // 换任务 / 卸载时中止在途读取
    expect(src).toMatch(/\(\) => gate\.abort\(\), \[gate, taskId, enabled\]/);
    // 过期结果不落
    expect(src).toContain("if (!isCurrent()) return;");
    // 轮询：定时链 + 耗时自适应；不能退回固定间隔（请求慢时会叠起来）
    expect(src).toContain("nextPollDelay(base, lastMsRef.current)");
    expectNoMatch(src, /setInterval\(/, "轮询退回了固定间隔");
  });

  it("刷新信号按 taskId 隔离（A 任务切分支不会让 B 任务的面板白刷一次）", () => {
    const src = read("lib/changes/events.ts");
    expect(src).toMatch(/export const dispatchGitBranchChanged/);
    expect(src).toMatch(/export const onGitBranchChanged/);
    expect(src).toMatch(/detail\?\.taskId\s*===\s*taskId|detail\.taskId\s*===\s*taskId/);
  });
});

describe("「引用到对话」：两个输入框各注册、面板侧只认桥", () => {
  it("chat 输入框（EventStream）：只在能放回草稿时注册（chat 且渲染了输入岛）", () => {
    const src = code("components/tasks/event-stream.tsx");
    const at = src.indexOf("registerComposerInsert(task.id");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(Math.max(0, at - 120), at)).toContain("if (!canRestoreDraft) return;");
    expect(src).toContain("appendToDraft(prev, text)");
  });

  it("task 输入条（TaskTalkComposer）：按 taskId 注册，接在草稿后面并聚焦", () => {
    const src = code("components/tasks/task-talk-composer.tsx");
    const at = src.indexOf("registerComposerInsert(task.id");
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, at + 220);
    expect(block).toContain("appendToDraft(cur, text)");
    expect(block).toContain("focusInput()");
  });

  it("diff 视图：引用走桥；有人接 / 没人接都给用户反馈", () => {
    const src = read("components/tasks/changes/diff-viewer.tsx");
    expect(src).toContain("insertIntoComposer(taskId, text)");
    expect(src).toContain('toast.success("已引用到输入框")');
    expect(src).toContain('toast.error("找不到输入框，没法引用")');
  });
});

describe("面板键盘：不抢别处的按键", () => {
  const sheet = read("components/tasks/changes/changes-sheet.tsx");

  it("监听只在面板打开时挂在 window 捕获阶段，卸载 / 关闭时解开", () => {
    expect(sheet).toContain('window.addEventListener("keydown", onKeyDown, true)');
    expect(sheet).toContain('window.removeEventListener("keydown", onKeyDown, true)');
    expect(sheet).toMatch(/useEffect\(\(\) => \{\s*if \(!open\) return;/);
  });

  it("弹层里的按键归弹层；焦点在页面别处（左侧任务页的输入框 / 按钮）不响应；只认面板内与 body", () => {
    expect(sheet).toContain(`closest?.('[data-slot="popover-content"]')`);
    expect(sheet).toContain('closest?.("[data-changes-sheet]")');
    expect(sheet).toMatch(/if \(!inSheet && !onBody\) return;/);
    expect(sheet).toContain('data-changes-sheet=""');
  });

  it("有行选区时 Esc 先取消选区、不关面板", () => {
    expect(sheet).toMatch(
      /e\.key === "Escape"[\s\S]{0,200}hasSelection[\s\S]{0,200}stopPropagation\(\)[\s\S]{0,120}clearSelection\(\)/,
    );
  });

  it("按键判定全部走纯函数 resolveChangesHotkey（输入框打字 / 输入法组字 / 带修饰键都在里面排除）", () => {
    expect(sheet).toContain("resolveChangesHotkey({");
    expect(sheet).toContain("isComposing: e.isComposing");
    expect(sheet).toContain("keyCode: e.keyCode");
    expect(sheet).toContain("repeat: e.repeat");
  });

  it("非模态：Sheet 默认 modal=false 且不渲染遮罩；面板不传 modal 覆盖——左侧任务页仍可点", () => {
    expect(read("components/ui/sheet.tsx")).toMatch(/modal = false,/);
    expectNoMatch(code("components/tasks/changes/changes-sheet.tsx"), /\bmodal\b/, "面板覆盖了 modal");
    expectNoMatch(sheet, /SheetOverlay|SheetBackdrop/, "面板渲染了遮罩");
  });
});

describe("内容变了就不能沿用旧状态", () => {
  it("DiffViewer：展开状态按「内容身份」（含文件级指纹）复位；滚动回顶部仍只看文件 + 范围", () => {
    const src = code("components/tasks/changes/diff-viewer.tsx");
    expect(src).toContain("const contentKey = `${entry.signature}");
    const at = src.indexOf("if (prevContentKey !== contentKey)");
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, at + 260);
    for (const must of ["setExpansion(EMPTY_EXPANSION)", "setPending(null)", "setActiveBlock(null)"]) {
      expect(block, must).toContain(must);
    }
    // 内容刷新（运行中轮询）只复位展开、不能把用户滚回顶部
    expect(src).toMatch(/scrollTo\(\{ top: 0, left: 0 \}\);[\s\S]{0,80}\[fileKey\]/);
  });

  it("单文件 diff 的缓存键 / 已查看签名都含文件级指纹（同一路径、同样的 +1 −1 但内容不同，不会命中旧内容）", () => {
    const entries = code("lib/changes/entries.ts");
    expect(entries).toContain("${f.fingerprint ?? \"\"}");
    // diff 缓存键来自带指纹的 signature
    expect(code("lib/changes/entries.ts")).toContain("signature: fileSignature(repo.repoPath, file)");
    expect(code("components/tasks/changes/diff-viewer.tsx")).toContain("signature: entry.signature");
  });

  it("嵌套 git 仓库：服务端规范成一项带标注的目录；前端不为它发请求、不转圈，列表里标「嵌套仓库」", () => {
    const server = code("lib/server/task-changes.ts");
    expect(server).toContain('p.endsWith("/")');
    expect(server).toContain("nestedRepo: true");

    const viewer = code("components/tasks/changes/diff-viewer.tsx");
    expect(viewer).toContain("active: open && !file.nestedRepo");
    // 说明要渲染在「等 baseSlot」之前：这类条目没有请求，baseSlot 永远是空的，排后面就会一直转圈
    const nestedAt = viewer.indexOf("if (file.nestedRepo) {");
    const loadingAt = viewer.indexOf('if (!baseSlot || baseSlot.status === "loading")');
    expect(nestedAt).toBeGreaterThan(-1);
    expect(loadingAt).toBeGreaterThan(-1);
    expect(nestedAt).toBeLessThan(loadingAt);

    expect(code("components/tasks/changes/file-list.tsx")).toContain("file.nestedRepo");
  });

  it("「无结尾换行」标记的判定只有一份（diff/marker.ts）：model / intraline / diff-syntax 共用，不各写一份", () => {
    const defs = allFiles()
      .filter((f) => /\.tsx?$/.test(f))
      .filter((f) => /\b(?:const|function)\s+isNoNewlineMarker\b/.test(code(f)));
    expect(defs).toEqual(["lib/diff/marker.ts"]);
    for (const f of ["lib/diff/model.ts", "lib/diff/intraline.ts", "lib/diff-syntax.ts"]) {
      expect(code(f), f).toContain('from "@/lib/diff/marker"');
    }
  });

  it("提交选择器：合并提交带「合并」标注（说明它的改动口径）", () => {
    const src = code("components/tasks/changes/scope-toolbar.tsx");
    expect(src).toContain("c.isMerge");
    expect(src).toContain("合并提交");
  });

  it("已查看：按「任务 + 范围 / 手动基线」分命名空间存取；数据还是上个口径时不写标记", () => {
    const src = code("components/tasks/changes/changes-sheet.tsx");
    // 命名空间由范围 + 基线算出，读写都用它——再出现「直接用 taskId 当命名空间」就会重新串口径
    expect(src).toContain("viewedNamespace(taskId, query.scope, query.baseRef)");
    expect(src).toContain("loadViewed(getBrowserStorage(), viewedNs)");
    expect(src).toContain("saveViewed(getBrowserStorage(), viewedNs, next)");
    expectNoMatch(src, /(?:loadViewed|saveViewed)\(getBrowserStorage\(\), taskId/, "已查看不能直接用 taskId 当命名空间");
    // 换范围的那一瞬，清单还是旧口径的：此时标记会把旧签名写进新命名空间
    for (const fn of ["const toggleViewed = () => {", "const markAndNext = () => {"]) {
      const at = src.indexOf(fn);
      expect(at, fn).toBeGreaterThan(-1);
      expect(src.slice(at, at + 160), fn).toContain("stale");
    }
    // 命名空间函数本身：忽略空白不并入（并入的话每切一次开关标记就全丢）
    const store = code("lib/changes/viewed-store.ts");
    const nsAt = store.indexOf("export const viewedNamespace");
    expect(nsAt).toBeGreaterThan(-1);
    expect(store.slice(nsAt, nsAt + 400)).not.toContain("ignoreWs");
  });

  it("小地图的色块按钮不占 Tab 序；手动基线的「自动」说明按 chat / task 分开写（探测链不同）", () => {
    expect(code("components/tasks/changes/diff-minimap.tsx")).toContain("tabIndex={-1}");

    const toolbar = code("components/tasks/changes/scope-toolbar.tsx");
    expect(toolbar).toContain("chat={chat}");
    // chat 才会兜底试 main / master / develop；task 不探测常见分支名
    const ternary = /\{chat\s*\?/.exec(toolbar);
    expect(ternary).not.toBeNull();
    const block = toolbar.slice(ternary?.index ?? 0, (ternary?.index ?? 0) + 400);
    expect(block).toContain("main / master / develop");
    expect(block).toContain("任务里配置的线上分支");
    expect(code("components/tasks/changes/changes-sheet.tsx")).toContain("chat={chat}");
  });
});

describe("只读与安全", () => {
  it("三个接口都只导出 GET（不提供任何写入口）", () => {
    for (const rel of [
      "app/api/tasks/[id]/changes/route.ts",
      "app/api/tasks/[id]/changes/file/route.ts",
      "app/api/tasks/[id]/changes/commits/route.ts",
    ]) {
      const src = code(rel);
      expect(src, rel).toMatch(/export (?:async function|const) GET\b/);
      expectNoMatch(src, /export (?:async function|const) (?:POST|PUT|PATCH|DELETE)\b/, `${rel} 导出了写方法`);
    }
  });

  describe("服务端 git 调用只读", () => {
    const src = code("lib/server/task-changes.ts");
    // 只读白名单：能查、不能改（add / commit / checkout / reset / stash / restore / clean / fetch …都不在里面）
    const READ_ONLY = new Set([
      "rev-parse",
      "merge-base",
      "rev-list",
      "diff",
      "ls-files",
      "log",
      "show",
      "cat-file",
      "for-each-ref",
    ]);

    /** 每个 runGit(...) 调用里数组字面量的第一个非选项字符串 = git 子命令；再加上 diffArgs 的定义 */
    const subcommandsOf = (text: string): string[] => {
      const out: string[] = [];
      for (let i = text.indexOf("runGit("); i !== -1; i = text.indexOf("runGit(", i + 1)) {
        const open = i + "runGit".length;
        let depth = 0;
        let end = open;
        for (; end < text.length; end++) {
          const ch = text[end];
          if (ch === "(") depth++;
          else if (ch === ")" && --depth === 0) break;
        }
        const arr = text.slice(open, end + 1).match(/\[([\s\S]*?)\]/);
        const first = arr?.[1].match(/"([a-z][a-z-]*)"/);
        if (first) out.push(first[1]);
      }
      const def = text.match(/const diffArgs[\s\S]*?\[([\s\S]*?)\];/);
      const diff = def?.[1].match(/"([a-z][a-z-]*)"/);
      if (diff) out.push(diff[1]);
      return out;
    };
    const subcommands = (): string[] => subcommandsOf(src);

    /**
     * 「只允许一种精确用法」的子命令（带不同参数就会变成写操作的那种）：
     * 取出它每次出现时后面跟着的字面量参数，逐次与期望完全相等才算过
     */
    const literalArgsOf = (text: string, sub: string): string[][] =>
      [...text.matchAll(new RegExp(`"${sub}"([\\s\\S]*?)\\]`, "g"))].map((m) =>
        [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]),
      );
    /** 不进通用白名单、由精确形式校验的子命令 */
    const EXACT_ONLY = new Set(["symbolic-ref", "hash-object"]);

    it("扫描器自检：伪造的写命令（单行 / 多行 / 夹在选项后面）都能被抓出来、且不在白名单里", () => {
      const fake = `
        const a = await runGit(dir, ["checkout", "-f", "main"]);
        const b = await runGit(workDir, [
          "--literal-pathspecs",
          "reset",
          "--hard",
        ]);
        const c = await runGit(dir, ["add", "-A"]);
        const d = await runGit(dir, ["hash-object", "-w", "--stdin"]);
        const diffArgs = (flag: string) => [
          "--literal-pathspecs",
          "diff",
          flag,
        ];
      `;
      const subs = subcommandsOf(fake);
      expect(subs).toEqual(["checkout", "reset", "add", "hash-object", "diff"]);
      expect(subs.filter((s) => !READ_ONLY.has(s))).toEqual(["checkout", "reset", "add", "hash-object"]);
      // hash-object 带了 -w（写对象库）：精确形式校验会看见它
      expect(literalArgsOf(fake, "hash-object")).toEqual([["-w", "--stdin"]]);
    });

    it("扫描本身有效（别让白名单检查在正则失灵时空转）", () => {
      const subs = subcommands();
      expect(subs.length).toBeGreaterThanOrEqual(8);
      for (const must of ["rev-parse", "merge-base", "diff", "ls-files"]) expect(subs).toContain(must);
    });

    it("每个 git 子命令都在只读白名单里（symbolic-ref / hash-object 例外，由下面两条精确校验）", () => {
      for (const sub of subcommands()) {
        if (EXACT_ONLY.has(sub)) continue;
        expect(READ_ONLY.has(sub), `git ${sub}`).toBe(true);
      }
    });

    it("symbolic-ref 只有一种用法：--short refs/remotes/origin/HEAD（单个 ref 参数 = 只读；带第二个参数才会改 ref）", () => {
      expect(literalArgsOf(src, "symbolic-ref")).toEqual([["--short", "refs/remotes/origin/HEAD"]]);
    });

    it("hash-object 只有一种用法：--no-filters -- <路径…>（不带 -w = 不写对象库；--no-filters = 不触发 clean 过滤器 / 换行转换）", () => {
      expect(literalArgsOf(src, "hash-object")).toEqual([["--no-filters", "--"]]);
      // 也不从 stdin 读、不指定 --path（那会让 git 按别的路径套过滤器）
      expectNoMatch(src, /"--stdin(?:-paths)?"|"--path"/, "hash-object 的 stdin / --path 用法");
    });

    it("diff / log 的输出格式不受用户全局 git 配置影响：关 textconv / 固定 a/ b/ 前缀 / 关签名校验文字", () => {
      // 清单与单文件 diff 各自一组参数——必须分别钉：全文件 toContain 的话，一处被删另一处还在就会被放过
      const listAt = src.indexOf("const diffArgs = (...flags: string[])");
      expect(listAt).toBeGreaterThan(-1);
      expect(src.slice(listAt, listAt + 500), "清单 diff").toContain('"--no-textconv"');

      // "--no-color" 只出现在单文件 diff 的参数里，当锚点
      const oneAt = src.indexOf('"--no-color"');
      expect(oneAt).toBeGreaterThan(-1);
      const one = src.slice(oneAt, oneAt + 500);
      for (const flag of ['"--no-textconv"', '"--src-prefix=a/"', '"--dst-prefix=b/"']) {
        expect(one, `单文件 diff ${flag}`).toContain(flag);
      }
      expect(src).toContain('"--no-show-signature"');
    });

    it("忽略空白（-w）只加在 numstat 上：清单（name-status）和指纹（raw）一律不带——较新的 git 在 -w 下会把「只改了空白」的文件整行省略", () => {
      // 行为测试（task-changes-scope.integration「忽略空白」）只有在较新的 git（实测 2.54.0）上才会红、2.42.0 抓不到——
      // 所以这里再钉一条源码契约：不管本机装的是哪个 git 版本，回归都拦得住（v1.9.36 首跑 Linux CI 就是栽在这里）
      const defAt = src.indexOf("const diffArgs = (...flags: string[])");
      expect(defAt).toBeGreaterThan(-1);
      const defEnd = src.indexOf("];", defAt);
      expect(defEnd).toBeGreaterThan(defAt);
      expect(src.slice(defAt, defEnd), "diffArgs 的定义里不能带 -w（会让 name-status / raw 也被 -w 过滤）").not.toContain(
        '"-w"',
      );
      // 三个清单调用：name-status 与 raw 原样不带 -w，只有 numstat 条件性地带
      expect(src).toContain('runGit(root, diffArgs("--name-status"))');
      expect(src).toContain('runGit(root, diffArgs("--raw", "--no-abbrev"))');
      expect(src).toContain('runGit(root, diffArgs("--numstat", ...(opts.ignoreWs ? ["-w"] : [])))');
      // 单文件 diff 取 patch 仍然带 -w（要把空白差异从 patch 里去掉）
      expect(src).toMatch(/\.\.\.\(opts\.ignoreWs \? \["-w"\] : \[\]\),\s*\.\.\.sc\.value\.revs/);
    });

    it("git 一律在仓库根里跑（不用工作目录本身）：清单 / 单文件 diff / 提交列表都先取 root", () => {
      expect(src).toContain('"--show-toplevel"');
      // 取不到仓库根 = 不是 git 仓库，三处各自走自己的「不可用」分支
      expect(src.match(/await resolveRepoRoot\(workDir\)/g)?.length ?? 0).toBe(3);
      // 不再有对工作目录直接跑 git 的调用
      expectNoMatch(src, /runGit\(workDir\b/, "runGit 仍然直接用工作目录当 cwd");
    });

    it("不写文件：没有 --output / --ext-diff（外部 diff 程序）；diff 一律显式关掉外部 diff 程序", () => {
      expectNoMatch(src, /"--output/, "git --output 会写文件");
      expectNoMatch(src, /"--ext-diff"/, "启用外部 diff 程序");
      expect(src).toContain('"--no-ext-diff"');
    });

    it("runGit 走 execFile（不经 shell）、固定 GIT_OPTIONAL_LOCKS=0（不与 agent 抢 index.lock）", () => {
      expect(src).toContain('import { execFile } from "node:child_process"');
      expect(src).toContain('GIT_OPTIONAL_LOCKS: "0"');
      // 单独调用的 exec / spawn（前面不是「.」：正则对象的 .exec 不算）
      expectNoMatch(src, /(?<![.\w])(?:exec|execSync|spawn|spawnSync)\(/, "child_process 的 shell 型调用");
      expectNoMatch(src, /shell:\s*true/, "shell: true");
    });

    it("补算哈希走成本控制：先查缓存、再按预算选要哈希的、读完写缓存（轮询是 4 秒一次，不能每次读几个 GB）", () => {
      expect(src).toContain("workingHashCache.get(key)");
      expect(src).toContain("planHashing(pending, limits)");
      expect(src).toContain("workingHashCache.set(p.key, oid, p.mtimeMs, p.ctimeMs)");
      // 按清单顺序排好再裁剪：并发 lstat 的完成顺序不定，不排的话每次哈希的是不同的一批
      expect(src).toContain("pending.sort(");
      // 缓存 / 预算的纯逻辑在独立模块里（有单测）、本文件不自己再造一份
      expect(src).toContain('from "./working-file-hash"');
    });

    it("未跟踪文件的读盘同样有预算 + 缓存，并与已跟踪文件的哈希共用一份总预算", () => {
      // 批量函数：先查（独立的）摘要缓存、再按预算选要读的、读完写缓存；按清单顺序排好再裁剪。
      // 只在批量函数体里找（已跟踪那条路径里也有 pending.sort / planHashing，不能拿它们凑数）
      const batchAt = src.indexOf("export const statUntrackedBatch");
      expect(batchAt).toBeGreaterThan(-1);
      const batch = src.slice(batchAt, src.indexOf("const absoluteIn", batchAt));
      for (const must of [
        "cache.get(key)",
        "planHashing(pending, {",
        "maxTotalBytes: budgetBytes",
        "pending.sort(",
        "cache.set(p.key, encodeUntrackedSummary(summary), p.mtimeMs, p.ctimeMs)",
        "opts.cache ?? untrackedSummaryCache",
      ]) {
        expect(batch, must).toContain(must);
      }

      // 共用总预算：已跟踪的先用、剩下的才给未跟踪
      expect(src).toContain("const trackedHashedBytes = rawRun.ok");
      expect(src).toContain("budgetBytes: Math.max(0, MAX_HASH_TOTAL_BYTES - trackedHashedBytes)");
      expect(src).toContain("return { fingerprints: out, hashedBytes }");
      expect(src).toContain("return hashedBytes;");
      // 嵌套仓库项不读盘、也不占「最多处理多少个」的额度
      expect(src).toContain("untracked.filter((p) => !p.endsWith(\"/\"))");
      // 旧的「逐个无预算地读」已经不在了
      expectNoMatch(src, /statUntrackedFile/, "旧的单文件无预算读盘");
    });

    it("未跟踪摘要缓存与已跟踪哈希缓存是两个独立实例（值的格式不同，共用键空间会互相误读）", () => {
      const hash = code("lib/server/working-file-hash.ts");
      expect(hash).toMatch(/export const workingHashCache = createHashCache\(/);
      expect(hash).toMatch(/export const untrackedSummaryCache = createHashCache\(/);
      // 已跟踪那条路径只用 workingHashCache、未跟踪那条只用 untrackedSummaryCache
      const fingerprintAt = src.indexOf("const fingerprintWorkingFiles");
      const batchAt = src.indexOf("export const statUntrackedBatch");
      expect(fingerprintAt).toBeGreaterThan(-1);
      expect(batchAt).toBeGreaterThan(-1);
      const tracked = src.slice(fingerprintAt, src.indexOf("const attachFingerprints"));
      const untracked = src.slice(batchAt, src.indexOf("const absoluteIn"));
      expect(tracked).not.toContain("untrackedSummaryCache");
      expect(untracked).not.toContain("workingHashCache");
    });

    it("路径永远在 -- 之后，并开 --literal-pathspecs（文件名当字面量，不被解释成 pathspec 魔法）", () => {
      expect(src.match(/"--literal-pathspecs"/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
      expect(src.match(/^\s*"--",$/gm)?.length ?? 0).toBeGreaterThanOrEqual(2);
    });
  });

  it("diff / 文件名 / 提交信息永远只当文本渲染：面板组件里没有 innerHTML 类写法", () => {
    const files = [
      ...allFiles().filter((f) => f.startsWith("components/tasks/changes/") && f.endsWith(".tsx")),
      "components/tasks/task-changes-panel.tsx",
    ];
    expect(files.length).toBeGreaterThanOrEqual(8);
    for (const rel of files) {
      expectNoMatch(
        code(rel),
        /dangerouslySetInnerHTML|\.innerHTML|\.outerHTML|insertAdjacentHTML/,
        `${rel} 用了 innerHTML 类写法`,
      );
    }
  });
});
