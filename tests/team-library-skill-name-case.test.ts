/**
 * 上传查重：仅大小写 / Unicode 规范化写法不同的名字也算同名（R14 S1 · Q13-01）
 *
 * 症状：`checkUploadNameAcrossCategories` 用 `===` 严格比较。Bob 上传 `Foo`、库里有 Alice 的 `foo`（同分类）→ 命中 0 个 → `new`
 * → 跳过 `decideSharedSkillUpdate` 的「仅创建人可覆盖」检查（只有 `overwrite` 才查）→ 落盘时：
 *   · 大小写不敏感的文件系统（macOS APFS 默认 / Windows NTFS）上 `skills/fe/Foo` 与 `skills/fe/foo` 是同一个目录
 *     → 盖掉 Alice 的内容、创建人改成 Bob；
 *   · 大小写敏感的（Linux）上同分类出现 `Foo` 与 `foo` 两个目录 → 之后在 macOS / Windows 上 clone 会 collide。
 * 修法：`skillNameKey`（NFC + 小写）；没有精确同名时再按它找，找到就拒收（同分类也拒）；有精确同名时维持原语义。
 *
 * 上半：纯函数。下半：真走 `uploadSkillsToTeamLibrary`（本地 bare 仓当远端，脚手架见 tests/helpers/team-library-e2e.ts）——
 * 断言的是可观察的结果：远端 HEAD 不动、Alice 的内容与创建人不变、没有 `Foo` 目录；对照组（同批的合法项 / 创建人本人重传）照常放行。
 * 这两个平台上改前都是红的：macOS 上 Alice 的内容被盖掉，Linux 上多出 `Foo` 目录——断言选的是两边都成立的「远端 HEAD 不动」。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  checkUploadNameAcrossCategories,
  skillNameKey,
  syncTeamLibrary,
  uploadSkillsToTeamLibrary,
} from "@/lib/server/team-library";
import { ownerFromGitLabIdentity } from "@/lib/server/team-library-ownership";
import { setupTeamLibraryE2E, TL_E2E_HOST } from "./helpers/team-library-e2e";

const T = 60_000;

describe("skillNameKey：同名键", () => {
  it("大小写折叠", () => {
    expect(skillNameKey("Foo")).toBe("foo");
    expect(skillNameKey("FOO-Bar_1")).toBe("foo-bar_1");
  });

  it("NFC / NFD 写法归一（APFS 对两种写法不敏感），键本身是 NFC", () => {
    const nfc = "caf\u00e9";
    const nfd = "cafe\u0301";
    expect(nfc).not.toBe(nfd);
    expect(skillNameKey(nfd)).toBe(skillNameKey(nfc));
    expect(skillNameKey(nfd)).toBe(nfc);
  });

  it("不同的名字不同键（含中文、只差一个字符）", () => {
    expect(skillNameKey("foo")).not.toBe(skillNameKey("foo2"));
    expect(skillNameKey("改bug")).toBe("改bug");
    expect(skillNameKey("改bug")).not.toBe(skillNameKey("改bu"));
  });

  it("用 toLowerCase、不用 toLocaleLowerCase（结果不能随运行环境的 locale 变）", () => {
    const spy = vi.spyOn(String.prototype, "toLocaleLowerCase");
    try {
      skillNameKey("TITLE");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("checkUploadNameAcrossCategories：仅大小写 / 写法不同（Q13-01）", () => {
  const entries = [
    { category: "fe", name: "foo" },
    { category: "common", name: "Bar" },
    { category: "qa", name: "caf\u00e9" },
  ];

  it("同分类、仅大小写不同 → conflict（改前是 new，会跳过创建人检查）", () => {
    expect(checkUploadNameAcrossCategories("Foo", "fe", entries)).toEqual({
      status: "conflict",
      category: "fe",
      error:
        "库里已有仅大小写 / 写法不同的同名 skill「foo」（分类 前端），请换名或联系对方",
    });
  });

  it("跨分类、仅大小写不同 → 同样 conflict，分类与写法取库里那一条的", () => {
    const r = checkUploadNameAcrossCategories("FOO", "qa", entries);
    expect(r.status).toBe("conflict");
    if (r.status === "conflict") {
      expect(r.category).toBe("fe");
      expect(r.error).toContain("「foo」");
      expect(r.error).toContain("前端");
    }
    const other = checkUploadNameAcrossCategories("bar", "fe", entries);
    expect(other.status).toBe("conflict");
    if (other.status === "conflict") {
      expect(other.category).toBe("common");
      expect(other.error).toContain("「Bar」");
    }
  });

  it("NFD 写法上传、库里是 NFC → conflict；反过来也是", () => {
    const up = checkUploadNameAcrossCategories("cafe\u0301", "qa", entries);
    expect(up.status).toBe("conflict");
    if (up.status === "conflict") {
      expect(up.category).toBe("qa");
      expect(up.error).toContain("caf\u00e9");
    }
    const reverse = checkUploadNameAcrossCategories("caf\u00e9", "qa", [
      { category: "qa", name: "cafe\u0301" },
    ]);
    expect(reverse.status).toBe("conflict");
  });

  it("创建人按库里那一条自己的目录名取（不是按上传名拼）", () => {
    const r = checkUploadNameAcrossCategories("Foo", "fe", entries, {
      "skills/fe/foo": "Alice",
      "skills/fe/Foo": "不该取到这一个",
    });
    expect(r.status).toBe("conflict");
    if (r.status === "conflict") {
      expect(r.author).toBe("Alice");
      expect(r.error).toBe(
        "库里已有仅大小写 / 写法不同的同名 skill「foo」（分类 前端、创建人 Alice），请换名或联系对方",
      );
    }
  });

  it("真正不同的名字不拦（空库、前缀 / 后缀 / 多一个字符）", () => {
    for (const n of ["foo2", "fo", "foo-bar", "xfoo", "Bar2", "cafe"]) {
      expect(checkUploadNameAcrossCategories(n, "fe", entries)).toEqual({
        status: "new",
      });
    }
    expect(checkUploadNameAcrossCategories("Foo", "fe", [])).toEqual({
      status: "new",
    });
  });

  it("精确同名仍走原语义：同分类 overwrite、跨分类 conflict（文案是「同名」、不是「仅大小写」）", () => {
    expect(checkUploadNameAcrossCategories("foo", "fe", entries)).toEqual({
      status: "overwrite",
    });
    const cross = checkUploadNameAcrossCategories("foo", "qa", entries);
    expect(cross.status).toBe("conflict");
    if (cross.status === "conflict") {
      expect(cross.error).toBe(
        "库里已有同名 skill（分类 前端），请换名或联系对方",
      );
    }
  });

  it("精确同名与仅大小写变体并存（Linux 上传留下的历史重名）→ 精确同名优先：创建人仍能重传自己的那一条", () => {
    const dup = [
      { category: "fe", name: "foo" },
      { category: "fe", name: "Foo" },
    ];
    expect(checkUploadNameAcrossCategories("Foo", "fe", dup)).toEqual({
      status: "overwrite",
    });
    expect(checkUploadNameAcrossCategories("foo", "fe", dup)).toEqual({
      status: "overwrite",
    });
  });

  it("有多个变体时同分类的优先（文案更相关）", () => {
    const r = checkUploadNameAcrossCategories("FOO", "qa", [
      { category: "fe", name: "foo" },
      { category: "qa", name: "Foo" },
    ]);
    expect(r.status).toBe("conflict");
    if (r.status === "conflict") {
      expect(r.category).toBe("qa");
      expect(r.error).toContain("「Foo」");
    }
  });

  it("精确同名在别的分类、仅大小写变体在同分类 → 按精确同名报（沿用既有「同名」文案）", () => {
    const r = checkUploadNameAcrossCategories("foo", "qa", [
      { category: "fe", name: "foo" },
      { category: "qa", name: "Foo" },
    ]);
    expect(r.status).toBe("conflict");
    if (r.status === "conflict") {
      expect(r.category).toBe("fe");
      expect(r.error).toBe("库里已有同名 skill（分类 前端），请换名或联系对方");
    }
  });
});

// 端到端两组共用的夹具：库里有 Alice 的 foo。两组各建一份自己的远端（原因见第二组的注释）
const alice = {
  host: TL_E2E_HOST,
  userId: 101,
  username: "alice",
  name: "Alice",
  emails: ["alice@example.com"],
};
const ALICE_MD =
  "---\nname: foo\ndescription: alice's foo\n---\n\n# alice's foo\n";
const md = (name: string, body: string): string =>
  `---\nname: ${name}\ndescription: ${body}\n---\n\n# ${body}\n`;

type E2eEnv = Awaited<ReturnType<typeof setupTeamLibraryE2E>>;

/** 建一份「库里只有 Alice 的 foo」的本地远端；`token` 是当前登录的人 */
const setupAliceFooLibrary = async (token: string): Promise<E2eEnv> => {
  const e = await setupTeamLibraryE2E({
    prefix: "fe-tl-name-case",
    token,
    users: {
      "tok-alice": {
        id: 101,
        username: "alice",
        name: "Alice",
        email: "alice@example.com",
      },
      "tok-bob": {
        id: 202,
        username: "bob",
        name: "Bob",
        email: "bob@example.com",
      },
    },
    seedFiles: {
      "skills/fe/foo/SKILL.md": ALICE_MD,
      "skills/fe/foo/.flowship-owner.json": JSON.stringify(
        ownerFromGitLabIdentity(alice),
      ),
    },
  });
  const synced = await syncTeamLibrary();
  expect(synced.ok).toBe(true);
  return e;
};

describe("端到端：仅大小写不同的名字不能盖掉别人的 skill（本地 bare 当远端）", () => {
  let env: E2eEnv;

  /** 远端 main 上的文件内容（env.git 已 trim 末尾换行） */
  const remoteFile = (rel: string): Promise<string> =>
    env.git(["show", `main:${rel}`], env.bareDir);

  beforeAll(async () => {
    env = await setupAliceFooLibrary("tok-bob");
  }, T);

  afterAll(async () => {
    await env.cleanup();
  });

  it(
    "Bob 传 Foo（同分类，库里是 Alice 的 foo）→ 拒收：远端 HEAD 不动、Alice 的内容与创建人不变、没有 Foo 目录",
    async () => {
      await env.writeAppSkill("Foo", { "SKILL.md": "BOB OVERWRITES ALICE\n" });
      const before = await env.remoteHead();

      const r = await uploadSkillsToTeamLibrary(["Foo"], "fe");

      expect(r.ok).toBe(false);
      expect(r.results).toHaveLength(1);
      expect(r.results[0]?.ok).toBe(false);
      expect(r.results[0]?.error ?? "").toContain("仅大小写");
      expect(r.results[0]?.error ?? "").toContain("「foo」");
      expect(await env.remoteHead()).toBe(before);
      expect(await remoteFile("skills/fe/foo/SKILL.md")).toBe(ALICE_MD.trim());
      expect(
        JSON.parse(await remoteFile("skills/fe/foo/.flowship-owner.json")),
      ).toEqual(ownerFromGitLabIdentity(alice));
      expect(
        (await env.remoteFiles()).some((f) => f.startsWith("skills/fe/Foo/")),
      ).toBe(false);
      // 被拒、什么都没写：本地与远端一致、工作树干净
      expect(await env.localHead()).toBe(before);
      expect(await env.localStatus()).toBe("");
    },
    T,
  );

  it(
    "同批里被拒的只影响自己：Bob 同时传 Foo 与 bobs-new → Foo 被拒、bobs-new 照常上传",
    async () => {
      await env.writeAppSkill("Foo", { "SKILL.md": "BOB OVERWRITES ALICE\n" });
      await env.writeAppSkill("bobs-new", {
        "SKILL.md": md("bobs-new", "bob's new skill"),
      });

      const r = await uploadSkillsToTeamLibrary(["Foo", "bobs-new"], "fe");

      expect(r.ok).toBe(false);
      const byName = Object.fromEntries(r.results.map((x) => [x.name, x]));
      expect(byName["Foo"]?.ok).toBe(false);
      expect(byName["bobs-new"]?.ok).toBe(true);
      const files = await env.remoteFiles();
      expect(files).toContain("skills/fe/bobs-new/SKILL.md");
      expect(files.some((f) => f.startsWith("skills/fe/Foo/"))).toBe(false);
      expect(await remoteFile("skills/fe/foo/SKILL.md")).toBe(ALICE_MD.trim());
    },
    T,
  );
});

// 对照组单独一份远端（Alice 当前登录）。它会把远端的 foo 改成 alice v2；上面一组的用例断言「Alice 的 foo 没被动过、
// 远端里没有 Foo 目录」，两组共用一份远端时，乱序（vitest --sequence.shuffle）下它排在前面就会让那些断言读到改过的内容
// ——原先三个用例共用一个远端、靠书写顺序碰巧都过（随机种子 1002 / 1003 下会红）。
describe("端到端对照：创建人本人重传精确同名 skill 照常覆盖（单独一份远端）", () => {
  let env: E2eEnv;

  const remoteFile = (rel: string): Promise<string> =>
    env.git(["show", `main:${rel}`], env.bareDir);

  beforeAll(async () => {
    env = await setupAliceFooLibrary("tok-alice");
  }, T);

  afterAll(async () => {
    await env.cleanup();
  });

  it(
    "对照：创建人 Alice 本人重传 foo（精确同名）→ 照常覆盖",
    async () => {
      await env.writeAppSkill("foo", {
        "SKILL.md": md("foo", "alice v2"),
      });

      const r = await uploadSkillsToTeamLibrary(["foo"], "fe");

      expect(r.ok).toBe(true);
      expect(await remoteFile("skills/fe/foo/SKILL.md")).toContain("# alice v2");
    },
    T,
  );
});
