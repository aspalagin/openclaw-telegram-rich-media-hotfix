// OpenClaw 2026.11.1: telegram-rich-media-limit.
function strictReplace(src, before, after, label) {
  const i = src.indexOf(before); if (i === -1) throw new Error(`missing ${label}`);
  if (src.indexOf(before, i + before.length) !== -1) throw new Error(`ambiguous ${label}`);
  return src.slice(0, i) + after + src.slice(i + before.length);
}
export const label = "telegram-rich-media-limit";
export const verdict = "port";
export const target = { key: "telegramTextChunkLimit", label: "Telegram text-chunk-limit bundle (rich-block-split)", needles: ["//#region extensions/telegram/src/rich-block-split.ts", "const TELEGRAM_RICH_MEDIA_LIMIT = 50;"] };
export function patch(source) {
  if (source.includes("hotfix: telegram-rich-media-limit")) return source;
  return strictReplace(source,
    "const TELEGRAM_RICH_MEDIA_LIMIT = 50;\n",
    "// hotfix: telegram-rich-media-limit — фактический потолок Telegram: с 21-го медиа блок и всё после него молча выбрасываются (25.08.2026)\nconst TELEGRAM_RICH_MEDIA_LIMIT = 20;\n",
    "telegram rich media limit constant");
}
export const check = { gate: "required", assertions: [
  (c) => c.includes("hotfix: telegram-rich-media-limit") ? null : "rich media limit marker missing",
  (c) => c.includes("const TELEGRAM_RICH_MEDIA_LIMIT = 20;") ? null : "rich media limit is not 20",
  (c) => c.includes("size.media > TELEGRAM_RICH_MEDIA_LIMIT") ? null : "media limit no longer used by exceedsRichBlockLimits",
] };
