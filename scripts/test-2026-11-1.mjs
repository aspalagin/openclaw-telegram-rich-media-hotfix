#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { assert, vm, sourceFor, regionSource } from "./test-support-2026-11-1.mjs";

const source = sourceFor("telegram-rich-local-media-send");
const calls = [];
const logs = [];
class InputFile { constructor(buffer, filename) { this.buffer = buffer; this.filename = filename; } }
const env = {};
const context = vm.createContext({
  hotfixTelegramRichMediaRandomUUID: randomUUID,
  InputFile, process: { env }, Buffer,
  buildOutboundMediaLoadOptions: (options) => options,
  loadWebMedia: async () => { throw new Error("unexpected real media loader"); },
  getImageMetadata: async () => ({ width: 100, height: 100 }),
  kindFromMime: (mime) => ({ image: "image", video: "video", audio: "audio" })[mime?.split("/")[0]],
  isGifMedia: ({ contentType }) => contentType === "image/gif",
  extensionForMime: (mime) => ({ "image/png": ".png", "video/mp4": ".mp4", "audio/ogg": ".ogg" })[mime],
  MAX_TELEGRAM_PHOTO_DIMENSION_SUM: 10000, MAX_TELEGRAM_PHOTO_ASPECT_RATIO: 20,
  sendLogger: { warn: (message) => logs.push(message) },
  logVerbose: (message) => logs.push(message),
  formatErrorMessage: (error) => error.message,
});
vm.runInContext(regionSource(source, "hotfix: telegram-rich-local-media"), context);
const mediaLoader = async (url, options) => {
  calls.push({ url, options });
  if (url.endsWith("denied.png")) throw new Error("Local media path is not under an allowed directory");
  const contentType = url.endsWith(".gif") ? "image/gif" : url.endsWith(".pdf") ? "application/pdf" : url.endsWith(".mp4") ? "video/mp4" : "image/png";
  return { buffer: Buffer.alloc(url.endsWith("big.png") ? 11 * 1024 * 1024 : 16), contentType };
};
const options = { mediaLoader, mediaLocalRoots: ["/allowed"], mediaAccess: { allowed: true }, maxBytes: 123456 };
const resolve = (text, extra = {}) => context.resolveTelegramRichLocalMedia(text, { ...options, ...extra });
const clone = (value) => JSON.parse(JSON.stringify(value));
const before = calls.length;
const resolved = await resolve('<figure><img src="/allowed/a.png"/></figure><img src="https://example.invalid/remote.png">');
assert.equal(resolved.media.length, 1);
assert.match(resolved.text, /tg:\/\/photo\?id=ocm[0-9a-f-]{36}/);
assert.ok(resolved.text.includes("https://example.invalid/remote.png"));
assert.equal(calls.length, before + 1, "remote URLs must not enter local loader");
assert.equal(calls.at(-1).options.mediaAccess, options.mediaAccess);
assert.deepEqual(clone(calls.at(-1).options.mediaLocalRoots), options.mediaLocalRoots);
assert.equal(calls.at(-1).options.maxBytes, 123456);
assert.equal(resolved.media[0].media.media.media.filename, "image.png");

const makeMessage = (id) => ({ blocks: [
  { type: "text", text: "visible text" },
  { type: "photo", photo: { media: "tg://photo?id=" + id } },
] });
const forged = makeMessage("ocm1");
assert.equal(context.attachTelegramRichLocalMedia(forged).richMessage.blocks[1].photo.media, "tg://photo?id=ocm1", "guessing another pending attachment must not resolve it");
const message = makeMessage(resolved.ids[0]);
const attached = context.attachTelegramRichLocalMedia(message);
assert.ok(attached.richMessage.blocks[1].photo.media instanceof InputFile);
assert.equal(typeof message.blocks[1].photo.media, "string", "attachment must not mutate the planned page");
assert.equal(context.stripTelegramRichLocalMediaFromBlocks(message).blocks.length, 1);
context.releaseTelegramRichLocalMedia(resolved.ids);
assert.equal(typeof context.attachTelegramRichLocalMedia(message).richMessage.blocks[1].photo.media, "string");

const markdown = await resolve('![caption](/allowed/b.png "A & B")');
assert.match(markdown.text, /<figcaption>A &amp; B<\/figcaption>/);
context.releaseTelegramRichLocalMedia(markdown.ids);
const extras = await resolve("text", { extraMediaUrls: ["/allowed/c.png", "/allowed/document.pdf", "/allowed/animation.gif"] });
assert.deepEqual(clone(extras.consumedMediaUrls), ["/allowed/c.png"]);
context.releaseTelegramRichLocalMedia(extras.ids);
assert.equal((await resolve('<img src="/allowed/denied.png">')).media.length, 0);
assert.ok(logs.some((line) => line.includes("not under an allowed directory")));
assert.equal((await resolve('<img src="/allowed/big.png">')).media.length, 0);
const callsBeforeDisabled = calls.length;
env.OPENCLAW_TELEGRAM_RICH_LOCAL_MEDIA = "0";
const disabled = await resolve('<img src="/allowed/a.png">', { extraMediaUrls: ["/allowed/b.png"] });
assert.equal(disabled.text, '<img src="/allowed/a.png">');
assert.equal(disabled.media.length, 0);
assert.equal(calls.length, callsBeforeDisabled);
delete env.OPENCLAW_TELEGRAM_RICH_LOCAL_MEDIA;

// Execute the actual prepared sender callback with a mocked Telegram transport.
// When checking a composed installation, keep the real guest file-id hook too.
if (source.includes("//#region hotfix: telegram-sent-media-file-ids")) {
  vm.runInContext(regionSource(source, "hotfix: telegram-sent-media-file-ids"), context);
}
const callback = source.match(/sendRich: async \(richMessage\) => \{([^]*?)^\t{5}}/m);
assert.ok(callback);
const sent = [];
let failFirst = true;
context.prepared = { requestParams: () => ({ message_thread_id: 77, reply_markup: { inline_keyboard: [] } }) };
context.toTelegramRichMessageContextParams = (value) => value;
context.request = async (_method, params, send) => send(params);
context.config = { chatId: 10, warn: (message) => logs.push(message), api: { raw: {
  sendRichMessage: async (payload) => {
    sent.push(payload);
    if (failFirst) { failFirst = false; throw new Error("synthetic Telegram rejection"); }
    return { acceptedParams: {}, message_id: 1 };
  },
} } };
vm.runInContext("var sendRich = async (richMessage) => {" + callback[1] + "\n};", context);
const retryMedia = await resolve('<img src="/allowed/retry.png">');
await context.sendRich(makeMessage(retryMedia.ids[0]));
assert.equal(sent.length, 2);
assert.ok(sent[0].rich_message.blocks[1].photo.media instanceof InputFile);
assert.equal(sent[1].rich_message.blocks.length, 1);
assert.equal(sent[1].message_thread_id, 77);
assert.ok(sent[1].reply_markup);
assert.equal(typeof context.attachTelegramRichLocalMedia(makeMessage(retryMedia.ids[0])).richMessage.blocks[1].photo.media, "string", "registry released after retry");
const onlyMedia = await resolve('<img src="/allowed/only.png">');
failFirst = true;
const beforeFailure = sent.length;
await assert.rejects(context.sendRich({ blocks: [makeMessage(onlyMedia.ids[0]).blocks[1]] }), /synthetic Telegram rejection/);
assert.equal(sent.length, beforeFailure + 1, "do not retry with an empty rich message");

// Payload routing preserves forceDocument, non-rich and remote-only delivery.
const adapter = sourceFor("telegram-rich-local-media-prefer-payload");
const capability = adapter.match(/preferPayloadForMedia: (\(\{ payload, cfg, accountId, forceDocument \}\) =>[^]*?\n\t\t\}\)),/);
assert.ok(capability);
context.resolveSendableOutboundReplyParts = (payload) => ({ mediaUrls: payload.mediaUrls ?? [] });
context.resolveTelegramRichMessages = ({ cfg }) => cfg.rich === true;
vm.runInContext("var preferPayload = " + capability[1] + ";", context);
const payload = { text: "hello", mediaUrls: ["/allowed/a.png"] };
assert.equal(context.preferPayload({ payload, cfg: { rich: true } }), true);
assert.equal(context.preferPayload({ payload, cfg: { rich: true }, forceDocument: true }), false);
assert.equal(context.preferPayload({ payload, cfg: { rich: false } }), false);
assert.equal(context.preferPayload({ payload: { ...payload, mediaUrls: ["https://example.invalid/a.png"] }, cfg: { rich: true } }), false);
console.log("PASS: local HTML/Markdown/files, allowed roots, unsupported media, kill switch, block attachments, retry/release, forceDocument routing");
