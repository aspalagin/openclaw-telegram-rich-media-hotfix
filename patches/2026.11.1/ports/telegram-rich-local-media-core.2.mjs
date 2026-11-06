// OpenClaw 2026.11.1: telegram-rich-local-media-core.2.
import { replaceOnce, contains } from "../helpers.mjs";
export const label = "telegram-rich-local-media-core";
export const verdict = "rewrite";
export const target = { key: "deliverCore", label: "outbound deliver core bundle", needles: ["if (deliveryHandler.sendPayload && (deliveryHandler.supportsMediaPayload && payloadSummary.mediaUrls.length > 1 || payloadRequiresDurablePayloadTransport(effectivePayload, { sendTextOnlyErrorPayloads: deliveryHandler.sendTextOnlyErrorPayloads }))) {", "const sendOverrides = {"] };
export function patch(source) {
  if (source.includes("hotfix: telegram-rich-local-media-prefer-payload")) return source;
  return replaceOnce(
    source,
    "if (deliveryHandler.sendPayload && (deliveryHandler.supportsMediaPayload && payloadSummary.mediaUrls.length > 1 || payloadRequiresDurablePayloadTransport(effectivePayload, { sendTextOnlyErrorPayloads: deliveryHandler.sendTextOnlyErrorPayloads }))) {",
    "if (deliveryHandler.sendPayload && (deliveryHandler.preferPayloadForMedia?.(effectivePayload, sendOverrides) === true || deliveryHandler.supportsMediaPayload && payloadSummary.mediaUrls.length > 1 || payloadRequiresDurablePayloadTransport(effectivePayload, { sendTextOnlyErrorPayloads: deliveryHandler.sendTextOnlyErrorPayloads }))) { // hotfix: telegram-rich-local-media-prefer-payload",
    "deliver core: sendPayload routing condition",
  );
}
export const check = { gate: "required", assertions: [
  contains("hotfix: telegram-rich-local-media-prefer-payload", "deliver core prefer-payload marker"),
  contains("deliveryHandler.preferPayloadForMedia?.(effectivePayload, sendOverrides) === true ||", "sendPayload routing honours preferPayloadForMedia"),
] };
