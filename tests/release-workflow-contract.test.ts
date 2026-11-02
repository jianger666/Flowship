/**
 * release.yml 加固契约（第 7 轮）：
 *  - tag 过滤器只放行严格的 vX.Y.Z（旧 `v*` 会让 `vfoo` / `v1.2.3-rc.1` 也走到签名与转正）；
 *  - guard 前置闸：tag 格式 + 提交必须在 origin/main 的祖先链上，verify 依赖它（不过就不 build、不碰私钥）；
 *  - finalize 挂 `environment: release`（仓库管理员配 Required reviewers 后签名才需要审批）；
 *  - finalize 找不到 draft 时必须 setFailed，不能静默成功。
 *
 * Actions 本身没法在本机跑，这里只能钉文本结构 + 把工作流里的判定表达式拿出来对样本跑一遍。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const yml = readFileSync(path.resolve(import.meta.dirname, "../.github/workflows/release.yml"), "utf8");

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
