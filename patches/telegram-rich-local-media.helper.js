//#region hotfix: telegram-rich-local-media (2026-08-25)
// Локальные файлы внутри Telegram rich message: <img|video|audio src="/abs/path|file://|~/">, markdown ![alt](/abs/path "caption")
// и вложения (MEDIA:/mediaUrls) загружаются как InputRichMessageMedia (Bot API 10.2+, multipart attach://) и заменяются
// на ссылки tg://photo|video|audio?id=<id>. Kill-switch: OPENCLAW_TELEGRAM_RICH_LOCAL_MEDIA=0.
const TELEGRAM_RICH_LOCAL_MEDIA_ENV = "OPENCLAW_TELEGRAM_RICH_LOCAL_MEDIA";
const TELEGRAM_RICH_LOCAL_MEDIA_MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const TELEGRAM_RICH_LOCAL_MEDIA_SOURCE_PATTERN = /^(?:file:\/\/|\/(?!\/)|~\/)/;
const TELEGRAM_RICH_LOCAL_MEDIA_TAG_PATTERN = /<(img|video|audio)\b([^>]*?)\bsrc="([^"]+)"([^>]*)>/gi;
const TELEGRAM_RICH_LOCAL_MEDIA_MARKDOWN_PATTERN = /!\[([^\]\n]*)\]\(((?:file:\/\/|\/(?!\/)|~\/)[^\s)"]+)(?:\s+"([^"\n]*)")?\)/g;
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
	const src = `tg://${entry.type}?id=${entry.id}`;
	const caption = options.caption ? `<figcaption>${escapeTelegramRichLocalMediaText(options.caption)}</figcaption>` : "";
	const alt = options.alt ? ` alt="${escapeTelegramRichLocalMediaText(options.alt)}"` : "";
	const inner = entry.type === "photo" ? `<img src="${src}"${alt}/>` : entry.type === "video" ? `<video src="${src}"></video>` : `<audio src="${src}"></audio>`;
	return `<figure>${inner}${caption}</figure>`;
}
function removeEmptyTelegramRichMediaContainers(html) {
	return html.replace(/<figure\b[^>]*>(?:\s|<figcaption\b[^>]*>[\s\S]*?<\/figcaption>)*<\/figure>/gi, "").replace(/<(tg-slideshow|tg-collage)\b[^>]*>([\s\S]*?)<\/\1>/gi, (match, _tag, inner) => /<(?:img|video)\b/i.test(inner) ? match : "");
}
function telegramRichLocalMediaAppliesToChunk(html, entries) {
	return typeof html === "string" && Array.isArray(entries) && entries.some((entry) => html.includes(`?id=${entry.id}"`));
}
function buildTelegramRichLocalMediaMessage(chunk, entries) {
	const base = chunk.skipEntityDetection ? {
		html: chunk.text,
		skip_entity_detection: true
	} : { html: chunk.text };
	const media = Array.isArray(entries) ? entries.filter((entry) => chunk.text.includes(`?id=${entry.id}"`)).map((entry) => entry.media) : [];
	return media.length > 0 ? {
		...base,
		media
	} : base;
}
function stripTelegramRichLocalMediaBlocks(html) {
	const next = String(html ?? "").replace(/<img\b[^>]*\bsrc="tg:\/\/[^"]*"[^>]*\/?>/gi, "").replace(/<video\b[^>]*\bsrc="tg:\/\/[^"]*"[^>]*(?:\/>|>[\s\S]*?<\/video>)/gi, "").replace(/<audio\b[^>]*\bsrc="tg:\/\/[^"]*"[^>]*(?:\/>|>[\s\S]*?<\/audio>)/gi, "");
	return removeEmptyTelegramRichMediaContainers(next).replace(/\n{3,}/g, "\n\n").trim();
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
		mediaReadFile: options.mediaReadFile
	});
	const log = typeof options.log === "function" ? options.log : (message) => sendLogger.warn(message);
	const cache = new Map();
	let counter = 0;
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
					log(`[hotfix][telegram-rich-local-media] not embeddable (${media.contentType ?? "unknown"}, ${media.buffer?.length ?? 0} bytes), falling back to attachment: ${key}`);
					return null;
				}
				counter += 1;
				const id = `ocm${counter}`;
				const fileName = media.fileName ?? inferFilename(kind) ?? "file";
				const entry = {
					id,
					type,
					media: {
						id,
						media: {
							type,
							media: new InputFileCtor(media.buffer, fileName)
						}
					}
				};
				result.media.push(entry);
				return entry;
			} catch (err) {
				log(`[hotfix][telegram-rich-local-media] cannot load ${key}: ${formatErrorMessage(err)}`);
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
		next += `<${tag}${before}src="tg://${entry.type}?id=${entry.id}"${after}>`;
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
			rebuilt += `\n\n${buildTelegramRichLocalMediaBlock(entry, {
				alt,
				caption: title
			})}\n\n`;
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
	if (appended.length > 0) next = `${next.trimEnd()}\n\n${appended.join("\n\n")}`;
	result.text = removeEmptyTelegramRichMediaContainers(next).replace(/\n{3,}/g, "\n\n");
	return result;
}
//#endregion
