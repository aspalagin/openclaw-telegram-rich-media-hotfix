#!/usr/bin/env node
// Checker: verifies that the Telegram rich media hotfix is present in an installed OpenClaw 2026.7.1-2 package.
// Usage: node scripts/check.mjs   (OPENCLAW_PACKAGE_ROOT=/usr/lib/node_modules/openclaw); exit code 1 when a required check fails.
import fs from "node:fs";
import path from "node:path";

const packageRoot = process.env.OPENCLAW_PACKAGE_ROOT || "/usr/lib/node_modules/openclaw";
const distDir = path.join(packageRoot, "dist");
const expectedVersion = "2026.7.1-2";

function readText(file) {
  return fs.readFileSync(file, "utf8");
}
function rel(file) {
  return path.relative(packageRoot, file);
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
function findOneJs(files, label, needles) {
  const matches = [];
  for (const file of files) {
    const content = readText(file);
    if (needles.every((needle) => content.includes(needle))) matches.push({ file, content });
  }
  if (matches.length === 0) throw new Error(`could not locate ${label}`);
  if (matches.length > 1) throw new Error(`located multiple ${label}: ${matches.map((match) => rel(match.file)).join(", ")}`);
  return matches[0];
}
function contains(needle, detail = needle) {
  return (content) => content.includes(needle) ? null : `missing ${detail}`;
}

const checks = [
  {
    id: "telegram-rich-chunk-limit",
    gate: "required",
    locate: (files) => findOneJs(files, "Telegram outbound adapter bundle", [
      "function createTelegramOutboundAdapter(options = {}) {",
      "extractMarkdownImages: true,",
    ]),
    assertions: [
      contains("hotfix: telegram-rich-chunk-limit", "rich chunk limit marker"),
      contains("resolveEffectiveTextChunkLimit: ({ cfg, accountId, fallbackLimit }) => cfg && mergeTelegramAccountConfig(", "rich accounts get the 32768 chunk limit"),
    ],
  },
  {
    id: "telegram-rich-local-media-core",
    gate: "required",
    locate: (files) => findOneJs(files, "channel deliver handler bundle", [
      "function normalizePayloadsForChannelDelivery(plan, handler)",
      "shouldSkipPlainTextSanitization: outbound?.shouldSkipPlainTextSanitization",
    ]),
    assertions: [
      contains("hotfix: telegram-rich-local-media-prefer-payload", "deliver core prefer-payload marker"),
      contains("deliveryHandler.preferPayloadForMedia?.(effectivePayload, sendOverrides) === true ||", "sendPayload routing honours preferPayloadForMedia"),
    ],
  },
  {
    id: "telegram-rich-local-media-prefer-payload",
    gate: "required",
    locate: (files) => findOneJs(files, "Telegram outbound adapter bundle", [
      "function createTelegramOutboundAdapter(options = {}) {",
      "extractMarkdownImages: true,",
    ]),
    assertions: [
      contains("preferPayloadForMedia: ({ payload, cfg, accountId, forceDocument }) =>", "adapter preferPayloadForMedia capability"),
      contains("resolvePayloadMediaUrls(payload).some((url) =>", "adapter checks local media urls"),
    ],
  },
  {
    id: "telegram-rich-local-media-patterns",
    gate: "required",
    locate: (files) => findOneJs(files, "Telegram sent-message cache bundle", [
      "function shouldUseTelegramDmThreadSession",
      "function buildTelegramThreadParams",
      "const TELEGRAM_RICH_MEDIA_BLOCK_PATTERN = ",
    ]),
    assertions: [
      contains("hotfix: telegram-rich-local-media", "rich local media patterns marker"),
      contains('<img\\b[^>]*\\bsrc="(?:https?:\\/\\/[^"]+|tg:\\/\\/(?:photo|video|audio|document)\\?id=[A-Za-z0-9_-]{1,64})"', "tg:// source accepted in rich media block pattern"),
      contains('["img", /^(?=.*\\ssrc="(?:https?:\\/\\/[^"]+|tg:\\/\\/(?:photo|video|audio|document)\\?id=[A-Za-z0-9_-]{1,64})")', "tg:// source accepted in img attr pattern"),
    ],
  },
  {
    id: "telegram-rich-local-media-send",
    gate: "required",
    locate: (files) => findOneJs(files, "Telegram send bundle", [
      "async function sendMessageTelegram(to, text, opts) {",
      "function getTelegramRichRawApi(api) {",
      "const InputFileCtor = grammy.InputFile;",
    ]),
    assertions: [
      contains("async function resolveTelegramRichLocalMedia(text, options = {})", "rich local media resolver helper"),
      contains("rich_message: buildTelegramRichLocalMediaMessage(chunk, options.richLocalMedia)", "rich_message carries embedded media"),
      contains("retrying without media", "retry-without-media fallback"),
      contains("const richLocal = useRichMessages && opts.forceDocument !== true ? await resolveTelegramRichLocalMedia(text, {", "text send resolves local media (forceDocument respected)"),
      contains("export { resolveTelegramRichLocalMedia as Rl, stripTelegramRichLocalMediaBlocks as Rs, isTelegramLocalMediaSource as Rc, isTelegramRichLocalMediaEnabled as Re,", "helper exports"),
    ],
  },
  {
    id: "telegram-rich-local-media-delivery",
    gate: "required",
    locate: (files) => findOneJs(files, "Telegram delivery bundle", [
      "async function sendTelegramText",
      "async function deliverTextReply",
      "deliverMediaReply",
    ]),
    assertions: [
      contains("Rl as resolveTelegramRichLocalMedia, Rs as stripTelegramRichLocalMediaBlocks, Rc as isTelegramLocalMediaSource,", "delivery imports helper"),
      contains("const richLocalMediaForChunk = Array.isArray(opts.richLocalMedia)", "sendTelegramText filters media per chunk"),
      contains("rich_message: richLocalMediaForChunk.length > 0 ? { ...richPlan.richMessage, media: richLocalMediaForChunk.map((entry) => entry.media) } : richPlan.richMessage,", "sendTelegramText rich_message media"),
      contains("richLocalMedia: params.richLocalMedia, // hotfix: telegram-rich-local-media", "deliverTextReply passes media"),
      contains("if (richLocalEmbed) {", "deliverReplies embed branch"),
    ],
  },
  {
    id: "telegram-rich-local-media-adapter",
    gate: "required",
    locate: (files) => findOneJs(files, "Telegram outbound adapter bundle", [
      "function createTelegramOutboundAdapter(options = {}) {",
      "extractMarkdownImages: true,",
    ]),
    assertions: [
      contains("const richLocalMediaCandidates = params.baseOpts.cfg && params.baseOpts.forceDocument !== true && text.trim() && mediaUrls.length > 0", "adapter partitions local media (forceDocument respected)"),
      contains("richLocalMediaUrls: richLocalMediaCandidates", "adapter passes local media to send"),
    ],
  },
  {
    id: "telegram-rich-keep-html-media-deliver",
    gate: "required",
    locate: (files) => findOneJs(files, "channel deliver handler bundle", [
      "function normalizePayloadsForChannelDelivery(plan, handler)",
      "shouldSkipPlainTextSanitization: outbound?.shouldSkipPlainTextSanitization",
    ]),
    assertions: [
      contains("hotfix: telegram-rich-keep-html-media", "deliver sanitizeText context marker"),
      contains("\t\t\tpayload,\n\t\t\tcfg: params.cfg,\n\t\t\taccountId: params.accountId\n\t\t}) : void 0,", "cfg/accountId passed into outbound.sanitizeText"),
    ],
  },
  {
    id: "telegram-rich-keep-html-media",
    gate: "required",
    locate: (files) => findOneJs(files, "Telegram outbound adapter bundle", [
      "function createTelegramOutboundAdapter(options = {}) {",
      "extractMarkdownImages: true,",
    ]),
    assertions: [
      contains("hotfix: telegram-rich-keep-html-media", "Telegram rich sanitize marker"),
      contains("as mergeTelegramAccountConfig } from \"./account-config-", "account-config import"),
      contains("as resolveDefaultTelegramAccountId } from \"./account-selection-", "account-selection import"),
      contains(".richMessages === true ? sanitizeAssistantVisibleText(text) : sanitizeForPlainText(sanitizeAssistantVisibleText(text)),", "conditional plain-text sanitize for rich accounts"),
    ],
  },
];

function runCheck(files, check) {
  try {
    const located = check.locate(files);
    const failures = check.assertions.map((assertion) => assertion(located.content)).filter(Boolean);
    return { id: check.id, gate: check.gate, file: located.file, ok: failures.length === 0, failures };
  } catch (err) {
    return { id: check.id, gate: check.gate, file: null, ok: false, failures: [err instanceof Error ? err.message : String(err)] };
  }
}

function main() {
  if (!fs.existsSync(distDir)) throw new Error(`dist directory does not exist: ${distDir}`);
  const pkg = JSON.parse(readText(path.join(packageRoot, "package.json")));
  if (pkg.version !== expectedVersion) console.log(`[telegram-rich-media-hotfix-check] warn: installed ${pkg.version} differs from supported ${expectedVersion}`);
  const files = walkJs(distDir);
  const results = checks.map((check) => runCheck(files, check));
  for (const result of results) {
    console.log(`[${result.ok ? "ok" : "FAIL"}] ${result.id}${result.file ? ` ${rel(result.file)}` : ""}${result.failures.length ? `: ${result.failures.join("; ")}` : ""}`);
  }
  const failed = results.filter((result) => !result.ok);
  console.log(`[telegram-rich-media-hotfix-check] summary ok=${results.length - failed.length} failed=${failed.length}`);
  if (failed.length > 0) process.exitCode = 1;
}

try {
  main();
} catch (err) {
  console.error(`[telegram-rich-media-hotfix-check] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
