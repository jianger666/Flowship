/**
 * 修订「上一处 / 下一处」跳转（与 ArtifactRevisionView 拆开，避免 panel 静态 import 视图 chunk）
 */

/** 供 toolbar：在滚动容器内找 [data-revision-hit] 并闪一下 ring */
export const jumpRevisionHit = (
  scroller: HTMLElement,
  direction: "prev" | "next",
  currentIndex: number,
): number => {
  const hits = Array.from(
    scroller.querySelectorAll<HTMLElement>("[data-revision-hit]"),
  );
  if (hits.length === 0) return -1;
  let next = direction === "next" ? currentIndex + 1 : currentIndex - 1;
  if (next < 0) next = hits.length - 1;
  if (next >= hits.length) next = 0;
  const el = hits[next]!;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("ring-2", "ring-primary", "ring-offset-2");
  window.setTimeout(() => {
    el.classList.remove("ring-2", "ring-primary", "ring-offset-2");
  }, 900);
  return next;
};
