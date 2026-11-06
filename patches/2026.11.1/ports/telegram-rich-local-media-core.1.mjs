// OpenClaw 2026.11.1: telegram-rich-local-media-core.1.
import { replaceOnce, contains } from "../helpers.mjs";
export const label = "telegram-rich-local-media-core";
export const verdict = "port";
export const target = { key: "deliverHandler", label: "channel deliver handler bundle (deliver-prepare)", needles: ["shouldSkipPlainTextSanitization: outbound?.shouldSkipPlainTextSanitization ? (payload) => outbound.shouldSkipPlainTextSanitization({ payload }) : void 0,", "resolveEffectiveTextChunkLimit: outbound?.resolveEffectiveTextChunkLimit ? ({ fallbackLimit, formatting }) =>"] };
export function patch(source) {
  if (source.includes("hotfix: telegram-rich-local-media-prefer-payload")) return source;
  return replaceOnce(
    source,
    "\t\tshouldSkipPlainTextSanitization: outbound?.shouldSkipPlainTextSanitization ? (payload) => outbound.shouldSkipPlainTextSanitization({ payload }) : void 0,\n",
    "\t\tshouldSkipPlainTextSanitization: outbound?.shouldSkipPlainTextSanitization ? (payload) => outbound.shouldSkipPlainTextSanitization({ payload }) : void 0,\n"
      + "\t\tpreferPayloadForMedia: outbound?.preferPayloadForMedia ? (payload, overrides) => outbound.preferPayloadForMedia({\n"
      + "\t\t\tpayload,\n"
      + "\t\t\tcfg: params.cfg,\n"
      + "\t\t\taccountId: params.accountId ?? void 0,\n"
      + "\t\t\tforceDocument: overrides?.forceDocument ?? params.forceDocument\n"
      + "\t\t}) === true : void 0, // hotfix: telegram-rich-local-media-prefer-payload\n",
    "deliver-prepare: channel handler preferPayloadForMedia",
  );
}
export const check = { gate: "required", assertions: [
  contains("hotfix: telegram-rich-local-media-prefer-payload", "deliver-prepare prefer-payload marker"),
  contains("preferPayloadForMedia: outbound?.preferPayloadForMedia ? (payload, overrides) => outbound.preferPayloadForMedia({", "handler exposes preferPayloadForMedia"),
  contains("forceDocument: overrides?.forceDocument ?? params.forceDocument\n", "preferPayloadForMedia sees handler-level forceDocument (10.5: not in sendOverrides)"),
  contains("\t\tforceDocument: params.forceDocument,\n", "upstream baseCtx still carries params.forceDocument (createPluginHandler)"),
  (src) => { const i = src.indexOf("function createPluginHandler(params) {"); const j = src.indexOf("hotfix: telegram-rich-local-media-prefer-payload"); if (i === -1) return "missing createPluginHandler(params)"; const k = src.indexOf("\nfunction ", i + 10); return j > i && (k === -1 || j < k) ? null : "prefer-payload capability is not inside createPluginHandler(params) (params would be a different binding)"; },
] };
