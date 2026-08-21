/**
 * 栏内搜索用的 CSS Custom Highlight 样式。
 *
 * 必须写成 JS 字符串、由 layout 用 `<style>` 注入，不能进 `globals.css`：
 * Next 15.5.20 的 Turbopack 走 Lightning CSS，还不认 `::highlight()`
 *（webpack 能过；upstream lightningcss #970 已合、但还没进本版 Next）。
 * `pnpm dev:web` 已切 `--turbo`，这段若留在 globals 会整站编译失败。
 */
export const SEARCH_HIGHLIGHT_CSS = `
::highlight(flowship-artifact-search),
::highlight(flowship-event-search) {
  color: inherit;
  background-color: color-mix(in oklch, var(--warning) 45%, transparent);
}
::highlight(flowship-artifact-search-active),
::highlight(flowship-event-search-active) {
  color: inherit;
  background-color: color-mix(in oklch, var(--warning) 78%, transparent);
  text-decoration: underline 2px color-mix(in oklch, var(--warning) 85%, black);
}
`.trim();
