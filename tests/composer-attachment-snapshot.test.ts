/** 输入条附件快照（图 + 路径、切页/切任务不丢）的单测。 */
import { describe, expect, it } from "vitest";
import {
  clearAttachmentSnapshot,
  loadAttachmentSnapshot,
  saveAttachmentSnapshot,
  updateAttachmentSnapshot,
  __setAttachmentSnapBytesCapForTests,
} from "@/lib/view-memory";

const snap = (n: number) => ({
  images: [
    {
      id: `img${n}`,
      data: `${n}`,
      mimeType: "image/png",
      filename: `${n}.png`,
    },
  ],
  paths: [`/tmp/${n}.ts`],
});

describe("composer attachment snapshot", () => {
  it("存了就能读回来", () => {
    saveAttachmentSnapshot("reply", "task-a", snap(1));
    expect(loadAttachmentSnapshot("reply", "task-a")).toEqual(snap(1));
    clearAttachmentSnapshot("reply", "task-a");
  });

  it("按 scope + task 隔离（A 的图不串进 B）", () => {
    saveAttachmentSnapshot("reply", "task-a", snap(1));
    saveAttachmentSnapshot("talk", "task-a", snap(2));
    saveAttachmentSnapshot("reply", "task-b", snap(3));
    expect(loadAttachmentSnapshot("reply", "task-a")).toEqual(snap(1));
    expect(loadAttachmentSnapshot("talk", "task-a")).toEqual(snap(2));
    expect(loadAttachmentSnapshot("reply", "task-b")).toEqual(snap(3));
    clearAttachmentSnapshot("reply", "task-a");
    clearAttachmentSnapshot("talk", "task-a");
    clearAttachmentSnapshot("reply", "task-b");
  });

  it("没记过返回 undefined；清掉后也一样", () => {
    expect(loadAttachmentSnapshot("reply", "no-such-task")).toBeUndefined();
    saveAttachmentSnapshot("reply", "task-c", snap(4));
    clearAttachmentSnapshot("reply", "task-c");
    expect(loadAttachmentSnapshot("reply", "task-c")).toBeUndefined();
  });

  it("只保留最近 20 个、超了裁最老的", () => {
    for (let i = 0; i < 25; i++) {
      saveAttachmentSnapshot("reply", `cap-task-${i}`, snap(i));
    }
    // 最老的 5 个被挤掉，最新的还在
    expect(loadAttachmentSnapshot("reply", "cap-task-0")).toBeUndefined();
    expect(loadAttachmentSnapshot("reply", "cap-task-4")).toBeUndefined();
    expect(loadAttachmentSnapshot("reply", "cap-task-24")).toEqual(snap(24));
    for (let i = 5; i < 25; i++) {
      clearAttachmentSnapshot("reply", `cap-task-${i}`);
    }
  });

  it("原子更新：两边各换一半、互不覆盖（模拟图粘贴和 picker 并发）", () => {
    saveAttachmentSnapshot("reply", "atomic-task", {
      images: snap(1).images,
      paths: [],
    });
    // paths 侧只换 paths，images 原样保留
    updateAttachmentSnapshot("reply", "atomic-task", (prev) => ({
      images: prev?.images ?? [],
      paths: ["/tmp/a.ts"],
    }));
    // images 侧只换 images，paths 原样保留
    updateAttachmentSnapshot("reply", "atomic-task", (prev) => ({
      images: snap(2).images,
      paths: prev?.paths ?? [],
    }));
    expect(loadAttachmentSnapshot("reply", "atomic-task")).toEqual({
      images: snap(2).images,
      paths: ["/tmp/a.ts"],
    });
    clearAttachmentSnapshot("reply", "atomic-task");
  });

  it("空即删：updater 返回空快照时不占 cap 名额", () => {
    saveAttachmentSnapshot("reply", "empty-task", snap(1));
    updateAttachmentSnapshot("reply", "empty-task", () => ({
      images: [],
      paths: [],
    }));
    expect(loadAttachmentSnapshot("reply", "empty-task")).toBeUndefined();
  });

  it("字节超容时先裁最老的、刚写入的不动", () => {
    __setAttachmentSnapBytesCapForTests(10);
    try {
      saveAttachmentSnapshot("reply", "byte-old", snap(1));
      saveAttachmentSnapshot("reply", "byte-new", snap(2));
      // data(1 字符)+paths(8 字符)=9 字节/个，两个 18 > 10，老的被挤掉
      expect(loadAttachmentSnapshot("reply", "byte-old")).toBeUndefined();
      expect(loadAttachmentSnapshot("reply", "byte-new")).toEqual(snap(2));
      clearAttachmentSnapshot("reply", "byte-new");
    } finally {
      __setAttachmentSnapBytesCapForTests(100 * 1024 * 1024);
    }
  });

  it("空即删：更新成空快照不占条目（restore 空任务不污染 cap）", () => {
    saveAttachmentSnapshot("reply", "empty-task", snap(1));
    expect(loadAttachmentSnapshot("reply", "empty-task")).toEqual(snap(1));
    // 两边都清成空 → 条目直接删掉，不是存 {images:[],paths:[]}
    updateAttachmentSnapshot("reply", "empty-task", () => ({
      images: [],
      paths: [],
    }));
    expect(loadAttachmentSnapshot("reply", "empty-task")).toBeUndefined();
  });
});
