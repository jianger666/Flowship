/** 从时间流点音视频：对比组怎么组、从哪一项开始。 */
import { afterEach, describe, expect, it } from "vitest";

import { buildMediaOpenRequest, openMediaInGroup } from "@/lib/media/media-open";
import {
  closeMedia,
  getPlayerSnapshot,
  resetPlayerStoreForTests,
} from "@/lib/media/player-store";

afterEach(() => {
  resetPlayerStoreForTests();
});

const group = [
  { absolute: "/v/a.mp3" },
  { absolute: "/v/b.mp3" },
  { absolute: "/v/c.mp3" },
];

describe("buildMediaOpenRequest", () => {
  it("同一条消息的多个文件成一组，从被点的那个开始", () => {
    const req = buildMediaOpenRequest(group, { absolute: "/v/b.mp3" });
    expect(req.items.map((i) => i.path)).toEqual(["/v/a.mp3", "/v/b.mp3", "/v/c.mp3"]);
    expect(req.index).toBe(1);
  });

  it("时间片段只作用于被点的那一项", () => {
    const req = buildMediaOpenRequest(group, { absolute: "/v/c.mp3", start: 12.4, end: 15 });
    expect(req.items[2]).toMatchObject({ path: "/v/c.mp3", start: 12.4, end: 15 });
    expect(req.items[0]!.start).toBeUndefined();
    expect(req.items[1]!.end).toBeUndefined();
  });

  it("只有一个文件 / 没有组 / 被点的不在组里 → 单项会话", () => {
    expect(buildMediaOpenRequest(null, { absolute: "/x/y.mp4" })).toEqual({
      items: [{ path: "/x/y.mp4", start: undefined, end: undefined }],
      index: 0,
    });
    expect(buildMediaOpenRequest([{ absolute: "/x/y.mp4" }], { absolute: "/x/y.mp4" }).items).toHaveLength(1);
    const req = buildMediaOpenRequest(group, { absolute: "/other/z.mp4", start: 3 });
    expect(req.items).toEqual([{ path: "/other/z.mp4", start: 3, end: undefined }]);
    expect(req.index).toBe(0);
  });
});

describe("openMediaInGroup → 播放器会话", () => {
  it("打开后会话里是整组、当前项是被点的那个", () => {
    openMediaInGroup(group, { absolute: "/v/b.mp3" });
    const snap = getPlayerSnapshot();
    expect(snap.session?.items).toHaveLength(3);
    expect(snap.session?.index).toBe(1);
    expect(snap.currentPath).toBe("/v/b.mp3");
    closeMedia();
    expect(getPlayerSnapshot().session).toBeNull();
  });

  it("非音视频路径被丢弃，不会打开空播放器", () => {
    openMediaInGroup(null, { absolute: "/v/readme.md" });
    expect(getPlayerSnapshot().session).toBeNull();
  });
});
