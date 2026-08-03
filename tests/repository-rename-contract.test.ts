import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const read = (relativePath: string): string =>
  readFileSync(path.join(root, relativePath), "utf8");

describe("GitHub 仓库改名后的更新链契约", () => {
  const main = read("electron-app/main.js");
  const builder = read("electron-builder.yml");
  const readme = read("README.md");

  it("新版本的检查、下载、发布与文档全部指向 Flowship", () => {
    expect(main).toContain("github.com/jianger666/Flowship/releases/latest");
    expect(main).toContain(
      "github.com/jianger666/Flowship/releases/download/v${version}/update-manifest.json",
    );
    expect(main).toContain(
      "github.com/jianger666/Flowship/releases/download/v${version}/${assetName}",
    );
    expect(builder).toContain("repo: Flowship");
    expect(readme).toContain("github.com/jianger666/Flowship/releases/latest");
    expect(`${main}\n${builder}\n${readme}`).not.toContain(
      "github.com/jianger666/fe-ai-flow",
    );
  });

  it("改名保护仍跟随重定向，稳定安装标识保持旧值", () => {
    expect(main).toContain('redirect: "follow"');
    expect(builder).toContain("appId: com.jianger.fe-ai-flow");
    expect(builder).toContain(
      'artifactName: "fe-ai-flow-${version}-${os}-${arch}.${ext}"',
    );
    expect(main).toContain('IS_TEST ? "fe-ai-flow-test" : "fe-ai-flow"');
  });
});
