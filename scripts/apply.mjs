#!/usr/bin/env node
// Portable hotfix: Telegram rich messages with embedded media for OpenClaw 2026.7.1-2.
// Patches built dist/*.js bundles of an installed OpenClaw package. Review before use.
// Usage: node scripts/apply.mjs [--dry-run] [--report-all]   (OPENCLAW_PACKAGE_ROOT=/usr/lib/node_modules/openclaw)
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const packageRoot = process.env.OPENCLAW_PACKAGE_ROOT || "/usr/lib/node_modules/openclaw";
const distDir = path.join(packageRoot, "dist");
const backupRoot = process.env.OPENCLAW_HOTFIX_BACKUP_DIR || path.join(process.env.HOME || "/root", "openclaw-backups", "openclaw-telegram-rich-media-hotfix");
const expectedPackageVersion = "2026.7.1-2";
const dryRun = process.argv.includes("--dry-run") || process.argv.includes("--check");
const reportAll = process.argv.includes("--report-all");

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}
function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
}
function read(file) {
  return fs.readFileSync(file, "utf8");
}
function walkJs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJs(full));
    else if (entry.isFile() && entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}
function findOne(files, label, needles) {
  const matches = [];
  for (const file of files) {
    const content = read(file);
    if (needles.every((needle) => content.includes(needle))) matches.push(file);
  }
  if (matches.length === 0) throw new Error(`could not find ${label}`);
  if (matches.length > 1) throw new Error(`found multiple ${label}: ${matches.join(", ")}`);
  return matches[0];
}
function replaceOnce(source, before, after, label) {
  const index = source.indexOf(before);
  if (index === -1) throw new Error(`missing ${label}`);
  if (source.indexOf(before, index + before.length) !== -1) throw new Error(`ambiguous ${label}`);
  return `${source.slice(0, index)}${after}${source.slice(index + before.length)}`;
}
function backupFile(file, before) {
  const rel = path.relative(path.resolve(packageRoot), path.resolve(file));
  const backupPath = path.join(backupRoot, timestamp(), `${rel}.${sha256(before).slice(0, 12)}.bak`);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(backupPath, before, { mode: 0o600 });
  return backupPath;
}
function applyFile(file, label, patch) {
  const before = read(file);
  const after = patch(before);
  if (after === before) {
    console.log(`[telegram-rich-media-hotfix] ${label}: ok`);
    return { label, file, changed: false };
  }
  if (dryRun) {
    console.log(`[telegram-rich-media-hotfix] ${label}: would patch ${file}`);
    return { label, file, changed: true };
  }
  const backupPath = backupFile(file, before);
  fs.writeFileSync(file, after, "utf8");
  console.log(`[telegram-rich-media-hotfix] ${label}: patched ${file}; backup=${backupPath}`);
  return { label, file, changed: true, backupPath };
}

// ---- telegram-rich-keep-html-media (2026-08-25) ----
// Telegram outbound adapter в 2026.7.1-2 безусловно гонит текст через sanitizeForPlainText:
// все HTML-теги вырезаются (<h2> → *…*, <figure>/<img>/<tg-slideshow>/<details> — удаляются),
// поэтому при richMessages=true медиа-блоки Bot API 10.1+ (картинки внутри rich message) и
// прочие HTML-островки никогда не доходили до sendRichMessage. Апстрим (extensions/telegram/
// src/outbound-adapter.ts, 2026-08) делает sanitize условным: rich-аккаунты получают только
// sanitizeAssistantVisibleText. Патч воспроизводит это: (1) deliver-handler прокидывает cfg и
// accountId в outbound.sanitizeText; (2) Telegram-адаптер пропускает plain-text sanitize,
// если для аккаунта включён richMessages.
function patchDeliverSanitizeTextContext(source) {
  if (source.includes("hotfix: telegram-rich-keep-html-media")) return source;
  return replaceOnce(
    source,
    "\t\tsanitizeText: outbound?.sanitizeText ? (payload) => outbound.sanitizeText({\n\t\t\ttext: payload.text ?? \"\",\n\t\t\tpayload\n\t\t}) : void 0,",
    "\t\tsanitizeText: outbound?.sanitizeText ? (payload) => outbound.sanitizeText({\n\t\t\ttext: payload.text ?? \"\",\n\t\t\tpayload,\n\t\t\tcfg: params.cfg,\n\t\t\taccountId: params.accountId\n\t\t}) : void 0, // hotfix: telegram-rich-keep-html-media — cfg/accountId для channel-aware sanitize",
    "deliver handler sanitizeText context",
  );
}
function makePatchTelegramRichKeepHtmlMedia(targets) {
  return (source) => {
    if (source.includes("hotfix: telegram-rich-keep-html-media")) return source;
    const accountConfigImport = `import { t as mergeTelegramAccountConfig } from "./${path.basename(targets.telegramAccountConfig)}";`;
    const accountSelectionImport = `import { n as resolveDefaultTelegramAccountId } from "./${path.basename(targets.telegramAccountSelection)}";`;
    let next = replaceOnce(
      source,
      "import { t as sanitizeForPlainText } from \"./sanitize-text-",
      `${accountConfigImport}\n${accountSelectionImport}\nimport { t as sanitizeForPlainText } from "./sanitize-text-`,
      "telegram outbound adapter sanitize-text import",
    );
    next = replaceOnce(
      next,
      "\t\tsanitizeText: ({ text }) => sanitizeForPlainText(sanitizeAssistantVisibleText(text)),",
      "\t\t// hotfix: telegram-rich-keep-html-media — rich-аккаунты сохраняют HTML-островки (<figure>/<img>/<tg-slideshow>/<details>) для sendRichMessage\n"
        + "\t\tsanitizeText: ({ text, cfg, accountId }) => cfg && mergeTelegramAccountConfig(cfg, accountId ?? resolveDefaultTelegramAccountId(cfg)).richMessages === true ? sanitizeAssistantVisibleText(text) : sanitizeForPlainText(sanitizeAssistantVisibleText(text)),",
      "telegram outbound adapter sanitizeText",
    );
    return next;
  };
}

// ---- telegram-rich-local-media (2026-08-25) ----
// Bot API 10.2+ позволяет загружать файлы прямо в rich message (InputRichMessage.media + ссылки tg://photo|video|audio?id=),
// но OpenClaw 2026.7.1-2 умеет только HTTP(S)-медиа в rich HTML, а локальные файлы (MEDIA:, ![](/path), <img src="/path">)
// шлёт отдельными sendPhoto/sendDocument. Патч добавляет helper resolveTelegramRichLocalMedia (send bundle), который
// грузит локальные файлы через loadWebMedia, кладёт их в rich_message.media (grammY сериализует InputFile как attach://)
// и подменяет src на tg://…?id=. Врезки: sendMessageTelegram (message tool), sendTelegramText/deliverReplies (reply path),
// Telegram outbound adapter (вложения-картинки → внутрь текста), паттерны rich HTML (src="tg://…" допустим).
// Kill-switch: OPENCLAW_TELEGRAM_RICH_LOCAL_MEDIA=0. При ошибке sendRichMessage с медиа — повтор без медиа-блоков.
const TELEGRAM_RICH_LOCAL_MEDIA_HELPER_PATH = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "patches", "telegram-rich-local-media.helper.js");
function patchTelegramSentCacheRichLocalMediaPatterns(source) {
  if (source.includes("hotfix: telegram-rich-local-media")) return source;
  const srcAlternative = 'src="(?:https?:\\/\\/[^"]+|tg:\\/\\/(?:photo|video|audio|document)\\?id=[A-Za-z0-9_-]{1,64})"';
  const lines = source.split("\n");
  let blockPatched = 0;
  let attrPatched = 0;
  const next = lines.map((line) => {
    if (line.startsWith("const TELEGRAM_RICH_MEDIA_BLOCK_PATTERN = ")) {
      blockPatched += 1;
      return line.split('src="https?:\\/\\/[^"]+"').join(srcAlternative) + " // hotfix: telegram-rich-local-media — tg://…?id= как источник медиа";
    }
    if (/^\t\["(?:img|video|audio)", \/\^\(\?=\.\*\\ssrc="https\?:/.test(line)) {
      attrPatched += 1;
      return line.split('https?:\\/\\/[^"]+').join('(?:https?:\\/\\/[^"]+|tg:\\/\\/(?:photo|video|audio|document)\\?id=[A-Za-z0-9_-]{1,64})');
    }
    return line;
  }).join("\n");
  if (blockPatched !== 1) throw new Error(`telegram-rich-local-media: TELEGRAM_RICH_MEDIA_BLOCK_PATTERN lines=${blockPatched}`);
  if (attrPatched !== 3) throw new Error(`telegram-rich-local-media: img/video/audio attr pattern lines=${attrPatched}`);
  if (!next.includes('src="(?:https?:\\/\\/[^"]+|tg:\\/\\/(?:photo|video|audio|document)\\?id=[A-Za-z0-9_-]{1,64})"')) throw new Error("telegram-rich-local-media: block pattern replacement missing");
  return next;
}
function patchTelegramSendRichLocalMedia(source) {
  if (source.includes("hotfix: telegram-rich-local-media")) return source;
  const helper = read(TELEGRAM_RICH_LOCAL_MEDIA_HELPER_PATH).trimEnd() + "\n";
  let next = replaceOnce(
    source,
    "async function sendMessageTelegram(to, text, opts) {\n",
    helper + "async function sendMessageTelegram(to, text, opts) {\n",
    "telegram send: sendMessageTelegram declaration (helper insertion point)",
  );
  next = replaceOnce(
    next,
    "\t\t\t\t\t\trich_message: chunk.skipEntityDetection ? {\n\t\t\t\t\t\t\thtml: chunk.text,\n\t\t\t\t\t\t\tskip_entity_detection: true\n\t\t\t\t\t\t} : { html: chunk.text },\n",
    "\t\t\t\t\t\trich_message: buildTelegramRichLocalMediaMessage(chunk, options.richLocalMedia), // hotfix: telegram-rich-local-media\n",
    "telegram send: rich_message chunk payload",
  );
  next = replaceOnce(
    next,
    "\t\t\t} catch (err) {\n\t\t\t\tconst fallbackPlan = buildTelegramPlainFallbackPlan({\n\t\t\t\t\thtml: chunk.text,\n\t\t\t\t\terr,\n\t\t\t\t\tcontext: \"richMessage\",\n",
    "\t\t\t} catch (err) {\n"
      + "\t\t\t\tif (telegramRichLocalMediaAppliesToChunk(chunk.text, options.richLocalMedia) && chunk.richLocalMediaRetried !== true) {\n"
      + "\t\t\t\t\tsendLogger.warn(`[hotfix][telegram-rich-local-media] richMessage with embedded media failed; retrying without media: ${formatErrorMessage(err)}`);\n"
      + "\t\t\t\t\tchunks[index] = { ...chunk, text: stripTelegramRichLocalMediaBlocks(chunk.text), richLocalMediaRetried: true };\n"
      + "\t\t\t\t\tindex -= 1;\n"
      + "\t\t\t\t\tcontinue;\n"
      + "\t\t\t\t}\n"
      + "\t\t\t\tconst fallbackPlan = buildTelegramPlainFallbackPlan({\n\t\t\t\t\thtml: chunk.text,\n\t\t\t\t\terr,\n\t\t\t\t\tcontext: \"richMessage\",\n",
    "telegram send: richMessage catch (retry without media)",
  );
  next = replaceOnce(
    next,
    "\tif (!text || !text.trim()) throw new Error(\"Message must be non-empty for Telegram sends\");\n\tconst textResult = await sendChunkedText(text, \"text send\");\n",
    "\tif (!text || !text.trim()) throw new Error(\"Message must be non-empty for Telegram sends\");\n"
      + "\t// hotfix: telegram-rich-local-media — локальные файлы (<img src=\"/path\">, ![](/path), opts.richLocalMediaUrls) встраиваются в rich message\n"
      + "\tconst richLocal = useRichMessages && opts.forceDocument !== true ? await resolveTelegramRichLocalMedia(text, {\n"
      + "\t\tmaxBytes: mediaMaxBytes,\n"
      + "\t\tmediaLocalRoots: opts.mediaLocalRoots,\n"
      + "\t\tmediaReadFile: opts.mediaReadFile,\n"
      + "\t\textraMediaUrls: opts.richLocalMediaUrls,\n"
      + "\t\tlog: (message) => sendLogger.warn(message)\n"
      + "\t}) : { text, media: [], consumedMediaUrls: [] };\n"
      + "\tif (!richLocal.text.trim()) throw new Error(\"Message must be non-empty for Telegram sends\");\n"
      + "\tconst textResult = await sendChunkedText(richLocal.text, \"text send\", richLocal.media.length > 0 ? { richLocalMedia: richLocal.media } : {});\n"
      + "\tfor (const unconsumedUrl of (Array.isArray(opts.richLocalMediaUrls) ? opts.richLocalMediaUrls : []).filter((url) => !richLocal.consumedMediaUrls.includes(url))) await sendMessageTelegram(to, \"\", {\n"
      + "\t\t...opts,\n"
      + "\t\tmediaUrl: unconsumedUrl,\n"
      + "\t\trichLocalMediaUrls: void 0,\n"
      + "\t\tbuttons: void 0\n"
      + "\t});\n",
    "telegram send: text-only send (local media resolution)",
  );
  next = replaceOnce(
    next,
    "export { splitTelegramRichMessageTextChunks as A,",
    "export { resolveTelegramRichLocalMedia as Rl, stripTelegramRichLocalMediaBlocks as Rs, isTelegramLocalMediaSource as Rc, isTelegramRichLocalMediaEnabled as Re, splitTelegramRichMessageTextChunks as A,",
    "telegram send: export list",
  );
  return next;
}
function patchTelegramDeliveryRichLocalMedia(source) {
  if (source.includes("hotfix: telegram-rich-local-media")) return source;
  let next = replaceOnce(
    source,
    "import { A as splitTelegramRichMessageTextChunks, E as getTelegramRichRawApi,",
    "import { Rl as resolveTelegramRichLocalMedia, Rs as stripTelegramRichLocalMediaBlocks, Rc as isTelegramLocalMediaSource, A as splitTelegramRichMessageTextChunks, E as getTelegramRichRawApi,",
    "telegram delivery: send bundle import",
  );
  next = replaceOnce(
    next,
    "\t\tconst richPlan = buildTelegramRichMessagePlan(text, textMode, {\n\t\t\tskipEntityDetection: opts.linkPreview === false,\n\t\t\ttableMode: opts.tableMode\n\t\t});\n",
    "\t\tconst richPlan = buildTelegramRichMessagePlan(text, textMode, {\n\t\t\tskipEntityDetection: opts.linkPreview === false,\n\t\t\ttableMode: opts.tableMode\n\t\t});\n"
      + "\t\tconst richLocalMediaForChunk = Array.isArray(opts.richLocalMedia) ? opts.richLocalMedia.filter((entry) => richPlan.richMessage.html.includes(`?id=${entry.id}\"`)) : []; // hotfix: telegram-rich-local-media\n",
    "telegram delivery: sendTelegramText rich plan",
  );
  next = replaceOnce(
    next,
    "\t\t\t\t\trich_message: richPlan.richMessage,\n",
    "\t\t\t\t\trich_message: richLocalMediaForChunk.length > 0 ? { ...richPlan.richMessage, media: richLocalMediaForChunk.map((entry) => entry.media) } : richPlan.richMessage,\n",
    "telegram delivery: sendTelegramText rich_message payload",
  );
  next = replaceOnce(
    next,
    "\t\t} catch (err) {\n\t\t\tconst fallbackPlan = buildTelegramPlainFallbackPlan({\n\t\t\t\thtml: richPlan.richMessage.html,\n\t\t\t\terr,\n\t\t\t\tcontext: \"sendRichMessage\",\n",
    "\t\t} catch (err) {\n"
      + "\t\t\tif (richLocalMediaForChunk.length > 0 && opts.richLocalMediaRetried !== true) {\n"
      + "\t\t\t\truntime.log?.(`[hotfix][telegram-rich-local-media] sendRichMessage with embedded media failed; retrying without media: ${formatErrorMessage(err)}`);\n"
      + "\t\t\t\treturn await sendTelegramText(bot, chatId, stripTelegramRichLocalMediaBlocks(text), runtime, { ...opts, richLocalMedia: void 0, richLocalMediaRetried: true });\n"
      + "\t\t\t}\n"
      + "\t\t\tconst fallbackPlan = buildTelegramPlainFallbackPlan({\n\t\t\t\thtml: richPlan.richMessage.html,\n\t\t\t\terr,\n\t\t\t\tcontext: \"sendRichMessage\",\n",
    "telegram delivery: sendTelegramText catch (retry without media)",
  );
  next = replaceOnce(
    next,
    "\t\t\t\tplainText: chunk.plainText,\n\t\t\t\trichMessages: params.richMessages,\n\t\t\t\tlinkPreview: params.linkPreview,\n\t\t\t\ttableMode: params.tableMode,\n\t\t\t\tsilent: params.silent,\n\t\t\t\treplyMarkup\n\t\t\t});\n\t\t\tif (firstDeliveredMessageId == null) firstDeliveredMessageId = messageId;\n",
    "\t\t\t\tplainText: chunk.plainText,\n\t\t\t\trichMessages: params.richMessages,\n\t\t\t\trichLocalMedia: params.richLocalMedia, // hotfix: telegram-rich-local-media\n\t\t\t\tlinkPreview: params.linkPreview,\n\t\t\t\ttableMode: params.tableMode,\n\t\t\t\tsilent: params.silent,\n\t\t\t\treplyMarkup\n\t\t\t});\n\t\t\tif (firstDeliveredMessageId == null) firstDeliveredMessageId = messageId;\n",
    "telegram delivery: deliverTextReply sendChunk opts",
  );
  const guestBranchAnchor = "\t\t\tif (mediaList.length === 0 || params.guestQueryId) firstDeliveredMessageId = await deliverTextReply({\n";
  const plainBranchAnchor = "\t\t\tif (mediaList.length === 0 && resolvedReplyText) firstDeliveredMessageId = await deliverTextReply({\n";
  const textBranchAnchor = next.includes(guestBranchAnchor) ? guestBranchAnchor : plainBranchAnchor; // guest-mode layer vs pristine 2026.7.1-2
  const embedBranch = "\t\t\t// hotfix: telegram-rich-local-media — локальные вложения и <img src=\"/path\"> уходят внутрь rich message\n"
    + "\t\t\tlet richLocalEmbed = null;\n"
    + "\t\t\tif (params.richMessages === true && !params.guestQueryId && (reply.text ?? \"\").trim() && (mediaList.some((url) => isTelegramLocalMediaSource(url)) || /<(?:img|video|audio)\\b[^>]*\\bsrc=\"(?:file:\\/\\/|\\/(?!\\/)|~\\/)/i.test(reply.text ?? \"\") || /!\\[[^\\]\\n]*\\]\\((?:file:\\/\\/|\\/(?!\\/)|~\\/)/.test(reply.text ?? \"\"))) {\n"
    + "\t\t\t\tconst resolvedRichLocal = await resolveTelegramRichLocalMedia(reply.text ?? \"\", {\n"
    + "\t\t\t\t\tmediaLoader,\n"
    + "\t\t\t\t\tmaxBytes: params.mediaMaxBytes,\n"
    + "\t\t\t\t\tmediaLocalRoots: params.mediaLocalRoots,\n"
    + "\t\t\t\t\textraMediaUrls: mediaList,\n"
    + "\t\t\t\t\tlog: (message) => params.runtime.log?.(message)\n"
    + "\t\t\t\t});\n"
    + "\t\t\t\tif (resolvedRichLocal.media.length > 0) richLocalEmbed = resolvedRichLocal;\n"
    + "\t\t\t}\n"
    + "\t\t\tif (richLocalEmbed) {\n"
    + "\t\t\t\tfirstDeliveredMessageId = await deliverTextReply({\n"
    + "\t\t\t\t\tbot: params.bot,\n"
    + "\t\t\t\t\tchatId: params.chatId,\n"
    + "\t\t\t\t\truntime: params.runtime,\n"
    + "\t\t\t\t\tthread: params.thread,\n"
    + "\t\t\t\t\tchunkText,\n"
    + "\t\t\t\t\treplyText: richLocalEmbed.text,\n"
    + "\t\t\t\t\trichLocalMedia: richLocalEmbed.media,\n"
    + "\t\t\t\t\treplyMarkup,\n"
    + "\t\t\t\t\treplyQuoteMessageId: replyQuote.messageId,\n"
    + "\t\t\t\t\treplyQuoteText: replyQuote.text,\n"
    + "\t\t\t\t\treplyQuotePosition: replyQuote.position,\n"
    + "\t\t\t\t\treplyQuoteEntities: replyQuote.entities,\n"
    + "\t\t\t\t\trichMessages: params.richMessages,\n"
    + "\t\t\t\t\ttableMode: params.tableMode,\n"
    + "\t\t\t\t\tlinkPreview: params.linkPreview,\n"
    + "\t\t\t\t\ttoken: params.token,\n"
    + "\t\t\t\t\tsilent: params.silent,\n"
    + "\t\t\t\t\treplyToId,\n"
    + "\t\t\t\t\treplyToMode: params.replyToMode,\n"
    + "\t\t\t\t\tguestQueryId: params.guestQueryId,\n"
    + "\t\t\t\t\tprogress\n"
    + "\t\t\t\t});\n"
    + "\t\t\t\tconst remainingRichLocalMedia = mediaList.filter((url) => !richLocalEmbed.consumedMediaUrls.includes(url));\n"
    + "\t\t\t\tif (remainingRichLocalMedia.length > 0) {\n"
    + "\t\t\t\t\tconst mediaDelivery = await deliverMediaReply({\n"
    + "\t\t\t\t\t\treply: { ...reply, text: \"\" },\n"
    + "\t\t\t\t\t\tmediaList: remainingRichLocalMedia,\n"
    + "\t\t\t\t\t\tbot: params.bot,\n"
    + "\t\t\t\t\t\tchatId: params.chatId,\n"
    + "\t\t\t\t\t\truntime: params.runtime,\n"
    + "\t\t\t\t\t\tthread: params.thread,\n"
    + "\t\t\t\t\t\ttableMode: params.tableMode,\n"
    + "\t\t\t\t\t\trichMessages: params.richMessages,\n"
    + "\t\t\t\t\t\tmediaLocalRoots: params.mediaLocalRoots,\n"
    + "\t\t\t\t\t\tmediaMaxBytes: params.mediaMaxBytes,\n"
    + "\t\t\t\t\t\tchunkText,\n"
    + "\t\t\t\t\t\tmediaLoader,\n"
    + "\t\t\t\t\t\tonVoiceRecording: params.onVoiceRecording,\n"
    + "\t\t\t\t\t\tlinkPreview: params.linkPreview,\n"
    + "\t\t\t\t\t\tsilent: params.silent,\n"
    + "\t\t\t\t\t\treplyQuoteMessageId: replyQuote.messageId,\n"
    + "\t\t\t\t\t\treplyQuoteText: replyQuote.text,\n"
    + "\t\t\t\t\t\treplyQuotePosition: replyQuote.position,\n"
    + "\t\t\t\t\t\treplyQuoteEntities: replyQuote.entities,\n"
    + "\t\t\t\t\t\treplyMarkup: void 0,\n"
    + "\t\t\t\t\t\treplyToId,\n"
    + "\t\t\t\t\t\treplyToMode: params.replyToMode,\n"
    + "\t\t\t\t\t\tprogress\n"
    + "\t\t\t\t\t});\n"
    + "\t\t\t\t\tif (firstDeliveredMessageId == null) firstDeliveredMessageId = mediaDelivery.firstDeliveredMessageId;\n"
    + "\t\t\t\t}\n"
    + "\t\t\t} else " + textBranchAnchor.trimStart();
  next = replaceOnce(next, textBranchAnchor, embedBranch, "telegram delivery: deliverReplies text/media branch");
  return next;
}
function patchTelegramOutboundAdapterRichLocalMedia(source) {
  if (source.includes("hotfix: telegram-rich-local-media")) return source;
  return replaceOnce(
    source,
    "\treturn await sendPayloadMediaSequenceOrFallback({\n\t\ttext,\n\t\tmediaUrls,\n\t\tfallbackResult: {\n\t\t\tmessageId: \"unknown\",\n\t\t\tchatId: params.to\n\t\t},\n",
    "\t// hotfix: telegram-rich-local-media — локальные вложения rich-аккаунта уходят внутрь rich message (send решает, что встраиваемо), остальное — прежней последовательностью\n"
      + "\tconst richLocalMediaCandidates = params.baseOpts.cfg && params.baseOpts.forceDocument !== true && text.trim() && mediaUrls.length > 0 && (process.env.OPENCLAW_TELEGRAM_RICH_LOCAL_MEDIA ?? \"1\").trim() !== \"0\" && mergeTelegramAccountConfig(params.baseOpts.cfg, params.baseOpts.accountId ?? resolveDefaultTelegramAccountId(params.baseOpts.cfg)).richMessages === true ? mediaUrls.filter((url) => /^(?:file:\\/\\/|\\/(?!\\/)|~\\/)/.test(url.trim())) : [];\n"
      + "\tif (richLocalMediaCandidates.length > 0) {\n"
      + "\t\tconst richTextResult = await params.send(params.to, text, {\n"
      + "\t\t\t...payloadOpts,\n"
      + "\t\t\tbuttons,\n"
      + "\t\t\trichLocalMediaUrls: richLocalMediaCandidates\n"
      + "\t\t});\n"
      + "\t\tconst remainingRichLocalMediaUrls = mediaUrls.filter((url) => !richLocalMediaCandidates.includes(url));\n"
      + "\t\tif (remainingRichLocalMediaUrls.length > 0) await sendPayloadMediaSequenceOrFallback({\n"
      + "\t\t\ttext: \"\",\n"
      + "\t\t\tmediaUrls: remainingRichLocalMediaUrls,\n"
      + "\t\t\tfallbackResult: richTextResult,\n"
      + "\t\t\tsendNoMedia: async () => richTextResult,\n"
      + "\t\t\tsend: async ({ text: textLocal, mediaUrl }) => await params.send(params.to, textLocal, {\n"
      + "\t\t\t\t...consumedImplicitReplyPayloadOpts,\n"
      + "\t\t\t\tmediaUrl\n"
      + "\t\t\t})\n"
      + "\t\t});\n"
      + "\t\treturn richTextResult;\n"
      + "\t}\n"
      + "\treturn await sendPayloadMediaSequenceOrFallback({\n\t\ttext,\n\t\tmediaUrls,\n\t\tfallbackResult: {\n\t\t\tmessageId: \"unknown\",\n\t\t\tchatId: params.to\n\t\t},\n",
    "telegram outbound adapter: payload media sequence",
  );
}

// ---- telegram-rich-local-media-prefer-payload (2026-08-25) ----
// Ядро доставки (src/infra/outbound/deliver.ts) отдаёт payload «текст + вложения» адаптеру через sendPayload только при
// presentation/interactive/channelData/audioAsVoice; обычный текст с mediaUrls режется на media-units и уходит по одному
// через sendMedia (sendPhoto с подписью) — врезка telegram-rich-local-media-adapter в sendTelegramPayloadMessages не
// задействуется (проверено 25.08 03:28: тест ушёл как MessageMediaPhoto). Патч добавляет opt-in capability адаптера
// preferPayloadForMedia({payload, cfg, accountId, forceDocument}) → boolean; Telegram-адаптер возвращает true для
// rich-аккаунта с текстом и локальными вложениями (без forceDocument), и ядро отдаёт такой payload через sendPayload.
function patchDeliverCorePreferPayloadForMedia(source) {
  if (source.includes("hotfix: telegram-rich-local-media-prefer-payload")) return source;
  let next = replaceOnce(
    source,
    "\t\tshouldSkipPlainTextSanitization: outbound?.shouldSkipPlainTextSanitization ? (payload) => outbound.shouldSkipPlainTextSanitization({ payload }) : void 0,\n",
    "\t\tshouldSkipPlainTextSanitization: outbound?.shouldSkipPlainTextSanitization ? (payload) => outbound.shouldSkipPlainTextSanitization({ payload }) : void 0,\n"
      + "\t\tpreferPayloadForMedia: outbound?.preferPayloadForMedia ? (payload, overrides) => outbound.preferPayloadForMedia({\n"
      + "\t\t\tpayload,\n"
      + "\t\t\tcfg: params.cfg,\n"
      + "\t\t\taccountId: params.accountId ?? void 0,\n"
      + "\t\t\tforceDocument: overrides?.forceDocument\n"
      + "\t\t}) === true : void 0, // hotfix: telegram-rich-local-media-prefer-payload\n",
    "deliver core: channel handler preferPayloadForMedia",
  );
  next = replaceOnce(
    next,
    "if (deliveryHandler.sendPayload && (effectivePayload.isError === true && deliveryHandler.sendTextOnlyErrorPayloads === true || hasReplyPayloadContent({",
    "if (deliveryHandler.sendPayload && (deliveryHandler.preferPayloadForMedia?.(effectivePayload, sendOverrides) === true || effectivePayload.isError === true && deliveryHandler.sendTextOnlyErrorPayloads === true || hasReplyPayloadContent({",
    "deliver core: sendPayload routing condition",
  );
  return next;
}
function patchTelegramOutboundAdapterPreferPayload(source) {
  if (source.includes("hotfix: telegram-rich-local-media-prefer-payload")) return source;
  return replaceOnce(
    source,
    "\t\tshouldSuppressLocalPayloadPrompt: options.shouldSuppressLocalPayloadPrompt,\n",
    "\t\t// hotfix: telegram-rich-local-media-prefer-payload — текст + локальные вложения rich-аккаунта ядро отдаёт через sendPayload (встраивание в rich message)\n"
      + "\t\tpreferPayloadForMedia: ({ payload, cfg, accountId, forceDocument }) => Boolean(cfg) && forceDocument !== true && (process.env.OPENCLAW_TELEGRAM_RICH_LOCAL_MEDIA ?? \"1\").trim() !== \"0\" && typeof payload?.text === \"string\" && payload.text.trim().length > 0 && resolvePayloadMediaUrls(payload).some((url) => /^(?:file:\\/\\/|\\/(?!\\/)|~\\/)/.test(url.trim())) && mergeTelegramAccountConfig(cfg, accountId ?? resolveDefaultTelegramAccountId(cfg)).richMessages === true,\n"
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
function patchTelegramOutboundAdapterRichChunkLimit(source) {
  if (source.includes("hotfix: telegram-rich-chunk-limit")) return source;
  return replaceOnce(
    source,
    "\t\tresolveEffectiveTextChunkLimit: ({ fallbackLimit }) => typeof fallbackLimit === \"number\" ? Math.min(fallbackLimit, 4096) : 4096,\n",
    "\t\t// hotfix: telegram-rich-chunk-limit — rich-аккаунты не режутся ядром по 4096: HTML-aware разбиение делает send bundle (лимит rich message 32768)\n"
      + "\t\tresolveEffectiveTextChunkLimit: ({ cfg, accountId, fallbackLimit }) => cfg && mergeTelegramAccountConfig(cfg, accountId ?? resolveDefaultTelegramAccountId(cfg)).richMessages === true ? (typeof fallbackLimit === \"number\" && fallbackLimit > 4096 ? Math.min(fallbackLimit, 32768) : 32768) : typeof fallbackLimit === \"number\" ? Math.min(fallbackLimit, 4096) : 4096,\n",
    "telegram outbound adapter: resolveEffectiveTextChunkLimit",
  );
}

function main() {
  if (!fs.existsSync(distDir)) throw new Error(`dist directory does not exist: ${distDir}`);
  const installedVersion = JSON.parse(read(path.join(packageRoot, "package.json"))).version;
  if (installedVersion !== expectedPackageVersion) throw new Error(`installed openclaw ${installedVersion ?? "unknown"} does not match the supported version ${expectedPackageVersion}`);
  const files = walkJs(distDir);
  const failures = [];
  const locateTarget = (key, locate) => {
    try {
      return locate();
    } catch (err) {
      if (!reportAll) throw err;
      failures.push({ id: `target:${key}`, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  };
  const runApply = (target, label, patchFn) => {
    if (!target) return { label, file: null, changed: false };
    try {
      return applyFile(target, label, patchFn);
    } catch (err) {
      if (!reportAll) throw err;
      failures.push({ id: label, error: err instanceof Error ? err.message : String(err) });
      return { label, file: target, changed: false };
    }
  };
  const targets = {
    deliverHandler: locateTarget("deliverHandler", () => findOne(files, "channel deliver handler bundle", ["function normalizePayloadsForChannelDelivery(plan, handler)", "shouldSkipPlainTextSanitization: outbound?.shouldSkipPlainTextSanitization"])),
    telegramOutboundAdapter: locateTarget("telegramOutboundAdapter", () => findOne(files, "Telegram outbound adapter bundle", ["function createTelegramOutboundAdapter(options = {}) {", "extractMarkdownImages: true,"])),
    telegramAccountConfig: locateTarget("telegramAccountConfig", () => findOne(files, "Telegram account-config bundle", ["function mergeTelegramAccountConfig(cfg, accountId) {", "export { resolveTelegramAccountConfig as n, mergeTelegramAccountConfig as t };"])),
    telegramAccountSelection: locateTarget("telegramAccountSelection", () => findOne(files, "Telegram account-selection bundle", ["function resolveDefaultTelegramAccountSelection(", "export { resolveDefaultTelegramAccountId as n, resolveDefaultTelegramAccountSelection as r, listTelegramAccountIds as t };"])),
    telegramSentCache: locateTarget("telegramSentCache", () => findOne(files, "Telegram sent-message cache bundle", ["function shouldUseTelegramDmThreadSession", "function buildTelegramThreadParams", "const TELEGRAM_RICH_MEDIA_BLOCK_PATTERN = "])),
    telegramSend: locateTarget("telegramSend", () => findOne(files, "Telegram send bundle", ["async function sendMessageTelegram(to, text, opts) {", "function getTelegramRichRawApi(api) {", "const InputFileCtor = grammy.InputFile;"])),
    delivery: locateTarget("delivery", () => findOne(files, "Telegram delivery bundle", ["async function sendTelegramText", "async function deliverTextReply", "deliverMediaReply"])),
  };
  const results = [
    runApply(targets.deliverHandler, "telegram-rich-keep-html-media-deliver", patchDeliverSanitizeTextContext),
    runApply(targets.telegramOutboundAdapter, "telegram-rich-keep-html-media", makePatchTelegramRichKeepHtmlMedia(targets)),
    runApply(targets.telegramSentCache, "telegram-rich-local-media-patterns", patchTelegramSentCacheRichLocalMediaPatterns),
    runApply(targets.telegramSend, "telegram-rich-local-media-send", patchTelegramSendRichLocalMedia),
    runApply(targets.delivery, "telegram-rich-local-media-delivery", patchTelegramDeliveryRichLocalMedia),
    runApply(targets.telegramOutboundAdapter, "telegram-rich-local-media-adapter", patchTelegramOutboundAdapterRichLocalMedia),
    runApply(targets.deliverHandler, "telegram-rich-local-media-core", patchDeliverCorePreferPayloadForMedia),
    runApply(targets.telegramOutboundAdapter, "telegram-rich-local-media-prefer-payload", patchTelegramOutboundAdapterPreferPayload),
    runApply(targets.telegramOutboundAdapter, "telegram-rich-chunk-limit", patchTelegramOutboundAdapterRichChunkLimit),
  ];
  const changed = results.filter((result) => result.changed).length;
  console.log(`[telegram-rich-media-hotfix] complete changed=${changed} packageRoot=${packageRoot}`);
  if (failures.length > 0) {
    console.log(JSON.stringify({ reportAll: true, failures }));
    process.exitCode = 1;
  }
}

try {
  main();
} catch (err) {
  console.error(`[telegram-rich-media-hotfix] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
