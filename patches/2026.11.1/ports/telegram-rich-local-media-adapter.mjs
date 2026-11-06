// OpenClaw 2026.11.1: telegram-rich-local-media-adapter.
import { replaceOnce, contains } from "../helpers.mjs";
export const label = "telegram-rich-local-media-adapter";
export const verdict = "port";
export const target = { key: "telegramOutboundAdapter", label: "Telegram outbound adapter bundle", needles: ["function createTelegramOutboundAdapter(options = {}) {", "extractMarkdownImages: true,"] };
const MARKER = "\t// hotfix: telegram-rich-local-media\n\tconst richLocalMediaCandidates = ";
const ANCHOR = "\treturn await params.send(params.to, text, {\n\t\t...payloadOpts,\n\t\t...projectionOptions,\n\t\t...mediaUrls.length === 1 ? { mediaUrl: mediaUrls[0] } : mediaUrls.length > 1 ? { mediaUrls } : {},\n\t\tbuttons\n\t});\n";
const PROJECTION_DECL = "\tconst projectionOptions = projectionCursor ? { promptContextProjectionPlan: {\n\t\tcursor: projectionCursor,\n\t\tfinalPart: true\n\t} } : {};\n";
const RICH_IMPORT_RE = /^import \{[^\n]*\bas resolveTelegramRichMessages\b[^\n]*\} from "\.\/text-chunk-limit-[A-Za-z0-9_-]+\.mjs";$/m;
export function patch(source) {
  if (source.includes(MARKER)) return source;
  if (!RICH_IMPORT_RE.test(source)) throw new Error("missing telegram outbound adapter: resolveTelegramRichMessages import");
  if (!source.includes(PROJECTION_DECL)) throw new Error("missing telegram outbound adapter: projectionOptions/projectionCursor layout");
  const addition = `\t// hotfix: telegram-rich-local-media
\tconst richLocalMediaCandidates = params.baseOpts.cfg && params.baseOpts.forceDocument !== true && text.trim() && mediaUrls.length > 0 && payload.audioAsVoice !== true && payload.videoAsNote !== true && (process.env.OPENCLAW_TELEGRAM_RICH_LOCAL_MEDIA ?? "1").trim() !== "0" && resolveTelegramRichMessages({
\t\tcfg: params.baseOpts.cfg,
\t\taccountId: params.baseOpts.accountId,
\t\thtmlTextMode: params.baseOpts.textMode === "html"
\t}) ? mediaUrls.filter((url) => /^(?:file:\\/\\/|\\/(?!\\/)|~\\/)/.test(url.trim())) : [];
\tif (richLocalMediaCandidates.length > 0) {
\t\tconst remainingRichLocalMediaUrls = mediaUrls.filter((url) => !richLocalMediaCandidates.includes(url));
\t\tconst richLocalProjectionOptions = (finalPart) => projectionCursor ? { promptContextProjectionPlan: {
\t\t\tcursor: projectionCursor,
\t\t\tfinalPart
\t\t} } : {};
\t\tconst richTextResult = await params.send(params.to, text, {
\t\t\t...payloadOpts,
\t\t\t...richLocalProjectionOptions(remainingRichLocalMediaUrls.length === 0),
\t\t\tbuttons,
\t\t\trichLocalMediaUrls: richLocalMediaCandidates
\t\t});
\t\tif (remainingRichLocalMediaUrls.length > 0) await params.send(params.to, "", {
\t\t\t...payloadOpts,
\t\t\t...payloadOpts.replyToIdSource === "implicit" && (payloadOpts.replyToMode === "first" || payloadOpts.replyToMode === "batched") ? { replyToMessageId: void 0, quoteText: void 0 } : {},
\t\t\t...richLocalProjectionOptions(true),
\t\t\tmediaUrls: remainingRichLocalMediaUrls
\t\t});
\t\treturn richTextResult;
\t}
`;
  return replaceOnce(source, ANCHOR, addition + ANCHOR, "telegram outbound adapter rich local media branch");
}
export const check = { gate: "required", assertions: [
  contains("const richLocalMediaCandidates = params.baseOpts.cfg && params.baseOpts.forceDocument !== true && text.trim() && mediaUrls.length > 0", "adapter partitions local media with forceDocument respected"),
  contains("richLocalMediaUrls: richLocalMediaCandidates", "adapter passes local media to sender"),
  contains("mediaUrls: remainingRichLocalMediaUrls", "unconsumed media retains upstream grouped sender"),
  contains("...richLocalProjectionOptions(remainingRichLocalMediaUrls.length === 0)", "final projection is owned by the last send"),
  contains("htmlTextMode: params.baseOpts.textMode === \"html\"", "rich check excludes html text mode"),
  // сторож ReferenceError: всё, на что ссылается ветка, объявлено в чанке
  (src) => RICH_IMPORT_RE.test(src) ? null : "resolveTelegramRichMessages is not imported from text-chunk-limit (ReferenceError in rich local media branch)",
  (src) => src.includes("\tconst projectionCursor = promptContextSource ? createTelegramPromptContextProjectionCursor(promptContextSource) : void 0;\n") ? null : "projectionCursor declaration changed — re-check rich local media projection",
  (src) => src.includes("\tconst mediaUrls = resolveSendableOutboundReplyParts(payload).mediaUrls;\n") ? null : "mediaUrls derivation in sendTelegramPayloadMessages changed",
  // ветка стоит перед единственным финальным send апстрима (иначе rich local media обходится)
  (src) => { const i = src.indexOf(MARKER); const j = src.indexOf(ANCHOR); return i !== -1 && j !== -1 && i < j && src.indexOf(ANCHOR, j + 1) === -1 ? null : "rich local media branch is not right before the single upstream final send"; },
] };
