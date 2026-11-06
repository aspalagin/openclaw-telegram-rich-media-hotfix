// OpenClaw 2026.11.1: telegram-rich-local-media-patterns.
import { replaceOnce, contains } from "../helpers.mjs";
export const label = "telegram-rich-local-media-patterns";
export const verdict = "rewrite";
export const target = { key: "telegramSentCache", label: "Telegram rich-blocks HTML parser bundle", needles: ["const MEDIA_SRC_RE = ", "function splitTelegramRichBlocks(blocks, options = {}) {", "function buildTelegramRichBlocksPlan(blocks, options) {"] };
export function patch(source) {
  if (source.includes("hotfix: telegram-rich-local-media")) return source;
  return replaceOnce(
    source,
    "const MEDIA_SRC_RE = /^https:\\/\\//i;",
    "const MEDIA_SRC_RE = /^(?:https:\\/\\/|tg:\\/\\/(?:photo|video|audio|document)\\?id=[A-Za-z0-9_-]{1,64})/i; // hotfix: telegram-rich-local-media — tg://…?id= как источник медиа",
    "rich-blocks MEDIA_SRC_RE",
  );
}
export const check = { gate: "required", assertions: [
  contains("hotfix: telegram-rich-local-media", "local media marker"),
  contains("tg:\\/\\/(?:photo|video|audio|document)\\?id=[A-Za-z0-9_-]{1,64}", "tg:// media source pattern"),
] };
