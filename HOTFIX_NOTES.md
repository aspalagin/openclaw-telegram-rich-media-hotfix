# Hotfix notes

Baseline: OpenClaw `2026.7.1-2` (npm). Verified on a production gateway with a local Docker
`telegram-bot-api` (Bot API 10.2) and on a pristine npm install (CI).

## Symptoms

- With `richMessages: true`, `<tg-slideshow>`, `<figure><img/>` and `![](https://…)` never produced
  media inside the message. Telethon (`Message.rich_message`) showed `photos: []`; a `tcpdump` on the
  Bot API port showed the outbound `sendRichMessage` HTML already flattened: `<h2>` → `<i>`, `<figure>` gone.
- Direct `sendRichMessage` calls with the same HTML created `photo`/`slideshow` blocks — the Bot API
  server and the image URLs were fine.

## Root causes

1. `createTelegramOutboundAdapter().sanitizeText` unconditionally applied `sanitizeForPlainText`, which
   converts headings to `*…*` and strips every other tag. Upstream made it conditional on
   `richMessages` after `2026.7.1-2` (openclaw/openclaw#122443).
2. Local files were only sendable through `sendPhoto`/`sendDocument`. Bot API 10.2 allows
   `InputRichMessage.media = [{ id, media: InputMediaPhoto|Video|Audio }]` referenced from HTML as
   `tg://photo?id=…`; grammY ≥ 1.44 serializes nested `InputFile` instances as `attach://` multipart
   parts, so the raw `sendRichMessage` call works without extra transport code.
3. `src/infra/outbound/deliver.ts` only routes a payload to the adapter's `sendPayload` when it has
   presentation/interactive/channelData/audioAsVoice; plain text + attachments are split into media units
   and sent one by one through `sendMedia`. The adapter therefore never saw the whole payload.
4. The same core chunks outbound text with a generic markdown chunker at
   `resolveEffectiveTextChunkLimit` (≤ 4096). Rich messages allow 32768 characters and HTML media blocks
   are long; the cut landed inside a `<tg-slideshow>` and dropped the gallery plus the following heading.
5. Telegram silently truncates a rich message at the block that would exceed **20 media items** and
   drops every block after it (the Bot API docs promise "up to 50 media attachments in total"; the
   Bot API server's own response still lists all blocks — the cut happens on Telegram's side).
   Measured with direct `sendRichMessage` calls read back through Telethon: 21 photos → 18 photos and
   the trailing text lost; galleries reordered → always the *last* gallery lost (not a bad URL);
   exactly 20 → complete. OpenClaw's `TELEGRAM_RICH_MEDIA_LIMIT = 50` therefore let 21–50-media
   messages through as one chunk, and `splitTelegramHtmlChunks` — once the limit is lowered — splits
   in the middle of a `<tg-slideshow>` (2 photos in one message, 1 photo + caption in the next).

## Behaviour after the patch

- Rich accounts keep supported HTML islands in text; `sanitizeAssistantVisibleText` still runs.
- `resolveTelegramRichLocalMedia(text, { mediaLoader, maxBytes, mediaLocalRoots, extraMediaUrls })`
  loads local sources through the same `loadWebMedia` policy as attachments, classifies by MIME
  (image → `photo` when ≤ 10 MB and within Telegram photo dimension limits, video → `video`,
  audio → `audio`; GIF/documents fall back to attachments), rewrites `src`, converts Markdown images
  into `<figure>` blocks, appends attachments as `<figure>` blocks and reports `consumedMediaUrls`.
- Each rich chunk gets only the `media` entries it references. If Telegram rejects a chunk with
  media, it is retried once without the media blocks (logged).
- The delivery core asks `outbound.preferPayloadForMedia({ payload, cfg, accountId, forceDocument })`;
  Telegram answers `true` for rich accounts with non-empty text and at least one local attachment
  unless `forceDocument` is set. Remaining non-embeddable attachments follow the legacy sequence.
- `resolveEffectiveTextChunkLimit` returns 32768 for rich accounts (configured limits above 4096 are
  respected up to 32768); non-rich accounts keep ≤ 4096.
- `TELEGRAM_RICH_MEDIA_LIMIT` is 20; messages with more media are split into several rich messages.
  `<tg-slideshow>`/`<tg-collage>` are atomic: when a gallery does not fit the remaining media budget
  of the current chunk, the chunk is closed before the gallery (a single gallery larger than 20 is
  still split by the per-media rule). Offline check with `splitTelegramRichMessageTextChunks`:
  7 galleries × 3 photos → [6 galleries] + [gallery 7 + trailing text]; 20 photos → one message.

## Verification

Read the bot's messages from a user account with Telethon (layer ≥ 227):
`message.rich_message.blocks` must contain `PageBlockPhoto`/`PageBlockSlideshow` and
`rich_message.photos` must be non-empty. Gateway log: `operation=sendRichMessage`.

## Limitations

- Anchors are specific to `2026.7.1-2` bundles (hashed file names are matched by content, not by name).
- `tg://document?id=` (Bot API 10.3) is not used; documents stay attachments.
- Remote attachment URLs passed as `mediaUrls` are not embedded (write them as `<img src="https://…">`).
- Telegram clients that do not render rich messages show the text without media (the message is
  still a single rich message).
- The 20-media cap is an observed server-side behaviour (2026-08-25, Bot API 10.2/10.3 era), not a
  documented one; if Telegram raises it, adjust `TELEGRAM_RICH_MEDIA_LIMIT` in `patchTelegramSendRichMediaLimit`.
