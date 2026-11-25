/**
 * release.yml 加固契约（第 7 轮）：
 *  - tag 过滤器只放行严格的 vX.Y.Z（旧 `v*` 会让 `vfoo` / `v1.2.3-rc.1` 也走到签名与转正）；
 *  - guard 前置闸：tag 格式 + 提交必须在 origin/main 的祖先链上，verify 依赖它（不过就不 build、不碰私钥）；
 *  - finalize 挂 `environment: release`（仓库管理员配 Required reviewers 后签名才需要审批）；
 *  - finalize 找不到 draft 时必须 setFailed，不能静默成功。
 *
 * Actions 本身没法在本机跑，这里只能钉文本结构 + 把工作流里的判定表达式拿出来对样本跑一遍。
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 去掉整行注释再拿去匹配：注释里提到的变量名 / 表达式不能让断言通过。否则哪天把某个 secret / 环境变量 / 步骤删了、
 * 只在注释里留一句说明，契约测试照样绿（第二轮评审指出：原来读的是带注释的原文，`toContain(name)` 这类断言形同虚设）。
 * 只处理整行注释（YAML 的 `#`，以及 `run: |` 脚本里整行的 shell 注释）；行尾注释不处理——release.yml 现在没有，
 * 以后加的话别让注释成为某条断言唯一的依据。
 */
const stripYamlComments = (s: string): string =>
  s
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

/** 同理，JS 源码：去掉块注释、整行 `//` 注释和行内 ` // …` 尾注释（`http://` 这类前面不是空白的不动） */
const stripJsComments = (s: string): string =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/(\s)\/\/.*$/gm, "$1");

const yml = stripYamlComments(readFileSync(path.resolve(import.meta.dirname, "../.github/workflows/release.yml"), "utf8"));
const readJs = (rel: string): string => stripJsComments(readFileSync(path.resolve(import.meta.dirname, rel), "utf8"));

/** 取某个顶层 job 的原文（从 `  <name>:` 到下一个两格缩进的 job 名或文件尾，注释行不算分界） */
const jobBlock = (name: string): string => {
  const lines = yml.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  expect(start, `缺少 job ${name}`).toBeGreaterThanOrEqual(0);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
};

describe("release.yml：触发与前置闸", () => {
  it("tag 过滤器是严格的 vX.Y.Z，不再是 `v*`", () => {
    const m = yml.match(/^\s*tags:\s*\[\s*"([^"]+)"\s*\]/m);
    expect(m, "找不到 tags 过滤器").not.toBeNull();
    const pattern = m![1]!;
    expect(pattern).not.toBe("v*");
    // GitHub 过滤器按整串匹配；`[0-9]+` / `.` 在这个子集里语义与正则一致（`.` 在过滤器里是字面量）
    const re = new RegExp(`^${pattern.replace(/\./g, "\\.")}$`);
    for (const ok of ["v1.9.38", "v0.0.1", "v10.20.300"]) expect(re.test(ok), ok).toBe(true);
    for (const bad of ["vfoo", "v1.2.3-rc.1", "v1.2", "v1.2.3.4", "1.2.3", "v1.2.3-", "release-v1.2.3"]) {
      expect(re.test(bad), bad).toBe(false);
    }
  });

  it("guard job：校验 tag 格式 + merge-base --is-ancestor 对 origin/main，且用完整历史（fetch-depth: 0）", () => {
    const guard = jobBlock("guard");
    expect(guard).toMatch(/fetch-depth:\s*0/);
    expect(guard).toMatch(/git merge-base --is-ancestor "\$GITHUB_SHA" refs\/remotes\/origin\/main/);
    expect(guard).toMatch(/\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/);
    // 失败要真的退出非 0（两处 exit 1：格式 / 祖先）
    expect(guard.match(/exit 1/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    // 只读权限：guard 不需要写
    expect(guard).toMatch(/permissions:\s*\n\s*contents:\s*read/);
  });

  it("guard 里的 tag 判定表达式：vX.Y.Z 放行，预发布 / 乱名拒绝", () => {
    const m = yml.match(/=~ (\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$) \]\]/);
    expect(m, "找不到 guard 的 tag 判定正则").not.toBeNull();
    const re = new RegExp(m![1]!);
    expect(re.test("v1.9.38")).toBe(true);
    for (const bad of ["vfoo", "v1.2.3-rc.1", "v1.2", "v1.2.3\nx"]) expect(re.test(bad), bad).toBe(false);
  });

  it("verify（门禁）依赖 guard：guard 不过就不 build、不建 draft、不碰私钥", () => {
    const verify = jobBlock("verify");
    expect(verify).toMatch(/needs:\s*guard\b/);
    // 下游一路 needs 链到 verify：build-release → verify，electron → build-release，finalize → electron
    expect(jobBlock("build-release")).toMatch(/needs:\s*verify\b/);
    expect(jobBlock("electron")).toMatch(/needs:\s*build-release\b/);
    expect(jobBlock("finalize")).toMatch(/needs:\s*electron\b/);
  });
});

describe("release.yml：finalize 签名与转正", () => {
  it("finalize 挂 environment: release（私钥只在这个 job 用；配置审批人后才有人工闸）", () => {
    const fin = jobBlock("finalize");
    expect(fin).toMatch(/^\s{4}environment:\s*release\s*$/m);
    // 私钥只出现在 finalize 里
    expect(yml.match(/UPDATE_MANIFEST_PRIVATE_KEY:\s*\$\{\{/g)?.length).toBe(1);
    expect(fin).toContain("UPDATE_MANIFEST_PRIVATE_KEY");
  });

  it("找不到 draft release 时 setFailed，不再 core.info 后静默 return 成功", () => {
    const fin = jobBlock("finalize");
    const idx = fin.indexOf("if (!draft)");
    expect(idx).toBeGreaterThan(0);
    const body = fin.slice(idx, fin.indexOf("}", idx));
    expect(body).toContain("core.setFailed(");
    expect(body).not.toMatch(/core\.info\(/);
  });
});

/**
 * mac 固定签名身份（electron job）：
 *  - 自签证书的私钥只能在 mac 两个架构的 job 里出现（`release` environment），win 进无 secret 的 `release-win`；
 *  - 缺 secret 就红、不退回 ad-hoc（悄悄发出 ad-hoc 版会让所有用户的系统授权白白再失效一次）；
 *  - workflow 与 scripts/electron-after-pack.mjs 用同一组环境变量名、electron-builder 自己不签名。
 * 真正的签名行为靠 afterPack 里的 codesign + 签后核对指定要求；这里只钉 workflow 的文本结构。
 */
describe("release.yml：mac 固定签名身份（electron job）", () => {
  const afterPack = readJs("../scripts/electron-after-pack.mjs");
  const builderYml = stripYamlComments(readFileSync(path.resolve(import.meta.dirname, "../electron-builder.yml"), "utf8"));

  it("environment 隔离：mac 两个架构进 release（放签名私钥），win 进无 secret 的 release-win", () => {
    const electron = jobBlock("electron");
    expect(electron).toMatch(/^\s{4}environment:\s*\$\{\{\s*matrix\.environment\s*\}\}\s*$/m);
    expect(electron).toMatch(/args: --win\s+sdk_platform: win32-x64\s+environment: release-win\s*\n/);
    expect(electron).toMatch(/args: --mac --arm64\s+sdk_platform: darwin-arm64\s+environment: release\s*\n/);
    expect(electron).toMatch(/args: --mac --x64\s+sdk_platform: darwin-x64\s+environment: release\s*\n/);
  });

  it("签名私钥 secret 只在 mac 的导入步骤里引用（各一次）；缺了就 exit 1、且导入发生在 electron-builder 之前", () => {
    const electron = jobBlock("electron");
    for (const name of ["FLOWSHIP_SIGN_P12_BASE64", "FLOWSHIP_SIGN_P12_PASSWORD"]) {
      expect(yml.match(new RegExp(`secrets\\.${name}`, "g"))?.length, name).toBe(1);
      expect(electron, name).toContain(`secrets.${name}`);
    }
    const start = electron.indexOf("- name: 导入 mac 签名证书");
    const builder = electron.indexOf("- run: npx electron-builder");
    expect(start, "缺少导入证书步骤").toBeGreaterThan(0);
    expect(builder, "缺少 electron-builder 步骤").toBeGreaterThan(start);
    const step = electron.slice(start, builder);
    expect(step).toMatch(/if:\s*runner\.os == 'macOS'/);
    expect(step).toMatch(/\[ -z "\$P12_BASE64" \]/);
    expect(step).toMatch(/exit 1/);
    expect(step).toContain('echo "FLOWSHIP_SIGN_KEYCHAIN=$KC" >> "$GITHUB_ENV"');
  });

  it("electron-builder 步骤：发版要求固定身份；指纹是 40 位小写十六进制（afterPack 按它核对指定要求）", () => {
    const electron = jobBlock("electron");
    expect(electron).toMatch(/FLOWSHIP_REQUIRE_STABLE_SIGN:\s*"1"/);
    expect(electron).toMatch(/CSC_IDENTITY_AUTO_DISCOVERY:\s*"false"/);
    const m = electron.match(/FLOWSHIP_SIGN_IDENTITY:\s*"([^"]+)"/);
    expect(m, "缺 FLOWSHIP_SIGN_IDENTITY").not.toBeNull();
    expect(m![1]).toMatch(/^[0-9a-f]{40}$/);
  });

  it("electron-builder 步骤对 win / mac 一视同仁（没有 if 条件）：发版标记因此也作用在 Windows 打包上——afterPack 靠它让缺 koffi 原生包当场红", () => {
    const electron = jobBlock("electron");
    const start = electron.indexOf("- run: npx electron-builder");
    expect(start, "缺少 electron-builder 步骤").toBeGreaterThan(0);
    const next = electron.indexOf("\n      - ", start + 1); // 下一个步骤
    const step = electron.slice(start, next < 0 ? undefined : next);
    expect(step).not.toMatch(/^\s*if:/m);
    expect(step).toMatch(/FLOWSHIP_REQUIRE_STABLE_SIGN:\s*"1"/);
    expect(electron).toMatch(/args: --win\b/);
    // afterPack 里 koffi 的严格程度只看这个发版标记（不再按平台区分）
    expect(afterPack).toMatch(/strict:\s*process\.env\.FLOWSHIP_REQUIRE_STABLE_SIGN === "1"/);
  });

  it("签名探针与 afterPack 口径一致：都走 scripts/lib/codesign-requirement.mjs（root / leaf 都认），workflow 里不再手写只认 root 的字符串（第三轮评审）", () => {
    const electron = jobBlock("electron");
    const start = electron.indexOf("- name: 导入 mac 签名证书");
    const builder = electron.indexOf("- run: npx electron-builder");
    expect(start, "缺少导入证书步骤").toBeGreaterThan(0);
    const step = electron.slice(start, builder);
    // 不再有手写的「certificate root = H…」判定（它只认 root：add-trusted-cert 失败时探针先红、afterPack 却是放行的）
    expect(step).not.toMatch(/certificate root = H/);
    expect(afterPack).toContain("designatedRequirementNamesCertificate");
    // 把 workflow 里那段 node 判定原样取出来，对样本真跑（证书被信任 → root；没被信任 → leaf；别的证书 / 空输出 → 不过）
    const m = step.match(/node --input-type=module -e '([\s\S]*?)'; then/);
    expect(m, "探针里找不到 node 判定片段").not.toBeNull();
    const code = m![1]!;
    expect(code).toContain("./scripts/lib/codesign-requirement.mjs");
    const FP = "566f6cac5a06f6cca21f6cb23039e370a007137d";
    const OTHER = "0000000000000000000000000000000000000000";
    const run = (stdin: string, fingerprint: string) =>
      spawnSync(process.execPath, ["--input-type=module", "-e", code], {
        cwd: path.resolve(import.meta.dirname, ".."),
        input: stdin,
        env: { ...process.env, FLOWSHIP_SIGN_IDENTITY: fingerprint },
        encoding: "utf8",
      }).status;
    expect(run(`designated => identifier "x" and certificate root = H"${FP}"`, FP)).toBe(0);
    expect(run(`designated => identifier "x" and certificate leaf = H"${FP}"`, FP)).toBe(0);
    expect(run(`designated => identifier "x" and certificate leaf = H"${OTHER}"`, FP)).toBe(1);
    expect(run(`designated => cdhash H"${FP}"`, FP)).toBe(1);
    expect(run("", FP)).toBe(1);
    expect(run(`certificate root = H"${FP}"`, "")).toBe(1); // 没配身份 → 不放行
  });

  it("钥匙串清理步骤无论成败都执行，且只在 mac 上", () => {
    const electron = jobBlock("electron");
    expect(electron).toMatch(/if:\s*always\(\) && runner\.os == 'macOS'/);
    expect(electron).toContain("security delete-keychain");
  });

  it("workflow 与 afterPack 用同一组环境变量名；electron-builder 自己不签名（identity: null）", () => {
    for (const name of ["FLOWSHIP_SIGN_IDENTITY", "FLOWSHIP_SIGN_KEYCHAIN", "FLOWSHIP_REQUIRE_STABLE_SIGN"]) {
      expect(afterPack, name).toContain(`process.env.${name}`);
      expect(yml, name).toContain(name);
    }
    // 没配身份又要求固定身份时必须抛错、不能悄悄退回 ad-hoc
    expect(afterPack).toMatch(/FLOWSHIP_REQUIRE_STABLE_SIGN === "1"/);
    // 自签身份不被 electron-builder 的 find-identity -v 认可，签名只能走 afterPack
    expect(builderYml).toMatch(/^\s+identity:\s*null\s*$/m);
  });
});

describe("注释不算数：契约只认真正生效的配置（第二轮评审）", () => {
  it("stripYamlComments / stripJsComments：注释里的名字去掉，真代码里的保留（含 `http://` 这类不是注释的 //）", () => {
    const y = ["a: 1", "  # secrets.FOO_ONLY_IN_COMMENT", "run: |", "  # echo FOO_SHELL_COMMENT", "  echo real", "b: 2"].join("\n");
    expect(stripYamlComments(y)).toBe(["a: 1", "run: |", "  echo real", "b: 2"].join("\n"));
    const js = [
      "const a = process.env.REAL; // process.env.TRAILING_ONLY",
      "// process.env.LINE_ONLY",
      "/* process.env.BLOCK_ONLY */",
      'const u = "http://x.test/y";',
    ].join("\n");
    const out = stripJsComments(js);
    expect(out).toContain("process.env.REAL");
    expect(out).toContain('"http://x.test/y"');
    for (const gone of ["TRAILING_ONLY", "LINE_ONLY", "BLOCK_ONLY"]) expect(out, gone).not.toContain(gone);
  });

  it("真实文件：release.yml 去注释之后不剩整行注释、仍是完整的工作流；原文确实带注释（否则上一条什么都没证明）", () => {
    const raw = readFileSync(path.resolve(import.meta.dirname, "../.github/workflows/release.yml"), "utf8");
    expect(raw.split("\n").some((l) => /^\s*#/.test(l))).toBe(true);
    expect(yml.split("\n").some((l) => /^\s*#/.test(l))).toBe(false);
    expect(yml).toContain("jobs:");
    expect(jobBlock("finalize")).toMatch(/^\s{4}environment:\s*release\s*$/m);
  });
});
