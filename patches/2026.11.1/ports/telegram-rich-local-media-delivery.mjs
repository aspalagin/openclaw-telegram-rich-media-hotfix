// OpenClaw 2026.11.1: telegram-rich-local-media-delivery.
import { replaceOnce, contains } from "../helpers.mjs";
export const label = "telegram-rich-local-media-delivery";
export const verdict = "rewrite";
export const target = { key: "delivery", label: "Telegram delivery bundle", needles: ["function createReplyDeliverer(config, sender, progress) {", "async function deliverTextReply(params) {", "async function deliverMediaReply(params) {", "async function deliverReplyPlan(params, createPlan) {"] };
// Однострочный import из send-бандла (тот, что даёт createTelegramPreparedSender); хэш чанка и буквенные алиасы не фиксируются.
const SEND_BUNDLE_IMPORT_RE = /^import \{ (?=[^\n]*\bas createTelegramPreparedSender\b)[^\n]* \} from "\.\/send-[A-Za-z0-9_-]+\.mjs";$/gm;
export function patch(source) {
  if (source.includes("hotfix: telegram-rich-local-media")) return source;
  const sendImports = [...source.matchAll(SEND_BUNDLE_IMPORT_RE)];
  if (sendImports.length === 0) throw new Error("missing telegram delivery: send bundle import");
  if (sendImports.length > 1) throw new Error("ambiguous telegram delivery: send bundle import");
  const sendImportLine = sendImports[0][0];
  if (/\bas (?:resolveTelegramRichLocalMedia|isTelegramLocalMediaSource)\b/.test(source)) throw new Error("telegram delivery: helper identifiers already bound in delivery bundle");
  let next = replaceOnce(
    source,
    sendImportLine,
    sendImportLine.replace("import { ", "import { Rl as resolveTelegramRichLocalMedia, Rc as isTelegramLocalMediaSource, "),
    "telegram delivery: send bundle import",
  );
  // 2026.10.5: аргументы ответа собраны апстримом в `const textReply = { text, replyMarkup, quote, replyToId, replyToMode }` перед веткой text/media.
  if (!TEXT_REPLY_RE.test(next)) throw new Error("missing telegram delivery: textReply object (upstream layout changed)");
  const embedBranch = "\t\t\t// hotfix: telegram-rich-local-media — локальные вложения и <img src=\"/path\"> уходят внутрь rich message (InputFile подставляет prepared sender)\n"
    + "\t\t\tlet richLocalEmbed = null;\n"
    + "\t\t\tif (params.richMessages === true && !params.guestQueryId && (reply.text ?? \"\").trim() && (mediaList.some((url) => isTelegramLocalMediaSource(url)) || /<(?:img|video|audio)\\b[^>]*\\bsrc=\"(?:file:\\/\\/|\\/(?!\\/)|~\\/)/i.test(reply.text ?? \"\") || /!\\[[^\\]\\n]*\\]\\((?:file:\\/\\/|\\/(?!\\/)|~\\/)/.test(reply.text ?? \"\"))) {\n"
    + "\t\t\t\tconst resolvedRichLocal = await resolveTelegramRichLocalMedia(reply.text ?? \"\", {\n"
    + "\t\t\t\t\tmediaLoader: params.mediaLoader ?? loadWebMedia,\n"
    + "\t\t\t\t\tmaxBytes: params.mediaMaxBytes,\n"
    + "\t\t\t\t\tmediaLocalRoots: params.mediaLocalRoots,\n"
    + "\t\t\t\t\textraMediaUrls: mediaList,\n"
    + "\t\t\t\t\tlog: (message) => params.runtime.log?.(message)\n"
    + "\t\t\t\t});\n"
    + "\t\t\t\tif (resolvedRichLocal.media.length > 0) richLocalEmbed = resolvedRichLocal;\n"
    + "\t\t\t}\n"
    + "\t\t\tif (richLocalEmbed) {\n"
    + "\t\t\t\tfirstDeliveredMessageId = await deliverTextReply({\n"
    + "\t\t\t\t\t...textReply,\n"
    + "\t\t\t\t\ttext: richLocalEmbed.text\n"
    + "\t\t\t\t});\n"
    + "\t\t\t\tdeliveredMediaUrls = [...richLocalEmbed.consumedMediaUrls];\n"
    + "\t\t\t\tif (richLocalEmbed.consumedMediaUrls.length > 0) params.onMediaAccepted?.([...richLocalEmbed.consumedMediaUrls]); // hotfix: telegram-rich-local-media — встроенные вложения учитываются как принятые (block-media dedup, #146361)\n"
    + "\t\t\t\tconst remainingRichLocalMedia = mediaList.filter((url) => !richLocalEmbed.consumedMediaUrls.includes(url));\n"
    + "\t\t\t\tif (remainingRichLocalMedia.length > 0) {\n"
    + "\t\t\t\t\tconst mediaDelivery = await deliverMediaReply({\n"
    + "\t\t\t\t\t\t...textReply,\n"
    + "\t\t\t\t\t\ttext: \"\",\n"
    + "\t\t\t\t\t\treply: { ...reply, text: \"\" },\n"
    + "\t\t\t\t\t\tmediaList: remainingRichLocalMedia,\n"
    + "\t\t\t\t\t\treplyMarkup: void 0\n"
    + "\t\t\t\t\t});\n"
    + "\t\t\t\t\tif (firstDeliveredMessageId == null) firstDeliveredMessageId = mediaDelivery.firstDeliveredMessageId;\n"
    + "\t\t\t\t\tdeliveredMediaUrls = [...deliveredMediaUrls, ...mediaDelivery.mediaUrls];\n"
    + "\t\t\t\t\tif (mediaDelivery.visibleFallbackText !== void 0) contentForSentHook = mediaDelivery.visibleFallbackText;\n"
    + "\t\t\t\t}\n"
    + "\t\t\t} else ";
  // Префикс строки ветки text/media: ванильный 10.5 — `if (mediaList.length === 0 && resolvedReplyText) … deliverTextReply(textReply);`,
  // guest-слой — `if (mediaList.length === 0 && resolvedReplyText || params.guestQueryId) … deliverTextReply({ ...textReply, … })`.
  next = replaceOnce(next, TEXT_BRANCH_PREFIX, embedBranch + TEXT_BRANCH_PREFIX.trimStart(), "telegram delivery: deliverReplies text/media branch");
  return next;
}
const TEXT_BRANCH_PREFIX = "\t\t\tif (mediaList.length === 0 && resolvedReplyText";
// Объект textReply апстрима 10.5: обязательно несёт текст, кнопки, quote и reply_to-контекст (локальный replyToMode).
const TEXT_REPLY_SRC = String.raw`\t\t\tconst textReply = \{\n\t\t\t\ttext: reply\.text \|\| "",\n\t\t\t\treplyMarkup,\n\t\t\t\tquote: replyQuote,\n(?:\t\t\t\t[^\n]*\n)*?\t\t\t\treplyToId,\n\t\t\t\treplyToMode\n\t\t\t\};\n`;
const TEXT_REPLY_RE = new RegExp(TEXT_REPLY_SRC + String.raw`\t\t\tif \(mediaList\.length === 0 && resolvedReplyText`); // до патча: сразу ветка text/media
const TEXT_REPLY_PATCHED_RE = new RegExp(TEXT_REPLY_SRC + String.raw`\t\t\t// hotfix: telegram-rich-local-media — `); // после: сразу встройка
// deliverTextReply/deliverMediaReply в 10.5 — замыкания createReplyDeliverer, которые деструктурируются в deliverReplyPlan; встройка
// зовёт именно их (а не одноимённые функции другого уровня) и должна стоять внутри deliverReplyPlan.
const embedInsidePlan = (src) => {
  const plan = src.indexOf("async function deliverReplyPlan(params, createPlan) {");
  const destructure = src.indexOf("const { deliverTextReply, deliverMediaReply } = createReplyDeliverer(params, sender, progress);", plan);
  const embed = src.indexOf("if (richLocalEmbed) {", plan);
  const end = src.indexOf("\n}\n", plan);
  return plan >= 0 && destructure > plan && embed > destructure && embed < end ? null : "embed branch is not inside deliverReplyPlan after createReplyDeliverer destructuring";
};
export const check = { gate: "required", assertions: [
  contains("Rl as resolveTelegramRichLocalMedia, Rc as isTelegramLocalMediaSource,", "delivery imports helper from send bundle"),
  (src) => /^import \{ Rl as resolveTelegramRichLocalMedia, Rc as isTelegramLocalMediaSource, [^\n]*\bas createTelegramPreparedSender\b[^\n]* \} from "\.\/send-[A-Za-z0-9_-]+\.mjs";$/m.test(src) ? null : "helper import is not on the send-bundle import line (createTelegramPreparedSender)",
  contains("if (richLocalEmbed) {", "deliverReplies embed branch"),
  contains("\t\t\t\tfirstDeliveredMessageId = await deliverTextReply({\n\t\t\t\t\t...textReply,\n\t\t\t\t\ttext: richLocalEmbed.text\n\t\t\t\t});", "embed branch delivers resolved text via deliverTextReply(...textReply)"),
  contains("const remainingRichLocalMedia = mediaList.filter(", "unconsumed media go through deliverMediaReply"),
  contains("params.onMediaAccepted?.([...richLocalEmbed.consumedMediaUrls]);", "embedded media reported via onMediaAccepted (block-media dedup)"),
  contains("\t\t\t} else if (mediaList.length === 0 && resolvedReplyText", "embed branch chained before upstream text branch (else-if)"),
  contains("\t\t\telse if (mediaList.length > 0) {\n\t\t\t\tconst mediaDelivery = await deliverMediaReply({\n\t\t\t\t\t...textReply,", "upstream media branch still follows (deliverMediaReply({ ...textReply }))"),
  // дрейф: textReply обязан нести quote/reply_to/replyToMode — иначе встройка потеряет reply_to
  (src) => TEXT_REPLY_PATCHED_RE.test(src) ? null : "upstream textReply object (text, replyMarkup, quote … replyToId, replyToMode) missing/changed or embed branch not directly after it",
  (src) => (src.match(/\n\t\t\tconst textReply = \{\n/g) ?? []).length === 1 ? null : "expected exactly one textReply object in deliverReplyPlan",
  (src) => src.includes("\t\tconst replyToMode = params.replyToMode === \"off\" && ") ? null : "upstream local replyToMode ([[reply_to_current]]) changed — re-check embed reply_to",
  (src) => src.includes("onMediaAccepted: params.onMediaAccepted\n\t});") ? null : "prepared sender no longer receives params.onMediaAccepted — re-check block-media dedup contract",
  // 10.5 дрейф-сторожа: контекст доставки в замыкании (config = params deliverReplyPlan), mediaLoader/корни/лимит — те же поля
  embedInsidePlan,
  contains("\tconst mediaLoader = config.mediaLoader ?? loadWebMedia;\n", "upstream media loader source (config.mediaLoader ?? loadWebMedia) — embed uses the same"),
  contains("\t\t\tconst media = await mediaLoader(mediaUrl, buildOutboundMediaLoadOptions({\n\t\t\t\tmediaLocalRoots: config.mediaLocalRoots,\n\t\t\t\tmaxBytes: config.mediaMaxBytes\n\t\t\t}));", "upstream media load options (mediaLocalRoots/mediaMaxBytes) — embed passes the same"),
  contains("\t\t\tcontext: config.richMessages ? \"sendRichMessage\" : \"sendMessage\",", "deliverTextReply sends rich pages via prepared sender (sendRichMessage)"),
] };
