/**
 * 设置页「保存 / 校验 / 数据安全」源码契约（S13 系列）
 *
 * 这些都是 React 组件里的接线（没有 DOM 测试环境），用源码断言钉住关键写法，
 * 防止以后回退。行为本身的纯函数另有 branch-template / int-field / stable-row-keys 等测试。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const read = (rel: string): string =>
  readFileSync(join(process.cwd(), rel), "utf8");

/**
 * 用 TypeScript AST 枚举源码里所有「从数组移除元素」的写法：
 * - `.filter(cb)`：cb 带比较（`!==` / `!=`，如 `(_, j) => j !== i`）或接收 ≥2 个参数（用了下标）
 *   （`filter(Boolean)` / `filter(s => s.host.trim())` 这类纯过滤不算）；
 * - `.splice(` / `.pop(` / `.shift(`。
 * 每处标注是否位于 `removeRow(...)` 的参数里（= 经确认包装）。
 */
interface RemovalSite {
  /** 便于断言 / 报错的标签：最近的对象属性名（如 servers），否则取被移除数组的源码文本 */
  label: string;
  guarded: boolean;
  line: number;
}

const GUARD_FN = "removeRow";

const isFunctionLike = (n: ts.Node): n is ts.ArrowFunction | ts.FunctionExpression =>
  ts.isArrowFunction(n) || ts.isFunctionExpression(n);

const containsInequality = (n: ts.Node): boolean => {
  let found = false;
  const visit = (x: ts.Node) => {
    if (found) return;
    if (
      ts.isBinaryExpression(x) &&
      (x.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        x.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(x, visit);
  };
  visit(n);
  return found;
};

const findRemovalSites = (text: string): RemovalSite[] => {
  const sf = ts.createSourceFile("x.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const sites: RemovalSite[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      let isRemoval = false;
      if (method === "splice" || method === "pop" || method === "shift") {
        isRemoval = true;
      } else if (method === "filter") {
        const cb = node.arguments[0];
        isRemoval =
          !!cb && isFunctionLike(cb) && (cb.parameters.length >= 2 || containsInequality(cb.body));
      }
      if (isRemoval) {
        let label = node.expression.expression.getText(sf);
        let guarded = false;
        let child: ts.Node = node;
        let labelled = false;
        for (let p: ts.Node | undefined = node.parent; p; child = p, p = p.parent) {
          if (!labelled && ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) {
            label = p.name.text;
            labelled = true;
          }
          if (
            ts.isCallExpression(p) &&
            ts.isIdentifier(p.expression) &&
            p.expression.text === GUARD_FN &&
            child !== p.expression
          ) {
            guarded = true;
          }
        }
        sites.push({
          label,
          guarded,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
};

describe("S13-01 仓库分支模板：所有落盘走统一闸门", () => {
  const src = read("src/components/settings/repo-card.tsx");
  it("除 commitRepos 内部外、不再直接调 onCommit(", () => {
    const calls = src.match(/\bonCommit\(/g) ?? [];
    // 只剩 commitRepos 里那一处
    expect(calls).toHaveLength(1);
    expect(src).toContain("guardRepoBranchTemplates(");
  });
});

describe("S13-02 公司环境：服务器缺项不再阻断落盘", () => {
  const src = read("src/components/settings/company-env-card.tsx");
  it("persist 不再因 findCompanyEnvServerIssue 拒绝落盘 / 弹 toast", () => {
    const persist = src.slice(
      src.indexOf("const persist ="),
      src.indexOf("const commit = "),
    );
    expect(persist).not.toContain("findCompanyEnvServerIssue");
    expect(persist).not.toContain("toast.");
    expect(persist).not.toContain("Promise.resolve(false)");
  });
  it("缺项改为服务器卡行内提示", () => {
    expect(src).toContain("findCompanyEnvServerRowIssue(s)");
  });
});

describe("S13-14 / S13-10 公司环境：删除与导入导出确认", () => {
  const src = read("src/components/settings/company-env-card.tsx");
  it("AST 枚举：每处「从数组移除元素」都在 removeRow(...) 回调内（新增小节漏接确认会红）", () => {
    const sites = findRemovalSites(src);
    // 已知 10 处：servers / pg / redis / xxljob / nacos / elk / sls / httpApis / custom + 字符串列表
    expect(sites.map((s) => s.label).sort()).toEqual(
      [
        "custom",
        "elk",
        "httpApis",
        "lines",
        "nacos",
        "pg",
        "redis",
        "servers",
        "sls",
        "xxljob",
      ].sort(),
    );
    const naked = sites.filter((s) => !s.guarded).map((s) => `${s.label}@L${s.line}`);
    expect(naked).toEqual([]);
  });
  it("检测器自检：裸删 / splice 会被标为未确认，包在 removeRow 里则放行", () => {
    const bad = findRemovalSites(`
      const a = () => commit({ ...v, servers: servers.filter((_, j) => j !== i) });
      const b = () => { rows.splice(i, 1); };
      const c = () => items.filter((x) => x.id !== id);
    `);
    expect(bad.map((s) => s.guarded)).toEqual([false, false, false]);
    const ok = findRemovalSites(`
      const a = () => void removeRow("x", n, row, () => commit({ servers: servers.filter((_, j) => j !== i) }));
      const summary = rows.filter((s) => s.host.trim()).length + lines.filter(Boolean).length;
    `);
    expect(ok.map((s) => s.guarded)).toEqual([true]);
  });
  it("removeRow 来自 useRemoveRow：非空白行 confirm(destructive) 后才 apply", () => {
    const sf = ts.createSourceFile("x.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    // 组件里 `const removeRow = useRemoveRow()`（两处：主组件 + StringListEditor）
    const bindings: string[] = [];
    let hook: ts.VariableDeclaration | undefined;
    const visit = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
        if (
          n.name.text === GUARD_FN &&
          n.initializer &&
          ts.isCallExpression(n.initializer) &&
          n.initializer.expression.getText(sf) === "useRemoveRow"
        ) {
          bindings.push(n.name.text);
        }
        if (n.name.text === "useRemoveRow") hook = n;
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(bindings).toHaveLength(2);
    expect(hook).toBeTruthy();
    // 钩子体：isBlankCompanyEnvRow（company-env.ts 导出、与服务端收缩判定共用的空白行判定）判空
    // + await confirm({... destructive: true}) + 取消即 return + 最后 apply()
    const calls: string[] = [];
    let destructive = false;
    let awaitedConfirm = false;
    const scan = (n: ts.Node) => {
      if (ts.isCallExpression(n)) calls.push(n.expression.getText(sf));
      if (ts.isAwaitExpression(n) && ts.isCallExpression(n.expression) && n.expression.expression.getText(sf) === "confirm") {
        awaitedConfirm = true;
      }
      if (
        ts.isPropertyAssignment(n) &&
        n.name.getText(sf) === "destructive" &&
        n.initializer.kind === ts.SyntaxKind.TrueKeyword
      ) {
        destructive = true;
      }
      ts.forEachChild(n, scan);
    };
    scan(hook!);
    expect(calls).toContain("isBlankCompanyEnvRow");
    expect(calls).toContain("apply");
    expect(awaitedConfirm).toBe(true);
    expect(destructive).toBe(true);
    // confirm 必须在 apply 之前（取消 return 掉）
    const body = hook!.getText(sf);
    expect(body.indexOf("await confirm(")).toBeLessThan(body.lastIndexOf("apply()"));
    expect(body).toMatch(/if \(!ok\) return;/);
  });
  it("导入前确认覆盖（已有配置时）、导出前提示明文密码", () => {
    expect(src).toContain("覆盖当前环境配置");
    expect(src).toContain("isCompanyEnvConfigured(value)");
    expect(src).toContain("导出包含明文密码");
    expect(src).not.toMatch(/window\.(confirm|alert|prompt)/);
  });
});

describe("S13-16 端口 / DB 输入：编辑中允许为空、失焦才回填", () => {
  const src = read("src/components/settings/company-env-card.tsx");
  it("不再 onChange 里 `Number(...) || 默认值`", () => {
    expect(src).not.toMatch(/Number\(e\.target\.value\)\s*\|\|/);
    expect(src).not.toContain('type="number"');
  });
  it("端口 / DB 走 IntInput（带 1–65535 范围）", () => {
    expect((src.match(/<IntInput/g) ?? []).length).toBe(4);
    expect(src).toContain("min={PORT_MIN}");
    expect(src).toContain("max={PORT_MAX}");
  });
});

describe("S13-17 密码框：稳定 key + aria-label", () => {
  const src = read("src/components/settings/company-env-card.tsx");
  it("含密码小节的实例卡不再用下标当 key", () => {
    for (const k of ["serverKeys", "pgKeys", "redisKeys", "xxlKeys", "nacosKeys", "elkKeys", "slsKeys"]) {
      expect(src).toContain(`key={${k}[i]}`);
    }
  });
  it("PasswordInput 眼睛按钮有 aria-label", () => {
    const pw = read("src/components/ui/password-input.tsx");
    expect(pw).toContain("aria-label=");
  });
});

describe("S13-18 Git Bash 开关：关闭始终可用", () => {
  it("disabled 只在「当前关 + 没探测到」时成立", () => {
    const src = read("src/components/settings/preference-card.tsx");
    expect(src).toContain("disabled={!agentShellGitBash && !gitBashPath}");
    expect(src).not.toContain("disabled={!gitBashPath}");
  });
});

describe("S13-09 MCP 高级 JSON：不再每次击键落盘", () => {
  const src = read("src/components/settings/mcp-card.tsx");
  it("CodeEditor.onChange 只改草稿；落盘只在点保存的 handleSave 里", () => {
    const bulk = src.slice(
      src.indexOf("const BulkJsonEditor"),
      src.indexOf("// ----------------- 新增 / 编辑单个 server"),
    );
    expect(bulk).toContain("onChange={setDraft}");
    // onCommit 只在 handleSave 里调用一次
    expect((bulk.match(/onCommit\(servers\)/g) ?? []).length).toBe(1);
    expect(bulk).toContain("parseBulkMcpJson(draft)");
  });
});

describe("S13-08 / S13-12 skills & rules：失败不当成空、开关回滚", () => {
  const rules = read("src/components/settings/rules-card.tsx");
  const skills = read("src/components/settings/skills-card.tsx");
  it("rules 刷新检查 res.ok、失败不再 setRules([])", () => {
    const refresh = rules.slice(
      rules.indexOf("const refresh = useCallback"),
      rules.indexOf("useEffect(() => {"),
    );
    expect(refresh).toContain("!res.ok");
    expect(refresh).not.toContain("setRules([])");
  });
  it("rules 开关保存失败回滚 UI", () => {
    const toggle = rules.slice(
      rules.indexOf("const handleToggle"),
      rules.indexOf("// 一句话添加"),
    );
    expect(toggle).toContain("enabled: !enabled");
  });
  it("skills 刷新 / 导入 / 保存检查 res.ok 并有 catch，刷新失败不再 setSkills([])", () => {
    const refresh = skills.slice(
      skills.indexOf("const refresh = useCallback"),
      skills.indexOf("useEffect(() => {"),
    );
    expect(refresh).toContain("!skillsRes.ok");
    expect(refresh).not.toContain("setSkills([])");
    const imp = skills.slice(
      skills.indexOf("const handleImport"),
      skills.indexOf("const runSync"),
    );
    expect(imp).toContain("} catch (err)");
    expect(skills).toContain("保存失败：");
  });
});

describe("S13-07 删 skill：先删 skill、成功后再摘 action", () => {
  it("DELETE /api/skills 发生在 deleteCustomActionReq 之前", () => {
    const skills = read("src/components/settings/skills-card.tsx");
    const handleDelete = skills.slice(
      skills.indexOf("const handleDelete = async"),
      skills.indexOf("/** 可管理源开关"),
    );
    const iSkill = handleDelete.indexOf("/api/skills?");
    const iAction = handleDelete.indexOf("await deleteCustomActionReq(");
    expect(iSkill).toBeGreaterThan(-1);
    expect(iAction).toBeGreaterThan(iSkill);
    // skill 删除失败分支在摘 action 之前就 return
    const failBranch = handleDelete.slice(iSkill, iAction);
    expect(failBranch).toContain("return;");
  });
});

describe("S13-15 API Key：清空即清信息块、不重复 PUT、缓存不含 key 片段", () => {
  it("失焦值没变不重复落盘 / 拉取", () => {
    const page = read("src/app/settings/page.tsx");
    expect(page).toContain("value === getSettings().apiKey");
  });
  it("清空 key 时清掉账号信息", () => {
    const page = read("src/app/settings/page.tsx");
    expect(page).toContain('fetchInfo("", options)');
  });
  it("两处 localStorage 缓存都不再写 slice(0,4) / slice(-4)", () => {
    for (const f of ["src/hooks/use-api-key-info.ts", "src/hooks/use-models.ts"]) {
      const src = read(f);
      expect(src).not.toMatch(/slice\(0,\s*4\)/);
      expect(src).not.toMatch(/slice\(-4\)/);
    }
  });
});

// ⚠ 本块三条都是**源码形态契约（grep），不是行为证明**。「备份不会被带出 / 列出」的行为证明在
// settings-backup-exclusion.test.ts（真实 exportDiagnostics / 真实存储页 route，同族文件含 .bak.shrink）。
// 保留这三条只是因为「新增一个读 / 枚举备份的入口」没有可以便宜地跑出来的行为反例；
// 它们能挡的只有「照抄 helper」「诊断 / 存储页改成枚举数据目录」这类字面改动，改了写法就失效、也不新增同类断言。
describe("F6-02 config.json.bak 含明文密钥：不外泄", () => {
  it("备份路径 helper（settingsBackupPath / settingsShrinkBackupPath）只在 settings-fs.ts 里出现（字面检查：没有别处抄一份同名 helper）", () => {
    // ⚠ 第八轮订正：这条**不**证明「别处没有读它」——event-secret-redact.ts 读 `.bak` / `.bak.shrink` 做脱敏、
    // pi-coding-tools.ts 对它们做词法拦截 + statSync，用的都是各自拼的路径字符串、不叫这两个 helper 名，所以不在这里的检查范围。
    // 这两个 helper 都是 settings-fs 里未导出的 const：别的文件 import 不到，所以这里能抓到的只有「抄一份同名 helper」。
    // 行为层面的「不会被带出 / 列出」见 settings-backup-exclusion.test.ts
    for (const helper of ["settingsBackupPath", "settingsShrinkBackupPath"]) {
      const hits: string[] = [];
      const walk = (dir: string): void => {
        for (const ent of readdirSync(join(process.cwd(), dir), { withFileTypes: true })) {
          const rel = `${dir}/${ent.name}`;
          if (ent.isDirectory()) walk(rel);
          else if (/\.(ts|tsx)$/.test(ent.name) && read(rel).includes(helper)) {
            hits.push(rel);
          }
        }
      };
      walk("src");
      expect(hits, helper).toEqual(["src/lib/server/settings-fs.ts"]);
    }
  });

  it("诊断导出只读固定的 config.json、不枚举数据目录（.bak 不会被带进诊断包）", () => {
    const diag = read("src/lib/server/diagnostics.ts");
    expect(diag).toContain('path.join(dataRoot(), "config.json")');
    expect(diag).not.toMatch(/readdir/);
  });

  it("存储页只枚举 tasks/ 下的目录（DATA_DIR = dataRoot()/tasks）", () => {
    const storage = read("src/app/api/system/storage/route.ts");
    expect(storage).toContain("fs.readdir(DATA_DIR, { withFileTypes: true })");
    expect(read("src/lib/server/task-fs-core.ts")).toContain(
      'export const DATA_DIR = path.join(dataRoot(), "tasks")',
    );
  });
});

describe("S13-03 保存失败自动重试 + 真退出不被 beforeunload 拦", () => {
  it("use-settings 失败时登记重试、新保存作废旧重试、卸载补跑", () => {
    const src = read("src/hooks/use-settings.ts");
    // 「失败登记重试 / 新保存作废旧重试」收口在 saveWithRetry，它们的行为（含世代判断、4xx 不重试）由 save-retry.test.ts
    // 用假定时器真实验证，不在这里再 grep saveWithRetry 的内部写法。
    // use-settings 是 React hook、没有 DOM 环境没法渲染——这两条只是它的源码形态契约（必须经 saveWithRetry 落盘、卸载补跑），
    // 不是行为证明
    expect(src).toContain("saveWithRetry(");
    expect(src).toContain("retrierRef.current?.flush()");
  });
  it("Electron 主进程：quitting 时 will-prevent-unload 放行", () => {
    const main = read("electron-app/main.js");
    expect(main).toMatch(
      /webContents\.on\("will-prevent-unload",\s*\(event\)\s*=>\s*\{\s*if \(quitting\) event\.preventDefault\(\);/,
    );
  });
});
