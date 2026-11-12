# Changelog

## v2026.11.3-1 - 2026-11-12

- Add version-pinned apply/check commands for OpenClaw 2026.11.3, reusing the
  existing rich-media patches and offline behavior checks.
- Preserve 2026.11.1 and legacy commands, strict version/drift guards,
  backups, allowed media roots and idempotence. CI covers both modern versions.

## v2026.11.1-1 - 2026-11-06

- Add a version-pinned port for the current rich-block transport: local HTML,
  Markdown and attachment media; delivery/payload routing; media limit 20.
- Use InputFile objects in rich blocks and preserve retry, registry cleanup,
  allowed media roots, forceDocument and the existing kill switch.
- Replace predictable shared media registry IDs with random UUIDs and test
  that a forged old-style ID cannot claim another pending attachment.
- Do not reapply the old sanitizer or generic chunking patches already covered
  upstream. Retain the 2026.7.1-2 scripts and verification job.
- Add offline behavior checks and pristine-artifact CI, including non-writing
  dry-run, backups, failed planning, version guards and idempotence.
