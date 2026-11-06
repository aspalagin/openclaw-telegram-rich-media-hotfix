// OpenClaw 2026.11.1: telegram-rich-local-media-send.
import { replaceOnce, contains } from "../helpers.mjs";
export const label = "telegram-rich-local-media-send";
export const verdict = "rewrite";
export const target = { key: "telegramSend", label: "Telegram send bundle", needles: ["async function sendMessageTelegram(to, text, opts) {", "function createTelegramPreparedSender(config) {", "sendRich: async (richMessage) => {"] };
const HELPER = `//#region hotfix: telegram-rich-local-media (2026-08-25; порт на block-модель 2026-09-04)
// Локальные файлы внутри Telegram rich message: <img|video|audio src="/abs/path|file://|~/">, markdown ![alt](/abs/path "caption")
// и вложения (MEDIA:/mediaUrls) загружаются как InputMedia* (multipart attach://) и заменяются на ссылки tg://photo|video|audio?id=<id>.
// Парсер rich-блоков пропускает tg://-src (MEDIA_SRC_RE, метка -patterns); prepared sender подставляет InputFile в блоки перед sendRichMessage.
// Kill-switch: OPENCLAW_TELEGRAM_RICH_LOCAL_MEDIA=0.
const TELEGRAM_RICH_LOCAL_MEDIA_ENV = "OPENCLAW_TELEGRAM_RICH_LOCAL_MEDIA";
const TELEGRAM_RICH_LOCAL_MEDIA_MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const TELEGRAM_RICH_LOCAL_MEDIA_REGISTRY_TTL_MS = 15 * 60 * 1e3;
const TELEGRAM_RICH_LOCAL_MEDIA_SOURCE_PATTERN = /^(?:file:\\/\\/|\\/(?!\\/)|~\\/)/;
const TELEGRAM_RICH_LOCAL_MEDIA_TAG_PATTERN = /<(img|video|audio)\\b([^>]*?)\\bsrc="([^"]+)"([^>]*)>/gi;
const TELEGRAM_RICH_LOCAL_MEDIA_MARKDOWN_PATTERN = /!\\[([^\\]\\n]*)\\]\\(((?:file:\\/\\/|\\/(?!\\/)|~\\/)[^\\s)"]+)(?:\\s+"([^"\\n]*)")?\\)/g;
const TELEGRAM_RICH_LOCAL_MEDIA_LINK_PATTERN = /^tg:\\/\\/(?:photo|video|audio|document)\\?id=([A-Za-z0-9_-]{1,64})$/i;
const TELEGRAM_RICH_LOCAL_MEDIA_REGISTRY = new Map();
const TELEGRAM_RICH_LOCAL_MEDIA_REMOVED = Symbol("telegram-rich-local-media-removed");
let telegramRichLocalMediaCounter = 0;
// 10.5: локальная копия 9.7-хелпера имени файла из outbound-media.ts (апстрим удалил его, имя теперь inline в prepareTelegramOutboundMedia)
function hotfixTelegramRichLocalMediaFileName(params) {
	if (params.fileName) return params.fileName;
	if (params.isGif) return "animation.gif";
	const basename = params.kind === "image" || params.kind === "video" || params.kind === "audio" ? params.kind : "file";
	const defaultExtension = params.kind === "image" ? ".jpg" : params.kind === "video" ? ".mp4" : params.kind === "audio" ? ".ogg" : ".bin";
	return \`\${basename}\${extensionForMime(params.contentType) ?? defaultExtension}\`;
}
function isTelegramRichLocalMediaEnabled() {
	return (process.env[TELEGRAM_RICH_LOCAL_MEDIA_ENV] ?? "1").trim() !== "0";
}
function isTelegramLocalMediaSource(value) {
	return typeof value === "string" && TELEGRAM_RICH_LOCAL_MEDIA_SOURCE_PATTERN.test(value.trim());
}
function escapeTelegramRichLocalMediaText(value) {
	return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function telegramRichLocalMediaTypeForTag(tag) {
	const name = String(tag).toLowerCase();
	return name === "img" ? "photo" : name === "video" ? "video" : name === "audio" ? "audio" : null;
}
function buildTelegramRichLocalMediaBlock(entry, options = {}) {
	const src = \`tg://\${entry.type}?id=\${entry.id}\`;
	const caption = options.caption ? \`<figcaption>\${escapeTelegramRichLocalMediaText(options.caption)}</figcaption>\` : "";
	const alt = options.alt ? \` alt="\${escapeTelegramRichLocalMediaText(options.alt)}"\` : "";
	const inner = entry.type === "photo" ? \`<img src="\${src}"\${alt}/>\` : entry.type === "video" ? \`<video src="\${src}"></video>\` : \`<audio src="\${src}"></audio>\`;
	return \`<figure>\${inner}\${caption}</figure>\`;
}
function removeEmptyTelegramRichMediaContainers(html) {
	return html.replace(/<figure\\b[^>]*>(?:\\s|<figcaption\\b[^>]*>[\\s\\S]*?<\\/figcaption>)*<\\/figure>/gi, "").replace(/<(tg-slideshow|tg-collage)\\b[^>]*>([\\s\\S]*?)<\\/\\1>/gi, (match, _tag, inner) => /<(?:img|video)\\b/i.test(inner) ? match : "");
}
function stripTelegramRichLocalMediaBlocks(html) {
	const next = String(html ?? "").replace(/<img\\b[^>]*\\bsrc="tg:\\/\\/[^"]*"[^>]*\\/?>/gi, "").replace(/<video\\b[^>]*\\bsrc="tg:\\/\\/[^"]*"[^>]*(?:\\/>|>[\\s\\S]*?<\\/video>)/gi, "").replace(/<audio\\b[^>]*\\bsrc="tg:\\/\\/[^"]*"[^>]*(?:\\/>|>[\\s\\S]*?<\\/audio>)/gi, "");
	return removeEmptyTelegramRichMediaContainers(next).replace(/\\n{3,}/g, "\\n\\n").trim();
}
function telegramRichLocalMediaIdFromSource(value) {
	if (typeof value !== "string") return null;
	const match = TELEGRAM_RICH_LOCAL_MEDIA_LINK_PATTERN.exec(value.trim());
	return match ? match[1] : null;
}
function registerTelegramRichLocalMedia(type, file) {
	const now = Date.now();
	for (const [staleId, stale] of TELEGRAM_RICH_LOCAL_MEDIA_REGISTRY) if (now - stale.createdAt > TELEGRAM_RICH_LOCAL_MEDIA_REGISTRY_TTL_MS) TELEGRAM_RICH_LOCAL_MEDIA_REGISTRY.delete(staleId);
	telegramRichLocalMediaCounter += 1;
	const id = \`ocm\${telegramRichLocalMediaCounter}\`;
	const media = {
		type,
		media: file
	};
	TELEGRAM_RICH_LOCAL_MEDIA_REGISTRY.set(id, {
		media,
		createdAt: now
	});
	return {
		id,
		type,
		media: {
			id,
			media
		}
	};
}
function releaseTelegramRichLocalMedia(ids) {
	for (const id of Array.isArray(ids) ? ids : []) TELEGRAM_RICH_LOCAL_MEDIA_REGISTRY.delete(id);
}
function attachTelegramRichLocalMedia(richMessage) {
	const ids = [];
	const visit = (value) => {
		if (Array.isArray(value)) {
			let changed = false;
			const next = value.map((item) => {
				const visited = visit(item);
				if (visited !== item) changed = true;
				return visited;
			});
			return changed ? next : value;
		}
		if (!value || typeof value !== "object" || value instanceof InputFile) return value;
		const id = telegramRichLocalMediaIdFromSource(value.media);
		if (id) {
			const entry = TELEGRAM_RICH_LOCAL_MEDIA_REGISTRY.get(id);
			if (!entry) return value;
			ids.push(id);
			return {
				...value,
				media: entry.media.media
			};
		}
		let changed = false;
		const next = {};
		for (const [key, child] of Object.entries(value)) {
			const visited = visit(child);
			if (visited !== child) changed = true;
			next[key] = visited;
		}
		return changed ? next : value;
	};
	if (!richMessage || typeof richMessage !== "object" || !Array.isArray(richMessage.blocks) || TELEGRAM_RICH_LOCAL_MEDIA_REGISTRY.size === 0) return {
		richMessage,
		ids
	};
	const blocks = visit(richMessage.blocks);
	return {
		richMessage: blocks === richMessage.blocks ? richMessage : {
			...richMessage,
			blocks
		},
		ids
	};
}
function stripTelegramRichLocalMediaFromBlocks(richMessage) {
	const strip = (value) => {
		if (Array.isArray(value)) {
			const next = value.map(strip).filter((item) => item !== TELEGRAM_RICH_LOCAL_MEDIA_REMOVED);
			return value.length > 0 && next.length === 0 ? TELEGRAM_RICH_LOCAL_MEDIA_REMOVED : next;
		}
		if (!value || typeof value !== "object" || value instanceof InputFile) return value;
		if (telegramRichLocalMediaIdFromSource(value.media)) return TELEGRAM_RICH_LOCAL_MEDIA_REMOVED;
		const next = {};
		for (const [key, child] of Object.entries(value)) {
			const stripped = strip(child);
			if (stripped === TELEGRAM_RICH_LOCAL_MEDIA_REMOVED) return TELEGRAM_RICH_LOCAL_MEDIA_REMOVED;
			next[key] = stripped;
		}
		return next;
	};
	if (!richMessage || typeof richMessage !== "object" || !Array.isArray(richMessage.blocks)) return null;
	const blocks = strip(richMessage.blocks);
	return blocks === TELEGRAM_RICH_LOCAL_MEDIA_REMOVED ? null : {
		...richMessage,
		blocks
	};
}
async function isTelegramRichLocalPhotoCandidate(buffer) {
	if (!buffer || buffer.length === 0 || buffer.length > TELEGRAM_RICH_LOCAL_MEDIA_MAX_PHOTO_BYTES) return false;
	try {
		const metadata = await getImageMetadata(buffer);
		const width = metadata?.width;
		const height = metadata?.height;
		if (typeof width !== "number" || typeof height !== "number") return false;
		const shorterSide = Math.min(width, height);
		const longerSide = Math.max(width, height);
		return width + height <= MAX_TELEGRAM_PHOTO_DIMENSION_SUM && shorterSide > 0 && longerSide <= shorterSide * MAX_TELEGRAM_PHOTO_ASPECT_RATIO;
	} catch {
		return false;
	}
}
async function resolveTelegramRichLocalMedia(text, options = {}) {
	const source = typeof text === "string" ? text : "";
	const result = {
		text: source,
		media: [],
		ids: [],
		consumedMediaUrls: []
	};
	if (!isTelegramRichLocalMediaEnabled()) return result;
	const extraMediaUrls = (Array.isArray(options.extraMediaUrls) ? options.extraMediaUrls : []).filter((url) => isTelegramLocalMediaSource(url));
	const tagMatches = [...source.matchAll(TELEGRAM_RICH_LOCAL_MEDIA_TAG_PATTERN)];
	const hasInlineLocal = tagMatches.some((match) => isTelegramLocalMediaSource(match[3])) || new RegExp(TELEGRAM_RICH_LOCAL_MEDIA_MARKDOWN_PATTERN.source).test(source);
	if (!hasInlineLocal && extraMediaUrls.length === 0) return result;
	const loader = typeof options.mediaLoader === "function" ? options.mediaLoader : loadWebMedia;
	const loadOptions = buildOutboundMediaLoadOptions({
		maxBytes: options.maxBytes,
		mediaLocalRoots: options.mediaLocalRoots,
		mediaReadFile: options.mediaReadFile,
		mediaAccess: options.mediaAccess
	});
	const log = typeof options.log === "function" ? options.log : (message) => sendLogger.warn(message);
	const cache = new Map();
	const resolveEntry = async (src) => {
		const key = String(src).trim();
		if (cache.has(key)) return await cache.get(key);
		const pending = (async () => {
			try {
				const media = await loader(key, loadOptions);
				const kind = kindFromMime(media.contentType ?? void 0);
				const isGif = isGifMedia({
					contentType: media.contentType,
					fileName: media.fileName
				});
				let type = null;
				if (kind === "image" && !isGif) type = await isTelegramRichLocalPhotoCandidate(media.buffer) ? "photo" : null;
				else if (kind === "video" && !isGif) type = "video";
				else if (kind === "audio") type = "audio";
				if (!type) {
					log(\`[hotfix][telegram-rich-local-media] not embeddable (\${media.contentType ?? "unknown"}, \${media.buffer?.length ?? 0} bytes), falling back to attachment: \${key}\`);
					return null;
				}
				const fileName = hotfixTelegramRichLocalMediaFileName({
					fileName: media.fileName,
					contentType: media.contentType,
					kind,
					isGif
				});
				const entry = registerTelegramRichLocalMedia(type, new InputFile(media.buffer, fileName));
				result.media.push(entry);
				result.ids.push(entry.id);
				return entry;
			} catch (err) {
				log(\`[hotfix][telegram-rich-local-media] cannot load \${key}: \${formatErrorMessage(err)}\`);
				return null;
			}
		})();
		cache.set(key, pending);
		return await pending;
	};
	let next = "";
	let lastIndex = 0;
	for (const match of tagMatches) {
		const [raw, tag, before, src, after] = match;
		const start = match.index ?? 0;
		next += source.slice(lastIndex, start);
		lastIndex = start + raw.length;
		if (!isTelegramLocalMediaSource(src)) {
			next += raw;
			continue;
		}
		const entry = await resolveEntry(src);
		if (!entry || entry.type !== telegramRichLocalMediaTypeForTag(tag)) continue;
		next += \`<\${tag}\${before}src="tg://\${entry.type}?id=\${entry.id}"\${after}>\`;
	}
	next += source.slice(lastIndex);
	const markdownMatches = [...next.matchAll(TELEGRAM_RICH_LOCAL_MEDIA_MARKDOWN_PATTERN)];
	if (markdownMatches.length > 0) {
		let rebuilt = "";
		let cursor = 0;
		for (const match of markdownMatches) {
			const [raw, alt, src, title] = match;
			const start = match.index ?? 0;
			rebuilt += next.slice(cursor, start);
			cursor = start + raw.length;
			const entry = await resolveEntry(src);
			if (!entry) continue;
			rebuilt += \`\\n\\n\${buildTelegramRichLocalMediaBlock(entry, {
				alt,
				caption: title
			})}\\n\\n\`;
		}
		rebuilt += next.slice(cursor);
		next = rebuilt;
	}
	const appended = [];
	for (const url of extraMediaUrls) {
		const entry = await resolveEntry(url);
		if (!entry) continue;
		result.consumedMediaUrls.push(url);
		appended.push(buildTelegramRichLocalMediaBlock(entry));
	}
	if (appended.length > 0) next = \`\${next.trimEnd()}\\n\\n\${appended.join("\\n\\n")}\`;
	result.text = removeEmptyTelegramRichMediaContainers(next).replace(/\\n{3,}/g, "\\n\\n");
	return result;
}
//#endregion
`;
// Registry references can appear in model-authored rich blocks. Keep them unguessable
// so another in-flight message cannot pick up an attachment by guessing ocm<N>.
const REGISTRY_ID_BEFORE = "\ttelegramRichLocalMediaCounter += 1;\n\tconst id = `ocm${telegramRichLocalMediaCounter}`;";
const REGISTRY_ID_AFTER = "\tconst id = `ocm${hotfixTelegramRichMediaRandomUUID()}`;";
const CRYPTO_IMPORT = 'import { createHash, randomUUID as hotfixTelegramRichMediaRandomUUID } from "node:crypto";';
function secureRegistryIds(source) {
  if (source.includes(REGISTRY_ID_AFTER)) return source;
  let next = replaceOnce(source,
    'import { createHash } from "node:crypto";', CRYPTO_IMPORT,
    "rich local media: randomUUID import");
  next = replaceOnce(next, "let telegramRichLocalMediaCounter = 0;\n", "",
    "rich local media: remove predictable registry counter");
  return replaceOnce(next, REGISTRY_ID_BEFORE, REGISTRY_ID_AFTER,
    "rich local media: unguessable registry IDs");
}
export function patch(source) {
  if (source.includes("hotfix: telegram-rich-local-media")) return secureRegistryIds(source);
  let next = replaceOnce(
    source,
    "async function sendMessageTelegram(to, text, opts) {\n",
    HELPER + "async function sendMessageTelegram(to, text, opts) {\n",
    "telegram send: sendMessageTelegram declaration (helper insertion point)",
  );
  next = replaceOnce(
    next,
    "\t\t\t\t\tsendRich: async (richMessage) => {\n"
      + "\t\t\t\t\t\tconst rawParams = prepared.requestParams();\n"
      + "\t\t\t\t\t\tconst markup = rawParams.reply_markup ? { reply_markup: rawParams.reply_markup } : {};\n"
      + "\t\t\t\t\t\tconst sent = await request(\"sendRichMessage\", toTelegramRichMessageContextParams(rawParams), (effective) => config.api.raw.sendRichMessage({\n"
      + "\t\t\t\t\t\t\tchat_id: config.chatId,\n"
      + "\t\t\t\t\t\t\trich_message: richMessage,\n"
      + "\t\t\t\t\t\t\t...effective,\n"
      + "\t\t\t\t\t\t\t...markup\n"
      + "\t\t\t\t\t\t}), { rich: true });\n",
    "\t\t\t\t\tsendRich: async (richMessage) => {\n"
      + "\t\t\t\t\t\tconst rawParams = prepared.requestParams();\n"
      + "\t\t\t\t\t\tconst markup = rawParams.reply_markup ? { reply_markup: rawParams.reply_markup } : {};\n"
      + "\t\t\t\t\t\tconst attached = attachTelegramRichLocalMedia(richMessage); // hotfix: telegram-rich-local-media\n"
      + "\t\t\t\t\t\tconst sendRichMessageOnce = (message) => request(\"sendRichMessage\", toTelegramRichMessageContextParams(rawParams), (effective) => config.api.raw.sendRichMessage({\n"
      + "\t\t\t\t\t\t\tchat_id: config.chatId,\n"
      + "\t\t\t\t\t\t\trich_message: message,\n"
      + "\t\t\t\t\t\t\t...effective,\n"
      + "\t\t\t\t\t\t\t...markup\n"
      + "\t\t\t\t\t\t}), { rich: true });\n"
      + "\t\t\t\t\t\tlet sent;\n"
      + "\t\t\t\t\t\ttry {\n"
      + "\t\t\t\t\t\t\tsent = await sendRichMessageOnce(attached.richMessage);\n"
      + "\t\t\t\t\t\t} catch (err) {\n"
      + "\t\t\t\t\t\t\tconst stripped = attached.ids.length > 0 ? stripTelegramRichLocalMediaFromBlocks(richMessage) : null;\n"
      + "\t\t\t\t\t\t\tif (!stripped) throw err;\n"
      + "\t\t\t\t\t\t\t(config.warn ?? ((message) => sendLogger.warn(message)))(`[hotfix][telegram-rich-local-media] sendRichMessage with embedded media failed; retrying without media: ${formatErrorMessage(err)}`);\n"
      + "\t\t\t\t\t\t\tsent = await sendRichMessageOnce(stripped);\n"
      + "\t\t\t\t\t\t} finally {\n"
      + "\t\t\t\t\t\t\treleaseTelegramRichLocalMedia(attached.ids);\n"
      + "\t\t\t\t\t\t}\n",
    "telegram send: prepared sender sendRich (attach local media + retry without media)",
  );
  next = replaceOnce(
    next,
    "\t\tif (!text || !text.trim()) throw new Error(\"Message must be non-empty for Telegram sends\");\n\t\tconst textResult = await sendChunkedText(text, \"text send\");\n",
    "\t\tif (!text || !text.trim()) throw new Error(\"Message must be non-empty for Telegram sends\");\n"
      + "\t\t// hotfix: telegram-rich-local-media — локальные файлы (<img src=\"/path\">, ![](/path), opts.richLocalMediaUrls) встраиваются в rich message\n"
      + "\t\tconst richLocal = useRichMessages && opts.forceDocument !== true ? await resolveTelegramRichLocalMedia(text, {\n"
      + "\t\t\tmaxBytes: mediaMaxBytes,\n"
      + "\t\t\tmediaLocalRoots: opts.mediaLocalRoots,\n"
      + "\t\t\tmediaReadFile: opts.mediaReadFile,\n"
      + "\t\t\tmediaAccess: opts.mediaAccess,\n"
      + "\t\t\textraMediaUrls: opts.richLocalMediaUrls,\n"
      + "\t\t\tlog: (message) => sendLogger.warn(message)\n"
      + "\t\t}) : { text, media: [], ids: [], consumedMediaUrls: [] };\n"
      + "\t\tif (!richLocal.text.trim()) throw new Error(\"Message must be non-empty for Telegram sends\");\n"
      + "\t\tconst textResult = await sendChunkedText(richLocal.text, \"text send\");\n"
      + "\t\tfor (const unconsumedUrl of (Array.isArray(opts.richLocalMediaUrls) ? opts.richLocalMediaUrls : []).filter((url) => !richLocal.consumedMediaUrls.includes(url))) await sendMessageTelegram(to, \"\", {\n"
      + "\t\t\t...opts,\n"
      + "\t\t\tmediaUrls: void 0,\n"
      + "\t\t\tmediaUrl: unconsumedUrl,\n"
      + "\t\t\trichLocalMediaUrls: void 0,\n"
      + "\t\t\tbuttons: void 0\n"
      + "\t\t});\n",
    "telegram send: text-only send (local media resolution)",
  );
  // 9.5: первое имя в export-списке чанка меняется от сборки к сборке (9.4: isTelegramHistoryEntryAfterAmbientWatermark as $,
  // 9.5: isTelegramChatWindowPromptContext as $,) — якоримся на единственную строку `export { ` в начале строки.
  const exportLines = next.match(/^export \{ [^\n]*$/gm) ?? [];
  if (exportLines.length !== 1) throw new Error(`telegram send: export list (expected 1 top-level export line, found ${exportLines.length})`);
  if (/\bas (?:Rl|Rs|Rc|Re)\b/.test(exportLines[0])) throw new Error("telegram send: export alias collision (Rl/Rs/Rc/Re already exported by upstream)");
  next = replaceOnce(
    next,
    exportLines[0],
    exportLines[0].replace(/^export \{ /, "export { resolveTelegramRichLocalMedia as Rl, stripTelegramRichLocalMediaBlocks as Rs, isTelegramLocalMediaSource as Rc, isTelegramRichLocalMediaEnabled as Re, "),
    "telegram send: export list",
  );
  return secureRegistryIds(next);
}
export const check = { gate: "required", assertions: [
  contains(CRYPTO_IMPORT, "randomUUID imported for unguessable registry IDs"),
  contains(REGISTRY_ID_AFTER, "local media registry uses randomUUID IDs"),
  (src) => src.includes("telegramRichLocalMediaCounter") ? "predictable local media registry counter remains" : null,
  contains("async function resolveTelegramRichLocalMedia(text, options = {})", "rich local media resolver helper"),
  contains("const attached = attachTelegramRichLocalMedia(richMessage); // hotfix: telegram-rich-local-media", "prepared sender attaches local media into rich blocks"),
  contains("retrying without media", "retry-without-media fallback"),
  contains("releaseTelegramRichLocalMedia(attached.ids);", "registry released after sendRichMessage"),
  contains("const richLocal = useRichMessages && opts.forceDocument !== true ? await resolveTelegramRichLocalMedia(text, {", "text send resolves local media (forceDocument respected)"),
  contains("export { resolveTelegramRichLocalMedia as Rl, stripTelegramRichLocalMediaBlocks as Rs, isTelegramLocalMediaSource as Rc, isTelegramRichLocalMediaEnabled as Re,", "helper exports"),
  // 10.5: имя файла InputFile — локальный хелпер (апстримный resolveTelegramOutboundMediaFilename удалён → был ReferenceError)
  contains("function hotfixTelegramRichLocalMediaFileName(params) {", "local outbound media filename helper defined"),
  contains("const fileName = hotfixTelegramRichLocalMediaFileName({", "resolver uses local filename helper"),
  (src) => /(?<![.\w$])resolveTelegramOutboundMediaFilename\b/.test(src) && !/function resolveTelegramOutboundMediaFilename\(/.test(src) ? "reference to removed upstream resolveTelegramOutboundMediaFilename without definition (ReferenceError)" : null,
  (src) => /^import \{[^}\n]*\b\w+ as extensionForMime\b[^}\n]*\} from "\.\/mime-[\w-]+\.mjs";$/m.test(src) ? null : "extensionForMime is not imported from ./mime-*.mjs (local filename helper would throw)",
] };
