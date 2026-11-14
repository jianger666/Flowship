/**
 * 编辑已发送的用户消息：图片可以在编辑框里看到 / 删除 / 新增（原来只有文字框，发送时偷偷带上原图）。
 *
 * 三层：
 *  1. 纯逻辑：快照 id / clearUserEditImages / userEditViewKeys / buildResendPayload 的 images 覆盖；
 *  2. 真渲染 EventRow 的编辑态（服务端渲染首帧）：编辑框按「附件快照 + 用户全删了标记」画缩略图 / 载入中 / 按钮可用性
 *     （含快照被全局 LRU 真实挤掉的回归，评审 R18-03）；
 *     行被虚拟列表卸载再挂回来 = 同样的首帧，所以这里同时钉住「滚走再回来图还在」；
 *  3. 源码接线契约：发送带的是编辑框里最终这组图、取消 / 成功要清、失败要把图放回输入框。
 *
 * 做不到的（node 环境没有 DOM）：真点击 / 真粘贴——由 scripts 之外的人工在 App 里确认。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildResendPayload,
  loadUserReplyImages,
} from "@/components/tasks/event-stream/resend-payload";
import { EventRow } from "@/components/tasks/event-stream/rows";
import { ImagePreviewProvider } from "@/components/ui/image-preview";
import { DialogProvider } from "@/hooks/use-dialog";
import { rowViewStateStore } from "@/lib/event-row-view-state";
import { ROW_VIEW_FIELD, userEditViewKeys } from "@/lib/row-view-keys";
import type { ImagePayload } from "@/lib/task-store";
import type { Task, TaskEvent } from "@/lib/types";
import {
  clearUserEditImages,
  shouldLoadOriginalImages,
  USER_EDIT_IMAGES_CLEARED,
  userEditImagesSnapshotId,
} from "@/lib/user-edit-images";
import {
  clearAttachmentSnapshot,
  loadAttachmentSnapshot,
  saveAttachmentSnapshot,
} from "@/lib/view-memory";

const read = (rel: string) =>
  fs.readFile(path.join(process.cwd(), rel), "utf-8");

const TASK_ID = "t1";
const task = {
  id: TASK_ID,
  title: "x",
  mode: "chat",
  actions: [],
  events: [],
  repoPaths: [],
} as unknown as Task;

const imgMeta = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    absPath: `/data/tasks/${TASK_ID}/uploads/img${i}.png`,
    relPath: `uploads/img${i}.png`,
    mimeType: "image/png",
    bytes: 3,
    filename: `img${i}.png`,
  }));

const userEv = (id: string, imageCount: number, text = "看下这个"): TaskEvent =>
  ({
    id,
    ts: 1,
    kind: "user_reply",
    text,
    ...(imageCount > 0 ? { meta: { images: imgMeta(imageCount) } } : {}),
  }) as unknown as TaskEvent;

const snapImg = (id: string, data: string) => ({
  id,
  data,
  mimeType: "image/png",
  filename: `${id}.png`,
});

/**
 * 把某条消息置为「正在编辑」（等价于点了编辑按钮后行视图状态里的样子）。
 * userCleared = true：用户已经亲手把编辑框里的图全删了（标记在）。
 */
const startEditing = (ev: TaskEvent, draft: string, userCleared: boolean) => {
  const k = userEditViewKeys(TASK_ID, ev.id);
  rowViewStateStore.set(k.editing, true);
  rowViewStateStore.set(k.draft, draft);
  if (userCleared) rowViewStateStore.set(k.imagesCleared, USER_EDIT_IMAGES_CLEARED);
};

const setSnapshot = (ev: TaskEvent, images: ReturnType<typeof snapImg>[]) =>
  saveAttachmentSnapshot("edit", userEditImagesSnapshotId(TASK_ID, ev.id), {
    images,
    paths: [],
  });

const render = (ev: TaskEvent) =>
  renderToStaticMarkup(
    createElement(
      DialogProvider,
      null,
      createElement(
        ImagePreviewProvider,
        null,
        createElement(EventRow, {
          ev,
          taskId: TASK_ID,
          task,
          variant: "chat",
          onEditInPlace: vi.fn(async () => true),
        } as never),
      ),
    ),
  );

/** 取出包含某段文字（或 aria-label）的那个 <button>…，用来判断它是不是 disabled */
const buttonContaining = (html: string, needle: string): string => {
  const seg = html.split("<button").find((s) => s.includes(needle));
  if (!seg) throw new Error(`找不到含「${needle}」的按钮：${html}`);
  return `<button${seg.slice(0, seg.indexOf("</button>"))}`;
};
const isDisabled = (btn: string) => /\sdisabled(=|\s|>)/.test(btn);
const countImgs = (html: string) => (html.match(/<img\b/g) ?? []).length;

const cleanup = () => {
  rowViewStateStore.clear();
  for (const id of ["u1", "u2", "u3"]) {
    clearAttachmentSnapshot("edit", userEditImagesSnapshotId(TASK_ID, id));
    clearAttachmentSnapshot("edit", userEditImagesSnapshotId("t2", id));
  }
};
beforeEach(cleanup);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("userEditViewKeys / clearUserEditImages", () => {
  it("三个 key（editing / draft / imagesCleared）互不相同，换任务 / 换消息都不串", () => {
    const k = userEditViewKeys("t1", "u1");
    expect(new Set([k.editing, k.draft, k.imagesCleared]).size).toBe(3);
    expect(userEditViewKeys("t2", "u1").imagesCleared).not.toBe(k.imagesCleared);
    expect(userEditViewKeys("t1", "u2").imagesCleared).not.toBe(k.imagesCleared);
    expect(Object.values(ROW_VIEW_FIELD)).toContain("user:editImagesCleared");
  });

  it("快照 id 带 taskId + 消息 id：A 任务的编辑图不会串进 B", () => {
    expect(userEditImagesSnapshotId("t1", "u1")).not.toBe(
      userEditImagesSnapshotId("t2", "u1"),
    );
    expect(userEditImagesSnapshotId("t1", "u1")).not.toBe(
      userEditImagesSnapshotId("t1", "u2"),
    );
  });

  it("clearUserEditImages：快照和「用户全删了」标记一起清，且只清这一条消息", () => {
    for (const id of ["u1", "u2"]) {
      const ev = userEv(id, 1);
      startEditing(ev, "x", true);
      setSnapshot(ev, [snapImg("a", "QUJD")]);
    }
    clearUserEditImages(TASK_ID, "u1");

    const k1 = userEditViewKeys(TASK_ID, "u1");
    expect(rowViewStateStore.has(k1.imagesCleared)).toBe(false);
    expect(
      loadAttachmentSnapshot("edit", userEditImagesSnapshotId(TASK_ID, "u1")),
    ).toBeUndefined();
    // 另一条消息原样
    expect(
      rowViewStateStore.has(userEditViewKeys(TASK_ID, "u2").imagesCleared),
    ).toBe(true);
    expect(
      loadAttachmentSnapshot("edit", userEditImagesSnapshotId(TASK_ID, "u2"))
        ?.images,
    ).toHaveLength(1);
  });

  it("没有编辑态时清理是空操作（不抛、不建空条目）", () => {
    expect(() => clearUserEditImages(TASK_ID, "never")).not.toThrow();
    expect(
      loadAttachmentSnapshot("edit", userEditImagesSnapshotId(TASK_ID, "never")),
    ).toBeUndefined();
  });
});

describe("shouldLoadOriginalImages：挂载那一刻要不要读原图", () => {
  const cases: Array<[string, { originalCount: number; snapshotImageCount: number; userCleared: boolean }, boolean]> = [
    ["原消息没图 → 不读", { originalCount: 0, snapshotImageCount: 0, userCleared: false }, false],
    ["原消息有图、快照没有、用户没清空（还没读过 / 快照被挤掉）→ 读", { originalCount: 2, snapshotImageCount: 0, userCleared: false }, true],
    ["快照里有图（用户上次的编辑结果）→ 不读，哪怕比原图少", { originalCount: 2, snapshotImageCount: 1, userCleared: false }, false],
    ["用户亲手全删了（快照空 + 标记在）→ 不读", { originalCount: 2, snapshotImageCount: 0, userCleared: true }, false],
    ["标记在但快照里又有新贴的图 → 不读（以快照为准）", { originalCount: 2, snapshotImageCount: 1, userCleared: true }, false],
  ];
  for (const [name, input, want] of cases) {
    it(name, () => expect(shouldLoadOriginalImages(input)).toBe(want));
  }
});

describe("编辑框渲染：图片按「附件快照 + 用户全删了标记」画（滚走再挂回来 = 同一个首帧）", () => {
  it("原消息有 2 张图、用户删了一张（快照剩 1 张）→ 只画这 1 张，不再读回原图、不显示载入中", () => {
    const ev = userEv("u1", 2);
    startEditing(ev, "改一下", false);
    setSnapshot(ev, [snapImg("a", "QUJD")]);
    const html = render(ev);
    expect(countImgs(html)).toBe(1);
    expect(html).toContain("data:image/png;base64,QUJD");
    expect(html).not.toContain("载入附图");
  });

  it("用户新贴了图（快照里有、原消息没图）→ 照样画出来", () => {
    const ev = userEv("u1", 0);
    startEditing(ev, "看这张新的", false);
    setSnapshot(ev, [snapImg("n", "WFla")]);
    const html = render(ev);
    expect(countImgs(html)).toBe(1);
    expect(html).toContain("data:image/png;base64,WFla");
  });

  it("用户亲手把图全删了（有「全删了」标记、快照被删空）→ 编辑框里没有图，也不会又读回来", () => {
    const ev = userEv("u1", 2);
    startEditing(ev, "只留文字", true);
    // 没有快照条目 = 空即删
    const html = render(ev);
    expect(countImgs(html)).toBe(0);
    expect(html).not.toContain("载入附图");
  });

  it("R18-03：快照被全局 LRU 挤掉、又没有「全删了」标记 → 重新读原图（显示载入中），不是悄悄变成 0 张图", () => {
    const ev = userEv("u1", 2);
    startEditing(ev, "改一下字", false);
    setSnapshot(ev, [snapImg("a", "QUJD"), snapImg("b", "REVG")]);
    // 编辑快照还在时：画 2 张
    expect(countImgs(render(ev))).toBe(2);

    // 真实的淘汰路径：别的位置（输入框 / 答题卡…）攒够 20 条以上的快照，把最老的编辑快照挤出去
    const filler = Array.from({ length: 25 }, (_, i) => `evict-${i}`);
    try {
      for (const id of filler) {
        saveAttachmentSnapshot("reply", id, { images: [snapImg(id, "RklMTA==")], paths: [] });
      }
      expect(
        loadAttachmentSnapshot("edit", userEditImagesSnapshotId(TASK_ID, ev.id)),
      ).toBeUndefined();

      const html = render(ev);
      expect(html).toContain("载入附图");
      // 读回来之前不能发（否则会带着 0 张图发出去、原图随回退一起没了）
      expect(isDisabled(buttonContaining(html, "发送"))).toBe(true);
    } finally {
      for (const id of filler) clearAttachmentSnapshot("reply", id);
    }
  });

  it("原消息有图、还没读进编辑框 → 显示「载入附图…」，发送 / 附图按钮都禁用（读完整体替换会盖掉期间贴的图）", () => {
    const ev = userEv("u1", 2);
    startEditing(ev, "改一下", false);
    const html = render(ev);
    expect(html).toContain("载入附图");
    expect(isDisabled(buttonContaining(html, "发送"))).toBe(true);
    expect(isDisabled(buttonContaining(html, 'aria-label="附图"'))).toBe(true);
  });

  it("纯文字消息：没有缩略图条、没有载入中，附图按钮可用、发送可用（有字）", () => {
    const ev = userEv("u1", 0);
    startEditing(ev, "只有字", false);
    const html = render(ev);
    expect(countImgs(html)).toBe(0);
    expect(html).not.toContain("载入附图");
    expect(isDisabled(buttonContaining(html, 'aria-label="附图"'))).toBe(false);
    expect(isDisabled(buttonContaining(html, "发送"))).toBe(false);
  });

  it("只有图、没有字也能发；既没字也没图不能发", () => {
    const withImg = userEv("u1", 0, "");
    startEditing(withImg, "", false);
    setSnapshot(withImg, [snapImg("a", "QUJD")]);
    expect(isDisabled(buttonContaining(render(withImg), "发送"))).toBe(false);

    const empty = userEv("u2", 0, "");
    startEditing(empty, "   ", false);
    expect(isDisabled(buttonContaining(render(empty), "发送"))).toBe(true);
  });

  it("图满 6 张：附图按钮禁用（上限与输入框一致）", () => {
    const ev = userEv("u1", 0);
    startEditing(ev, "x", false);
    setSnapshot(
      ev,
      Array.from({ length: 6 }, (_, i) => snapImg(`a${i}`, `ZGF0YQ${i}`)),
    );
    const html = render(ev);
    expect(countImgs(html)).toBe(6);
    expect(isDisabled(buttonContaining(html, 'aria-label="附图"'))).toBe(true);
  });

  it("别的消息 / 别的任务的编辑图不串进来", () => {
    const other = userEv("u2", 0);
    startEditing(other, "别的", false);
    setSnapshot(other, [snapImg("o", "T1RIRVI=")]);
    // t2 任务里同 id 的消息也有图
    saveAttachmentSnapshot("edit", userEditImagesSnapshotId("t2", "u1"), {
      images: [snapImg("p", "UDI=")],
      paths: [],
    });

    const ev = userEv("u1", 0);
    startEditing(ev, "我的", false);
    const html = render(ev);
    expect(countImgs(html)).toBe(0);
    expect(html).not.toContain("T1RIRVI=");
    expect(html).not.toContain("UDI=");
  });

  it("每个缩略图都带「移除」按钮（发送中除外）", () => {
    const ev = userEv("u1", 0);
    startEditing(ev, "x", false);
    setSnapshot(ev, [snapImg("a", "QUJD"), snapImg("b", "REVG")]);
    const html = render(ev);
    expect((html.match(/aria-label="移除"/g) ?? []).length).toBe(2);
  });
});

describe("buildResendPayload：images 覆盖", () => {
  const uploadPath = (u: string) => decodeURIComponent(u.split("/uploads/")[1] ?? "");
  const stubFetch = (missing: string[] = []) => {
    const fn = vi.fn(async (url: string) => {
      if (url.startsWith("/api/skills")) {
        return { ok: true, json: async () => ({ skills: [] }) };
      }
      if (url.includes("/uploads/")) {
        if (missing.includes(uploadPath(url))) return { ok: false };
        return {
          ok: true,
          arrayBuffer: async () => new Uint8Array([65, 66, 67]).buffer,
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fn);
    return fn;
  };
  const uploadCalls = (fn: ReturnType<typeof stubFetch>) =>
    fn.mock.calls.filter(([u]) => String(u).includes("/uploads/"));

  it("传了 images：原样用它，不再回读原消息的图（也就没有「部分未带上」）", async () => {
    const fn = stubFetch();
    const mine: ImagePayload[] = [
      { data: "QUJD", mimeType: "image/png", filename: "mine.png" },
    ];
    const p = await buildResendPayload(
      TASK_ID,
      { ...userEv("u1", 2), text: "改后" },
      { images: mine },
    );
    expect(p.images).toEqual(mine);
    expect(p.imagesPartial).toBe(false);
    expect(p.text).toBe("改后");
    expect(uploadCalls(fn)).toHaveLength(0);
  });

  it("传了空数组 = 用户把图全删了：一张都不带（不会被原消息的图补回来）", async () => {
    const fn = stubFetch();
    const p = await buildResendPayload(TASK_ID, userEv("u1", 2), { images: [] });
    expect(p.images).toBeUndefined();
    expect(p.imagesPartial).toBe(false);
    expect(uploadCalls(fn)).toHaveLength(0);
  });

  it("不传 images：沿用原行为——回读原消息的图（原样重发 / 重试）", async () => {
    const fn = stubFetch();
    const p = await buildResendPayload(TASK_ID, userEv("u1", 2));
    expect(p.images).toHaveLength(2);
    expect(p.images![0]).toMatchObject({
      data: "QUJD",
      mimeType: "image/png",
      filename: "img0.png",
    });
    expect(p.imagesPartial).toBe(false);
    expect(uploadCalls(fn)).toHaveLength(2);
  });

  it("不传 images 且有图读不到：带上读到的、imagesPartial = true", async () => {
    stubFetch(["img1.png"]);
    const p = await buildResendPayload(TASK_ID, userEv("u1", 2));
    expect(p.images).toHaveLength(1);
    expect(p.imagesPartial).toBe(true);
  });

  it("附件路径照原消息带（本次只改图片）", async () => {
    stubFetch();
    const ev = {
      ...userEv("u1", 0),
      meta: { attachments: [{ absPath: "/repo/a.ts", isDir: false, bytes: 1 }] },
    } as unknown as TaskEvent;
    const p = await buildResendPayload(TASK_ID, ev, { images: [] });
    expect(p.attachments).toEqual(["/repo/a.ts"]);
  });
});

describe("loadUserReplyImages（打开编辑框时读原图）", () => {
  it("没贴过图 → 空、不 partial、不发请求", async () => {
    const fn = vi.fn();
    vi.stubGlobal("fetch", fn);
    expect(await loadUserReplyImages(TASK_ID, userEv("u1", 0))).toEqual({
      images: [],
      partial: false,
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it("全部读不到 → 空 + partial（编辑框据此 toast，而不是静默丢）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
    const r = await loadUserReplyImages(TASK_ID, userEv("u1", 2));
    expect(r.images).toEqual([]);
    expect(r.partial).toBe(true);
  });

  it("网络异常也只算读不到，不抛", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const r = await loadUserReplyImages(TASK_ID, userEv("u1", 1));
    expect(r).toEqual({ images: [], partial: true });
  });
});

describe("接线契约（源码）", () => {
  it("rows：编辑态渲染 UserEditForm，发送带编辑框里最终的图；取消 / 入口消失都清图", async () => {
    const src = await read("src/components/tasks/event-stream/rows.tsx");
    expect(src).toMatch(/<UserEditForm[\s\S]{0,400}onSubmit=\{submitEdit\}/);
    expect(src).toMatch(/imagesClearedKey=\{editKeys\?\.imagesCleared \?\? null\}/);
    expect(src).toMatch(/const ok = await runEdit\(text, ev, images\);/);
    // 编辑句柄把第三参 images 原样交给父组件
    expect(src).toMatch(/await handler\(text, sourceEv, images\)/);
    // 原样重发不带 images（照原消息回读）
    expect(src).toMatch(/runHandler\(onResend, text, sourceEv\)/);
    // 取消 / 发送成功（closeEdit）与入口消失两条路径都清
    const close = src.slice(src.indexOf("const closeEdit = () => {"));
    expect(close.slice(0, close.indexOf("};"))).toContain(
      "clearUserEditImages(taskId, ev.id)",
    );
    const gone = src.slice(src.indexOf("if (!editHandler && editing) {"));
    expect(gone.slice(0, gone.indexOf("}, [editHandler"))).toContain(
      "clearUserEditImages(taskId, ev.id)",
    );
  });

  it("user-edit-form：图片走 useImageAttach + scope \"edit\" 快照；读原图被取消不落地；发的是编辑框里这一组", async () => {
    const src = await read("src/components/tasks/event-stream/user-edit-form.tsx");
    expect(src).toMatch(/useImageAttach\(\{/);
    expect(src).toMatch(
      /persist: \{ scope: "edit", id: userEditImagesSnapshotId\(taskId, ev\.id\) \}/,
    );
    // 读原图：快照没图又没「全删了」标记才读（R18-03：快照被挤掉也算）；卸载后迟到的结果不落地
    expect(src).toMatch(/if \(!loadingOriginals\) return;/);
    expect(src).toMatch(/shouldLoadOriginalImages\(\{/);
    expect(src).toMatch(/if \(cancelled\) return;/);
    expect(src).toMatch(/cancelled = true;/);
    // 读完与替换同一步结案（本次挂载内不再转圈）；不再写「已读」之类会和快照脱节的标记
    expect(src).toMatch(
      /replaceAll\(uploadPayloadsToPending\(images\)\);\s*setOriginalsSettled\(true\);/,
    );
    expect(src).not.toMatch(/imagesReady/);
    // 删掉最后一张图 = 用户亲手清空：写「全删了」标记；删图入口只能走这个封装
    expect(src).toMatch(
      /const emptiesAll = attach\.images\.every\(\(im\) => im\.id === imageId\);\s*attach\.removeImage\(imageId\);\s*if \(emptiesAll\) setClearedMark\(USER_EDIT_IMAGES_CLEARED\);/,
    );
    expect(src).toMatch(/onRemove=\{submitting \? undefined : \(\) => removeImage\(img\.id\)\}/);
    expect(src).not.toMatch(/=> attach\.removeImage\(/);
    // 读原图期间不让增删图
    expect(src).toMatch(/disabled: submitting \|\| loadingOriginals/);
    // 发送：编辑框里最终这组（可空数组）
    expect(src).toMatch(/onSubmit\(trimmed, attach\.toUploadPayload\(\) \?\? \[\]\)/);
    // 允许只有图
    expect(src).toMatch(/trimmed\.length > 0 \|\| imageCount > 0/);
    // 文本框粘贴图 + 容器拖拽 + 隐藏 file input
    expect(src).toMatch(/onPaste=\{attach\.onPaste\}/);
    expect(src).toMatch(/onDrop=\{attach\.onDrop\}/);
    expect(src).toMatch(/onChange=\{attach\.onFileInputChange\}/);
  });

  it("event-stream.handleEditInPlace：把编辑框的图交给 buildResendPayload；发送失败把图合并放回输入框", async () => {
    const src = await read("src/components/tasks/event-stream.tsx");
    const start = src.indexOf("const handleEditInPlace = useCallback(");
    const body = src.slice(start, src.indexOf("// 最后一条用户消息：重发入口挂它", start));
    expect(body).toMatch(/images\?: ImagePayload\[\]/);
    expect(body).toMatch(/images !== undefined \? \{ images \} : undefined/);
    const iFail = body.indexOf("if (sent === false) {");
    expect(iFail).toBeGreaterThan(0);
    const fail = body.slice(iFail);
    // 调用结构：把合并结果写回输入框的图（不是只引用了几个符号）
    expect(fail).toMatch(
      /replaceComposerImages\(\s*mergeRestoredList\(\s*uploadPayloadsToPending\(payload\.images\),\s*imagesRef\.current,/,
    );
    // 只在真有图时才动输入框的图
    expect(fail).toMatch(/if \(payload\.images && payload\.images\.length > 0\) \{\s*\/\/[^\n]*\n\s*replaceComposerImages\(/);
  });

  it("event-stream.handleResend（旧的编辑后追加）：编辑框给了 images 就用它、不再回读原图", async () => {
    const src = await read("src/components/tasks/event-stream.tsx");
    const start = src.indexOf("const handleResend = useCallback(");
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, src.indexOf("// 最新的 onUserReply", start));
    expect(body.length).toBeGreaterThan(200);
    expect(body).not.toContain("handleEditInPlace");
    expect(body).toMatch(/imagesOverride\?: ImagePayload\[\]/);
    expect(body).toMatch(/imagesOverride !== undefined && imagesOverride\.length > 0/);
    expect(body).toMatch(
      /imagesOverride !== undefined\s*\?\s*\[\]\s*:\s*extractUserReplyImages\(sourceEv\.meta\)/,
    );
  });
});
