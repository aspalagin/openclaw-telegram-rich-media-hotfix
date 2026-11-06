// OpenClaw 2026.11.1: telegram-rich-local-media-prefer-payload.
import { replaceOnce, contains, notContains } from "../helpers.mjs";
export const label = "telegram-rich-local-media-prefer-payload";
export const verdict = "port";
export const target = {
 "key": "telegramOutboundAdapter",
 "label": "Telegram outbound adapter bundle",
 "needles": [
  "function createTelegramOutboundAdapter(options = {}) {",
  "extractMarkdownImages: true,"
 ]
};
// ---- старый патч (inventory/patch-src/telegram-rich-local-media-prefer-payload.mjs) ----
// label=telegram-rich-local-media-prefer-payload target=telegramOutboundAdapter runApplyLine=5193 applyLines=4513-4531
function patchTelegramOutboundAdapterPreferPayload(source) {
  let next = source;
  if (next.includes("hotfix: telegram-rich-local-media-prefer-payload")) return next;
  return replaceOnce(
    next,
    "\t\tshouldSuppressLocalPayloadPrompt: options.shouldSuppressLocalPayloadPrompt,\n",
    "\t\t// hotfix: telegram-rich-local-media-prefer-payload — текст + локальные вложения rich-аккаунта ядро отдаёт через sendPayload (встраивание в rich message)\n"
      + "\t\tpreferPayloadForMedia: ({ payload, cfg, accountId, forceDocument }) => Boolean(cfg) && forceDocument !== true && (process.env.OPENCLAW_TELEGRAM_RICH_LOCAL_MEDIA ?? \"1\").trim() !== \"0\" && typeof payload?.text === \"string\" && payload.text.trim().length > 0 && resolveSendableOutboundReplyParts(payload).mediaUrls.some((url) => /^(?:file:\\/\\/|\\/(?!\\/)|~\\/)/.test(url.trim())) && resolveTelegramRichMessages({\n"
      + "\t\t\tcfg,\n"
      + "\t\t\taccountId\n"
      + "\t\t}),\n"
      + "\t\tshouldSuppressLocalPayloadPrompt: options.shouldSuppressLocalPayloadPrompt,\n",
    "telegram outbound adapter: preferPayloadForMedia capability",
  );
}

// ---- telegram-rich-chunk-limit (2026-08-25) ----
// Ядро доставки режет текст тула message/announce на куски ≤4096 символов обычным markdown-чанкером до передачи
// в Telegram-адаптер (resolveEffectiveTextChunkLimit → min(fallback, 4096)). Для rich-аккаунтов это ломает длинные
// сообщения с HTML-блоками (<tg-slideshow>, <figure>, <table>): разрез попадает внутрь блока, части теряются
// (25.08 03:43: из 7 галерей дошло 6, заголовок «Мой выбор» пропал). Rich-сообщения Telegram допускают до 32768
// символов, а send bundle сам режет HTML-aware (splitTelegramRichMarkdownChunks/splitTelegramHtmlChunks с лимитами
// блоков/медиа). Патч: для richMessages=true адаптер возвращает лимит 32768, иначе прежние 4096.

// ---- /старый патч ----
export function patch(source) { return patchTelegramOutboundAdapterPreferPayload(source); }
export const check = { gate: "required", assertions: [
      contains("preferPayloadForMedia: ({ payload, cfg, accountId, forceDocument }) =>", "adapter preferPayloadForMedia capability"),
      contains("resolveSendableOutboundReplyParts(payload).mediaUrls.some((url) =>", "adapter checks local media urls"),
      // сторож ReferenceError: идентификаторы вставки импортированы в чанк (в 9.7 merge/default-хелперы из чанка ушли)
      (src) => /^import \{[^\n]*\bas resolveTelegramRichMessages\b[^\n]*\} from "\.\/[^"]+\.mjs";$/m.test(src) ? null : "resolveTelegramRichMessages not imported in outbound adapter chunk",
      (src) => /^import \{[^\n]*\bas resolveSendableOutboundReplyParts\b[^\n]*\} from "\.\/[^"]+\.mjs";$/m.test(src) ? null : "resolveSendableOutboundReplyParts not imported in outbound adapter chunk",
      notContains("mergeTelegramAccountConfig(cfg, accountId ?? resolveDefaultTelegramAccountId(cfg)).richMessages === true,\n\t\tshouldSuppressLocalPayloadPrompt", "stale 9.6 rich check (unimported helpers)"),
    ] };
