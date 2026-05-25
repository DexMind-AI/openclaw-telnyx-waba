import net from "node:net";
import { createPublicKey, randomUUID, verify } from "node:crypto";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { saveRemoteMedia } from "openclaw/plugin-sdk/media-runtime";

const WHATSAPP_ROUTE_PATH = "/telnyx/whatsapp";
const VOICE_ROUTE_PATH = "/telnyx/voice";
const DEFAULT_GATEWAY_URL = "http://127.0.0.1:18789";
const DEFAULT_SMS_DELEGATE_URL = "http://127.0.0.1:18789/telnyx-sms/webhook";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const DEFAULT_MEDIA_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_MEDIA_DOWNLOAD_TIMEOUT_MS = 10_000;
const ALLOWED_TELNYX_MEDIA_HOST_SUFFIXES = [".telnyx.com", ".telnyxcdn.com", ".telnyx.net"];
const DIAGNOSTIC_SHAPE_MAX_DEPTH = 6;
const DIAGNOSTIC_SHAPE_MAX_KEYS = 40;
const MESSAGE_CONTEXT_LIMIT = 500;
const MESSAGE_CONTEXT_TEXT_LIMIT = 500;
const messageContextById = new Map();

function env(name, fallback = "") {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function envInt(name, fallback) {
  const value = Number.parseInt(env(name), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizePhoneNumber(value) {
  return String(value ?? "").replace(/[^\d+]/g, "");
}

function maskPhoneNumber(value) {
  const normalized = normalizePhoneNumber(value);
  if (!normalized) return "unknown";
  return `${normalized.slice(0, 3)}...${normalized.slice(-2)}`;
}

function allowedNumbers() {
  return new Set(
    env("TELNYX_WHATSAPP_ALLOWED_NUMBERS")
      .split(",")
      .map((value) => normalizePhoneNumber(value.trim()))
      .filter(Boolean),
  );
}

function voiceAllowedNumbers() {
  return new Set(
    env("TELNYX_VOICE_ALLOWED_NUMBERS")
      .split(",")
      .map((value) => normalizePhoneNumber(value.trim()))
      .filter(Boolean),
  );
}

function senderAllowed(fromNumber) {
  const allowed = allowedNumbers();
  return allowed.size === 0 || allowed.has(normalizePhoneNumber(fromNumber));
}

function callerAllowed(fromNumber) {
  const allowed = voiceAllowedNumbers();
  return allowed.size === 0 || Boolean(fromNumber && allowed.has(normalizePhoneNumber(fromNumber)));
}

function decodeTelnyxPublicKey(value) {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, "base64");
    if (decoded.length === 32) return decoded;
  } catch {
    // Fall through to hex.
  }
  const decoded = Buffer.from(value, "hex");
  return decoded.length === 32 ? decoded : null;
}

function verifyTelnyxSignature(headers, rawBody) {
  const publicKeyValue = env("TELNYX_PUBLIC_KEY");
  if (!publicKeyValue) return { ok: true };

  const timestamp = headers["telnyx-timestamp"];
  const signature = headers["telnyx-signature-ed25519"];
  if (!timestamp || !signature) return { ok: false, reason: "Missing Telnyx signature" };

  const signedAt = Number.parseInt(Array.isArray(timestamp) ? timestamp[0] : timestamp, 10);
  if (!Number.isFinite(signedAt) || Math.abs(Date.now() / 1000 - signedAt) > 300) {
    return { ok: false, reason: "Invalid Telnyx timestamp" };
  }

  const publicKeyBytes = decodeTelnyxPublicKey(publicKeyValue);
  if (!publicKeyBytes) return { ok: false, reason: "Invalid Telnyx public key" };

  try {
    const signatureBytes = Buffer.from(Array.isArray(signature) ? signature[0] : signature, "base64");
    const publicKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyBytes]),
      format: "der",
      type: "spki",
    });
    const signedPayload = Buffer.from(`${Array.isArray(timestamp) ? timestamp[0] : timestamp}|${rawBody.toString("utf8")}`);
    return verify(null, signedPayload, publicKey, signatureBytes)
      ? { ok: true }
      : { ok: false, reason: "Invalid Telnyx signature" };
  } catch {
    return { ok: false, reason: "Invalid Telnyx signature" };
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function writeJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.setHeader("content-length", Buffer.byteLength(payload));
  res.end(payload);
}

function diagnosticValueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value;
}

function payloadShape(value, depth = 0, state = { keys: 0 }, seen = new WeakSet()) {
  if (!value || typeof value !== "object") return diagnosticValueType(value);
  if (seen.has(value)) return "[Circular]";
  if (depth >= DIAGNOSTIC_SHAPE_MAX_DEPTH) return `[${diagnosticValueType(value)}]`;
  if (state.keys >= DIAGNOSTIC_SHAPE_MAX_KEYS) return "[Truncated]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, 3).map((item) => payloadShape(item, depth + 1, state, seen));
  }

  const shape = {};
  for (const key of Object.keys(value).sort()) {
    if (state.keys >= DIAGNOSTIC_SHAPE_MAX_KEYS) {
      shape["..."] = "[Truncated]";
      break;
    }
    state.keys += 1;
    shape[key] = payloadShape(value[key], depth + 1, state, seen);
  }
  return shape;
}

function diagnosticPayloadShape(payload) {
  try {
    return JSON.stringify(payloadShape(payload));
  } catch {
    return '"[Unserializable]"';
  }
}

function payloadEvent(body) {
  const data = body && typeof body.data === "object" && !Array.isArray(body.data) ? body.data : {};
  const payload = data.payload && typeof data.payload === "object" && !Array.isArray(data.payload) ? data.payload : {};
  return {
    eventType: String(data.event_type || body?.event_type || ""),
    payload,
  };
}

function phoneNumber(value) {
  if (typeof value === "string" && value) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const nested = value.phone_number || value.number || value.value;
    return nested ? String(nested) : null;
  }
  if (Array.isArray(value) && value.length) return phoneNumber(value[0]);
  return null;
}

function textValue(value) {
  if (typeof value === "string") return value.trim() ? value : null;
  if (!value || typeof value !== "object") return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const text = textValue(item);
      if (text) return text;
    }
    return null;
  }

  for (const key of ["body", "text", "message", "title", "caption", "value", "id"]) {
    const text = textValue(value[key]);
    if (text) return text;
  }

  const interactiveReply =
    value.interactive?.button_reply ||
    value.interactive?.list_reply ||
    value.button_reply ||
    value.list_reply ||
    value.reply;
  return textValue(interactiveReply);
}

function collectInteractiveTexts(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object") return [];
  if (seen.has(value)) return [];
  seen.add(value);

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectInteractiveTexts(item, seen));
  }

  const reply =
    value.interactive?.button_reply ||
    value.interactive?.list_reply ||
    value.button_reply ||
    value.list_reply ||
    value.reply;
  const own = textValue(reply?.title || reply?.description || reply?.body || reply?.text);

  const nested = Object.values(value).flatMap((item) => collectInteractiveTexts(item, seen));
  return own ? [own, ...nested] : nested;
}

function scalarText(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() ? value.trim() : null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function hasMessageContent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.reaction && Object.keys(value).length <= 3) return false;
  return Boolean(
    value.text ||
      value.body ||
      value.whatsapp_message ||
      value.media ||
      value.image ||
      value.video ||
      value.audio ||
      value.document ||
      value.sticker ||
      value.location ||
      value.contacts ||
      value.contact ||
      value.interactive ||
      value.button_reply ||
      value.list_reply,
  );
}

function rememberedMessageText(messageId) {
  return messageId ? messageContextById.get(messageId) || null : null;
}

function rememberMessageId(messageId, text) {
  const id = scalarText(messageId);
  const trimmed = scalarText(text);
  if (!id || !trimmed) return;

  const summary = trimmed.length > MESSAGE_CONTEXT_TEXT_LIMIT ? `${trimmed.slice(0, MESSAGE_CONTEXT_TEXT_LIMIT)}...` : trimmed;
  messageContextById.delete(id);
  messageContextById.set(id, summary);
  while (messageContextById.size > MESSAGE_CONTEXT_LIMIT) {
    const oldest = messageContextById.keys().next().value;
    messageContextById.delete(oldest);
  }
}

function collectReplyReferences(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object") return [];
  if (seen.has(value)) return [];
  seen.add(value);

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectReplyReferences(item, seen));
  }

  const ids = [];
  const contextId = scalarText(value.context?.id || value.context?.message_id || value.context?.messageId);
  if (contextId) ids.push(contextId);

  const replyToId = scalarText(
    value.reply_to_message?.id ||
      value.reply_to_message?.message_id ||
      value.reply_to?.id ||
      value.replyTo?.id ||
      value.quoted_message?.id ||
      value.quotedMessage?.id ||
      value.referenced_message?.id ||
      value.referencedMessage?.id,
  );
  if (replyToId) ids.push(replyToId);

  for (const nested of Object.values(value)) ids.push(...collectReplyReferences(nested, seen));
  return [...new Set(ids)];
}

function replyContextText(payload) {
  const lines = [];
  for (const messageId of collectReplyReferences(payload)) {
    const referencedText = rememberedMessageText(messageId);
    lines.push(
      referencedText
        ? `The user replied to a previous WhatsApp message. Replied-to message: ${referencedText}`
        : `The user replied to a previous WhatsApp message. Replied-to message ID: ${messageId}`,
    );
  }
  return lines.join("\n");
}

function messageTextSnippet(value) {
  const directText = textValue(value.text || value.body);
  const interactiveText = collectInteractiveTexts(value).filter(Boolean).join("\n");
  const whatsappText = textValue(value.whatsapp_message?.text || value.whatsapp_message?.body);
  return directText || whatsappText || interactiveText || null;
}

function messageContextSummary(value) {
  const text = messageTextSnippet(value);
  const location = locationText(value);
  const attachments = collectAttachments(value).filter((attachment) => attachment.type !== "reaction");
  const attachmentsText = attachments.length ? attachments.map((attachment) => attachmentLine(attachment)).join("\n") : null;
  return [text, location, attachmentsText].filter(Boolean).join("\n\n");
}

function collectObservedMessageTexts(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object") return [];
  if (seen.has(value)) return [];
  seen.add(value);

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectObservedMessageTexts(item, seen));
  }

  const own = hasMessageContent(value) ? messageTextSnippet(value) : null;
  const nested = Object.values(value).flatMap((item) => collectObservedMessageTexts(item, seen));
  return [...new Set([own, ...nested].filter(Boolean))];
}

function rememberObservedMessageContexts(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) rememberObservedMessageContexts(item, seen);
    return;
  }

  if (hasMessageContent(value)) {
    rememberMessageId(value.id, messageContextSummary(value));
  }

  for (const nested of Object.values(value)) rememberObservedMessageContexts(nested, seen);
}

function rememberMessageContext(payload, text) {
  if (hasMessageContent(payload)) rememberMessageId(payload.id, text);
}

function finiteNumber(value) {
  const number = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(number) ? number : null;
}

function extractLocationValue(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const location = extractLocationValue(item, seen);
      if (location) return location;
    }
    return null;
  }

  const latitude = finiteNumber(value.latitude ?? value.lat);
  const longitude = finiteNumber(value.longitude ?? value.lon ?? value.lng ?? value.long);
  if (latitude !== null && longitude !== null) {
    return {
      latitude,
      longitude,
      name: textValue(value.name || value.title),
      address: textValue(value.address || value.label || value.description || value.url),
    };
  }

  for (const nested of Object.values(value)) {
    const location = extractLocationValue(nested, seen);
    if (location) return location;
  }

  return null;
}

function locationText(payload) {
  const location = extractLocationValue(payload);
  if (!location) return null;

  const details = [];
  if (location.name) details.push(`Name: ${location.name}`);
  if (location.address) details.push(`Address: ${location.address}`);
  const suffix = details.length ? ` ${details.join(". ")}.` : "";
  return `The user shared their WhatsApp location: latitude ${location.latitude}, longitude ${location.longitude}.${suffix}`;
}

function hasMedia(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => hasMedia(item, seen));

  if (Array.isArray(value.media) && value.media.length > 0) return true;
  if (value.image || value.video || value.audio || value.document || value.sticker) return true;
  if (value.whatsapp_message?.image || value.whatsapp_message?.video || value.whatsapp_message?.audio) return true;
  if (value.whatsapp_message?.document || value.whatsapp_message?.sticker) return true;
  if (value.type && ["image", "video", "audio", "document", "sticker"].includes(String(value.type).toLowerCase())) return true;

  return Object.values(value).some((nested) => hasMedia(nested, seen));
}

function mediaTypeFromMime(mimeType) {
  if (!mimeType) return "media";
  const prefix = String(mimeType).split("/")[0]?.toLowerCase();
  return ["image", "video", "audio"].includes(prefix) ? prefix : "media";
}

function mediaUriFromPath(path) {
  if (!path) return null;
  const marker = "/media/inbound/";
  const index = path.indexOf(marker);
  return index >= 0 ? `media://inbound/${path.slice(index + marker.length)}` : null;
}

function isPublicIpv4(host) {
  const parts = host.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  return true;
}

function isPublicIpv6(host) {
  const normalized = host.toLowerCase();
  if (normalized === "::1" || normalized === "::") return false;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return false;
  if (normalized.startsWith("fe80")) return false;
  return true;
}

function isPublicIp(host) {
  return host.includes(":") ? isPublicIpv6(host) : isPublicIpv4(host);
}

function validateMediaUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "invalid URL" };
  }

  if (parsed.protocol !== "https:") return { ok: false, reason: "media URL must use https" };
  if (parsed.username || parsed.password) return { ok: false, reason: "media URL must not contain credentials" };

  const host = parsed.hostname.toLowerCase();
  if (!host) return { ok: false, reason: "missing host" };
  if (host === "localhost" || host.endsWith(".localhost")) return { ok: false, reason: "localhost is not allowed" };

  if (net.isIP(host) !== 0) {
    return isPublicIp(host)
      ? { ok: false, reason: "IP-literal media URLs are not allowed" }
      : { ok: false, reason: "private or reserved IP address is not allowed" };
  }

  const allowed = ALLOWED_TELNYX_MEDIA_HOST_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix));
  return allowed ? { ok: true } : { ok: false, reason: `host is not an allowed Telnyx media host: ${host}` };
}

function telnyxMediaHeaders(url) {
  const apiKey = env("TELNYX_API_KEY");
  if (!apiKey) return undefined;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname.endsWith("telnyx.com") ? { authorization: `Bearer ${apiKey}` } : undefined;
  } catch {
    return undefined;
  }
}

function mediaFilePathHint(attachment) {
  if (attachment.filename) return attachment.filename;
  if (attachment.id) return `${attachment.type || "media"}-${attachment.id}`;
  if (attachment.url) {
    try {
      const pathname = new URL(attachment.url).pathname;
      const basename = pathname.split("/").filter(Boolean).pop();
      if (basename) return basename;
    } catch {
      // Fall through.
    }
  }
  return `${attachment.type || "media"}-attachment`;
}

function mediaDetails(type, value) {
  if (!value) return null;
  if (typeof value === "string") return { type, url: value };
  if (typeof value !== "object" || Array.isArray(value)) return null;

  const mimeType = scalarText(value.content_type || value.mime_type || value.mimeType);
  return {
    type: scalarText(value.type) || type || mediaTypeFromMime(mimeType),
    url: scalarText(value.url || value.media_url || value.mediaUrl || value.link || value.href),
    id: scalarText(value.id || value.media_id || value.mediaId),
    filename: scalarText(value.filename || value.file_name || value.name),
    mimeType,
    size: scalarText(value.size || value.file_size || value.fileSize),
    sha256: scalarText(value.sha256),
    caption: textValue(value.caption || value.text || value.title || value.description),
  };
}

function contactDetails(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const name = value.name && typeof value.name === "object" ? value.name : {};
  const phones = Array.isArray(value.phones)
    ? value.phones.map((phone) => scalarText(phone.phone || phone.wa_id || phone.number)).filter(Boolean)
    : [];
  const emails = Array.isArray(value.emails)
    ? value.emails.map((email) => scalarText(email.email || email.address)).filter(Boolean)
    : [];
  const addresses = Array.isArray(value.addresses)
    ? value.addresses.map((address) => textValue(address)).filter(Boolean)
    : [];

  return {
    type: "contact",
    name:
      textValue(name.formatted_name || name.full_name || value.formatted_name || value.name) ||
      [name.first_name, name.middle_name, name.last_name].map(scalarText).filter(Boolean).join(" ") ||
      null,
    organization: textValue(value.org || value.organization),
    phones,
    emails,
    addresses,
  };
}

function reactionDetails(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const emoji = scalarText(value.emoji);
  const messageId = scalarText(value.message_id || value.messageId || value.id);
  if (!emoji && !messageId) return null;
  return { type: "reaction", emoji, messageId, referencedText: rememberedMessageText(messageId) };
}

function collectAttachments(payload) {
  const attachments = [];
  const seen = new Set();
  const visited = new WeakSet();

  const addAttachment = (attachment) => {
    if (!attachment) return;
    const key = JSON.stringify(attachment);
    if (seen.has(key)) return;
    seen.add(key);
    attachments.push(attachment);
  };

  const addMedia = (type, value) => {
    if (Array.isArray(value)) {
      for (const item of value) addMedia(type, item);
      return;
    }
    addAttachment(mediaDetails(type, value));
  };

  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    if (Array.isArray(value.media)) {
      for (const media of value.media) addMedia(null, media);
    }

    for (const type of ["image", "video", "audio", "document", "sticker"]) {
      if (value[type]) addMedia(type, value[type]);
    }

    if (Array.isArray(value.contacts)) {
      for (const contact of value.contacts) addAttachment(contactDetails(contact));
    } else if (value.contact) {
      addAttachment(contactDetails(value.contact));
    }

    if (value.reaction) addAttachment(reactionDetails(value.reaction));
    for (const nested of Object.values(value)) visit(nested);
  };

  visit(payload);
  return attachments;
}

function attachmentLine(attachment) {
  const type = attachment.type ? `${attachment.type[0].toUpperCase()}${attachment.type.slice(1)}` : "Media";
  if (attachment.type === "contact") {
    const details = [];
    if (attachment.name) details.push(`Name: ${attachment.name}`);
    if (attachment.organization) details.push(`Organization: ${attachment.organization}`);
    if (attachment.phones?.length) details.push(`Phones: ${attachment.phones.join(", ")}`);
    if (attachment.emails?.length) details.push(`Emails: ${attachment.emails.join(", ")}`);
    if (attachment.addresses?.length) details.push(`Addresses: ${attachment.addresses.join("; ")}`);
    return details.length ? `${type} card. ${details.join(". ")}.` : `${type} card.`;
  }
  if (attachment.type === "reaction") {
    const details = [];
    if (attachment.emoji) details.push(`Emoji: ${attachment.emoji}`);
    if (attachment.messageId) details.push(`Message ID: ${attachment.messageId}`);
    if (attachment.referencedText) details.push(`Reacted message: ${attachment.referencedText}`);
    return details.length ? `${type}. ${details.join(". ")}.` : `${type}.`;
  }

  const details = [];
  if (attachment.filename) details.push(`Filename: ${attachment.filename}`);
  if (attachment.mimeType) details.push(`MIME type: ${attachment.mimeType}`);
  if (attachment.size) details.push(`Size: ${attachment.size} bytes`);
  if (attachment.downloadedBytes) details.push(`Downloaded size: ${attachment.downloadedBytes} bytes`);
  if (attachment.sha256) details.push(`SHA-256: ${attachment.sha256}`);
  if (attachment.caption) details.push(`Caption: ${attachment.caption}`);
  if (attachment.localPath) details.push(`Local media path: ${attachment.localPath}`);
  if (attachment.mediaUri) details.push(`Media URI: ${attachment.mediaUri}`);
  if (attachment.url) details.push(`URL: ${attachment.url}`);
  if (attachment.id) details.push(`Media ID: ${attachment.id}`);
  if (attachment.downloadError) details.push(`Download error: ${attachment.downloadError}`);
  return details.length ? `${type} attachment. ${details.join(". ")}.` : `${type} attachment.`;
}

async function downloadAttachment(attachment) {
  if (!attachment.url || env("TELNYX_WABA_DOWNLOAD_ATTACHMENTS", "true").toLowerCase() === "false") return attachment;

  const mediaUrlPolicy = validateMediaUrl(attachment.url);
  if (!mediaUrlPolicy.ok) {
    return {
      ...attachment,
      downloadError: mediaUrlPolicy.reason || "media URL rejected",
    };
  }

  const timeout = envInt("TELNYX_WABA_MEDIA_DOWNLOAD_TIMEOUT_MS", DEFAULT_MEDIA_DOWNLOAD_TIMEOUT_MS);
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeout);
  timeoutHandle.unref?.();

  try {
    const saved = await saveRemoteMedia({
      url: attachment.url,
      filePathHint: mediaFilePathHint(attachment),
      maxBytes: envInt("TELNYX_WABA_MEDIA_MAX_BYTES", DEFAULT_MEDIA_MAX_BYTES),
      fallbackContentType: attachment.mimeType,
      originalFilename: attachment.filename,
      requestInit: {
        signal: controller.signal,
        headers: telnyxMediaHeaders(attachment.url),
      },
    });
    return {
      ...attachment,
      localPath: saved.path,
      mediaUri: mediaUriFromPath(saved.path),
      mimeType: attachment.mimeType || saved.contentType,
      downloadedBytes: saved.size,
    };
  } catch (err) {
    console.warn(`[telnyx-waba] Failed to download attachment ${attachment.id || attachment.url}:`, err);
    return {
      ...attachment,
      downloadError: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function resolveAttachments(payload) {
  const attachments = collectAttachments(payload);
  const resolved = [];
  for (const attachment of attachments) {
    if (attachment.type === "contact" || attachment.type === "reaction") {
      resolved.push(attachment);
      continue;
    }
    resolved.push(await downloadAttachment(attachment));
  }
  return resolved;
}

async function extractWhatsappMessage(payload) {
  const fromNumber = phoneNumber(payload.from || payload.from_number || payload.sender);
  const toNumber = phoneNumber(payload.to || payload.to_number || payload.recipient);
  const media = hasMedia(payload);
  rememberObservedMessageContexts(payload);
  const location = locationText(payload);
  const attachments = await resolveAttachments(payload);
  const attachmentsSummary = attachments.length > 0
    ? [
        `The user shared ${attachments.length === 1 ? "a WhatsApp attachment" : `${attachments.length} WhatsApp attachments`}:`,
        ...attachments.map((attachment, index) => `${index + 1}. ${attachmentLine(attachment)}`),
      ].join("\n")
    : null;
  const replyContext = replyContextText(payload);
  const directText = textValue(payload.text || payload.body);
  const partsText = Array.isArray(payload.parts) && payload.parts.length > 0 ? textValue(payload.parts) : null;
  const interactiveText = collectInteractiveTexts(payload).filter(Boolean).join("\n");
  const whatsappText = !location && !attachmentsSummary ? textValue(payload.whatsapp_message) : null;
  const observedText = collectObservedMessageTexts(payload).join("\n");
  let text = [replyContext, directText || partsText || whatsappText || interactiveText || observedText, location, attachmentsSummary].filter(Boolean).join("\n\n");
  if (!text && media) {
    text = "The user sent a WhatsApp media attachment, but Telnyx did not include readable attachment metadata.";
  }
  rememberMessageContext(payload, text);

  return {
    fromNumber,
    toNumber,
    text,
    media,
  };
}

function publicWebhookUrl(path) {
  const publicBaseUrl = env("PUBLIC_BASE_URL");
  return publicBaseUrl ? `${publicBaseUrl.replace(/\/$/, "")}${path}` : undefined;
}

async function askAgent(text, sessionId, channel) {
  const token = env("OPENCLAW_GATEWAY_TOKEN");
  if (!token) return "The OpenClaw agent is not connected yet.";

  const agent = env("OPENCLAW_AGENT", "main");
  const gatewayUrl = env("OPENCLAW_GATEWAY_URL", DEFAULT_GATEWAY_URL);
  const channelName = "WhatsApp";
  const assistantName = env("OPENCLAW_ASSISTANT_NAME", "the configured OpenClaw agent");
  const response = await fetch(`${gatewayUrl.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: env("OPENCLAW_MODEL", `openclaw/${agent}`),
      agent,
      messages: [
        {
          role: "system",
          content:
            `You are ${assistantName} replying by ${channelName}. Be brief, direct, and conversational. Keep continuity within this chat when possible. If the user sends attachments with local media paths or media URIs, inspect them with the available media tools before answering when the content matters. Use visible details such as captions, filenames, MIME types, contact fields, coordinates, media IDs, local paths, media URIs, and URLs. If the actual attachment content is not available after inspection, say exactly what you can see and ask what they want you to do with it.`,
        },
        { role: "user", content: text },
      ],
      metadata: { session_id: sessionId, source: "telnyx-waba" },
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenClaw reply failed: HTTP ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  return typeof content === "string" && content.trim()
    ? content.trim()
    : "I received that, but I could not produce a reply.";
}

async function sendWhatsapp(to, text) {
  const apiKey = env("TELNYX_API_KEY");
  const from = env("TELNYX_PHONE_NUMBER");
  if (!apiKey || !from) {
    throw new Error("TELNYX_API_KEY and TELNYX_PHONE_NUMBER are required");
  }

  const webhookUrl = publicWebhookUrl(WHATSAPP_ROUTE_PATH);
  const response = await fetch("https://api.telnyx.com/v2/messages/whatsapp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from,
      to,
      whatsapp_message: {
        type: "text",
        text: { body: text, preview_url: false },
      },
      ...(webhookUrl ? { webhook_url: webhookUrl } : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(`Telnyx WhatsApp send failed: HTTP ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function telnyxPost(path, body) {
  const apiKey = env("TELNYX_API_KEY");
  if (!apiKey) throw new Error("TELNYX_API_KEY is required");

  const response = await fetch(`https://api.telnyx.com/v2${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Telnyx POST ${path} failed: HTTP ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function answerCall(callControlId) {
  await telnyxPost(`/calls/${encodeURIComponent(callControlId)}/actions/answer`, {
    command_id: `answer-${randomUUID()}`,
  });
}

async function startAiAssistant(callControlId, prompt) {
  const assistantId = env("TELNYX_AI_ASSISTANT_ID");
  if (!assistantId) {
    console.warn("[telnyx-voice] TELNYX_AI_ASSISTANT_ID is not configured; call answered without assistant");
    return;
  }

  const body = {
    assistant: { id: assistantId },
    command_id: `assistant-${randomUUID()}`,
  };
  if (prompt) body.greeting = prompt;
  await telnyxPost(`/calls/${encodeURIComponent(callControlId)}/actions/ai_assistant_start`, body);
}

function decodePrompt(payload) {
  const clientState = payload.client_state;
  if (typeof clientState !== "string" || !clientState) return null;
  try {
    const data = JSON.parse(Buffer.from(clientState, "base64").toString("utf8"));
    return data?.prompt ? String(data.prompt) : null;
  } catch {
    return null;
  }
}

async function handleVoiceWebhook(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end("Method Not Allowed");
    return true;
  }

  const rawBody = await readBody(req);
  const signature = verifyTelnyxSignature(req.headers, rawBody);
  if (!signature.ok) {
    res.statusCode = 401;
    res.end(signature.reason || "Unauthorized");
    return true;
  }

  let body;
  try {
    body = JSON.parse(rawBody.toString("utf8") || "{}");
  } catch {
    writeJson(res, 400, { ok: false, error: "invalid_json" });
    return true;
  }

  const { eventType, payload } = payloadEvent(body);
  const callControlId = payload.call_control_id;
  const direction = String(payload.direction || payload.call_direction || "").toLowerCase();

  console.info(`[telnyx-voice] event=${eventType || "unknown"} call=${callControlId || "unknown"} direction=${direction || "unknown"}`);

  try {
    if (eventType === "call.initiated" && callControlId && (direction === "incoming" || direction === "inbound")) {
      const fromNumber = phoneNumber(payload.from || payload.from_number || payload.caller_id);
      if (!callerAllowed(fromNumber)) {
        console.warn(`[telnyx-voice] Ignoring non-allowlisted caller ${fromNumber}`);
        writeJson(res, 200, { ok: true, ignored: "caller_not_allowed" });
        return true;
      }
      await answerCall(String(callControlId));
    } else if (eventType === "call.answered" && callControlId) {
      await startAiAssistant(String(callControlId), decodePrompt(payload));
    }
  } catch (err) {
    console.error("[telnyx-voice] Failed to process voice webhook:", err);
    writeJson(res, 502, { ok: false, error: "telnyx_voice_failed" });
    return true;
  }

  writeJson(res, 200, { ok: true });
  return true;
}

function forwardedSmsHeaders(headers) {
  const forwarded = { "content-type": "application/json" };
  for (const name of ["telnyx-signature-ed25519", "telnyx-timestamp"]) {
    const value = headers[name];
    if (Array.isArray(value)) {
      if (value[0]) forwarded[name] = value[0];
    } else if (value) {
      forwarded[name] = value;
    }
  }
  return forwarded;
}

async function delegateSmsWebhook(req, res, rawBody) {
  const delegateUrl = env("TELNYX_SMS_DELEGATE_URL", DEFAULT_SMS_DELEGATE_URL);
  if (delegateUrl.toLowerCase() === "false" || delegateUrl.toLowerCase() === "off") {
    writeJson(res, 200, { ok: true, ignored: "sms_delegate_disabled" });
    return true;
  }

  let response;
  try {
    response = await fetch(delegateUrl, {
      method: "POST",
      headers: forwardedSmsHeaders(req.headers),
      body: rawBody,
    });
  } catch (err) {
    console.warn(`[telnyx-waba] SMS delegate ${delegateUrl} failed:`, err);
    writeJson(res, 200, { ok: true, ignored: "sms_delegate_unavailable" });
    return true;
  }

  const body = await response.text();
  if (response.status === 404 || response.status === 405) {
    writeJson(res, 200, { ok: true, ignored: "sms_delegate_unavailable" });
    return true;
  }

  res.statusCode = response.status;
  res.setHeader("content-type", response.headers.get("content-type") || "text/plain; charset=utf-8");
  res.end(body);
  return true;
}

async function replyToWhatsapp(fromNumber, text) {
  const reply = await askAgent(text, `telnyx-whatsapp:${normalizePhoneNumber(fromNumber)}`, "whatsapp");
  await sendWhatsapp(fromNumber, reply);
}

async function replyToWhatsappPayload(fromNumber, payload) {
  const { text } = await extractWhatsappMessage(payload);
  if (!text) {
    console.warn(
      `[telnyx-waba] Ignoring WhatsApp message from ${maskPhoneNumber(fromNumber)}: no text or downloadable attachment metadata; payload shape=${diagnosticPayloadShape(payload)}`,
    );
    return;
  }
  await replyToWhatsapp(fromNumber, text);
}

async function handleWhatsappWebhook(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end("Method Not Allowed");
    return true;
  }

  const rawBody = await readBody(req);
  const signature = verifyTelnyxSignature(req.headers, rawBody);
  if (!signature.ok) {
    res.statusCode = 401;
    res.end(signature.reason || "Unauthorized");
    return true;
  }

  let body;
  try {
    body = JSON.parse(rawBody.toString("utf8") || "{}");
  } catch {
    writeJson(res, 400, { ok: false, error: "invalid_json" });
    return true;
  }

  const { eventType, payload } = payloadEvent(body);
  if (eventType && eventType !== "message.received" && eventType !== "whatsapp.message.received") {
    writeJson(res, 200, { ok: true, ignored: eventType });
    return true;
  }

  const messageType = String(payload.type || payload.message_type || "").toUpperCase();
  if (messageType === "SMS") {
    return delegateSmsWebhook(req, res, rawBody);
  }

  const whatsappContentTypes = new Set(["TEXT", "IMAGE", "VIDEO", "AUDIO", "DOCUMENT", "STICKER", "LOCATION", "INTERACTIVE", "BUTTON", "CONTACTS", "CONTACT", "REACTION"]);
  if (messageType && messageType !== "WHATSAPP" && !whatsappContentTypes.has(messageType)) {
    writeJson(res, 200, { ok: true, ignored: messageType });
    return true;
  }

  const fromNumber = phoneNumber(payload.from || payload.from_number || payload.sender);
  if (!fromNumber) {
    writeJson(res, 200, { ok: true, ignored: "no_text" });
    return true;
  }

  if (!senderAllowed(fromNumber)) {
    console.warn(`[telnyx-waba] Ignoring non-allowlisted WhatsApp sender ${fromNumber}`);
    writeJson(res, 200, { ok: true, ignored: "sender_not_allowed" });
    return true;
  }

  setImmediate(() => {
    replyToWhatsappPayload(fromNumber, payload).catch((err) => {
      console.error(`[telnyx-waba] Failed to process WhatsApp message from ${fromNumber}:`, err);
    });
  });
  writeJson(res, 200, { ok: true });
  return true;
}

export default definePluginEntry({
  id: "telnyx-waba",
  name: "Telnyx WABA",
  description: "Telnyx Voice AI Assistant and WhatsApp Business API integration for OpenClaw",
  register(api) {
    api.registerHttpRoute({
      path: WHATSAPP_ROUTE_PATH,
      auth: "plugin",
      match: "exact",
      replaceExisting: true,
      handler: handleWhatsappWebhook,
    });
    api.registerHttpRoute({
      path: VOICE_ROUTE_PATH,
      auth: "plugin",
      match: "exact",
      replaceExisting: true,
      handler: handleVoiceWebhook,
    });
    console.info(`[telnyx-waba] Registered ${WHATSAPP_ROUTE_PATH}`);
    console.info(`[telnyx-voice] Registered ${VOICE_ROUTE_PATH}`);
  },
});
