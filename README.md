# OpenClaw Telegram rich media hotfix

Portable hotfix layer for **OpenClaw `2026.7.1-2`** that makes Telegram *rich messages*
(Bot API 10.1+) carry media **inside** the message instead of sending photos as
separate attachments:

- HTTP(S) images/videos/audio authored as HTML (`<figure><img src="https://…"/></figure>`,
  `<tg-slideshow>`, `<tg-collage>`) or Markdown (`![alt](https://…)`) survive the outbound
  pipeline and render as native rich blocks.
- **Local files** (`<img src="/abs/path.png">`, `![alt](/abs/path.png "caption")`, `MEDIA:` directives,
  `message` tool attachments) are uploaded through `InputRichMessage.media`
  (Bot API 10.2, `tg://photo|video|audio?id=` links, grammY `attach://` multipart) and embedded in place;
  attachments are appended as `<figure>` blocks after the text.
- Long rich messages with HTML media blocks are no longer split by the generic 4096-char markdown
  chunker (which cut galleries in half); the Telegram send module does HTML-aware splitting instead.

This repository is an operator patch, not an upstream OpenClaw release. It patches built
`dist/*.js` bundles of an installed OpenClaw package — review it before running on a production host.
Upstream context: the first fix (conditional plain-text sanitizer for rich accounts) was fixed in
OpenClaw `main` after `2026.7.1-2` (issue #122443); local media embedding and rich-aware chunking are
not in upstream as of August 2026.

## Support matrix

| OpenClaw version | Status | Verification |
| --- | --- | --- |
| `2026.7.1-2` from npm | Supported | CI: syntax checks, non-writing dry run, application to a disposable npm install, checker, idempotent re-apply |
| Any other version | Unsupported | Anchors are version-specific; do not apply without review |

Node.js 20 or later. Telegram side: `channels.telegram.richMessages: true`; a Bot API server ≥ 10.2
(cloud API or a local `telegram-bot-api` build) for local-file embedding.

## Usage

```bash
git clone https://github.com/aspalagin/openclaw-telegram-rich-media-hotfix.git
cd openclaw-telegram-rich-media-hotfix
npm run check:syntax
OPENCLAW_PACKAGE_ROOT=/usr/lib/node_modules/openclaw npm run dry-run      # prints what would change
OPENCLAW_PACKAGE_ROOT=/usr/lib/node_modules/openclaw npm run apply        # backups go to ~/openclaw-backups/…
OPENCLAW_PACKAGE_ROOT=/usr/lib/node_modules/openclaw npm run check:installed
```

Then restart the gateway (`openclaw gateway restart`) — running Node processes keep the old bundles.
Re-run `apply` after any in-place reinstall of the same version (it is idempotent); on an upgrade,
re-verify anchors before trusting it.

Kill-switch for local-file embedding without re-applying: `OPENCLAW_TELEGRAM_RICH_LOCAL_MEDIA=0` in the
gateway environment. `forceDocument`/`asDocument` sends are never embedded.

## What the agent has to write

```html
<tg-slideshow><img src="https://…/1.jpg"/><img src="/abs/workspace/2.png"/><figcaption>Gallery</figcaption></tg-slideshow>

<figure><img src="/abs/workspace/chart.png"/><figcaption>Local file, uploaded inline</figcaption></figure>
```

Markdown images (`![alt](url "caption")`) work too. Local paths must be inside the roots OpenClaw already
allows for attachments (agent workspace / configured local roots). Not embedded (kept as separate
attachments): GIF animations, documents, video notes, remote attachment URLs passed as `mediaUrls`
(author them as `<img src="https://…">` in the text instead).

## Patches

| Id | Bundle | Change |
| --- | --- | --- |
| `telegram-rich-keep-html-media-deliver` | `deliver-*.js` | pass `cfg`/`accountId` into `outbound.sanitizeText` |
| `telegram-rich-keep-html-media` | `outbound-adapter-*.js` (telegram) | rich accounts skip `sanitizeForPlainText` (mirrors upstream) |
| `telegram-rich-local-media-patterns` | `sent-message-cache-*.js` | accept `src="tg://(photo|video|audio|document)?id=…"` in rich HTML validators |
| `telegram-rich-local-media-send` | `send-*.js` (telegram) | `resolveTelegramRichLocalMedia` helper, `rich_message.media` per chunk, retry without media on failure, text path integration |
| `telegram-rich-local-media-delivery` | `delivery-*.js` (telegram) | reply path: embed local media before chunking, remaining media via legacy path |
| `telegram-rich-local-media-adapter` | `outbound-adapter-*.js` | `sendPayload`: text + local attachments in one rich message |
| `telegram-rich-local-media-core` | `deliver-*.js` | new adapter capability `preferPayloadForMedia` routes text+media payloads to `sendPayload` |
| `telegram-rich-local-media-prefer-payload` | `outbound-adapter-*.js` | Telegram opts in for rich accounts with local attachments |
| `telegram-rich-chunk-limit` | `outbound-adapter-*.js` | rich accounts: core chunk limit 32768 instead of 4096 |

See `HOTFIX_NOTES.md` for the investigation, verification method (Telethon `rich_message.blocks`) and limitations.

## License

MIT
