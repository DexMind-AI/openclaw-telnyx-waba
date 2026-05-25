# Changelog

## Unreleased

- Added regression coverage for real Telnyx storage media URLs, media-runtime download parameters, webhook failure modes, shape-only diagnostics, OpenClaw channel metadata, and prevention of channel-local model relay dependencies.

## 0.2.1

- Allowed Telnyx WABA media URLs from `telnyxcloudstorage.com` so real photo/audio attachments download into OpenClaw's inbound media store instead of forcing agent-side `/tmp` workarounds.
- Preserved the normalized sender as the direct-DM outbound target so generic `message` tool sends default back to the WhatsApp user, not the gateway's WABA number.
- Normalized WABA dispatches to the default channel account.

## 0.2.0

- Converted WABA inbound handling from a custom OpenAI-compatible chat-completions relay to OpenClaw's standard channel/direct-DM runtime.
- Removed WABA's `OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_AGENT`, and `OPENCLAW_MODEL` dependency path; model selection and session continuity are now owned by OpenClaw.
- WABA direct chats now use normalized WhatsApp sender IDs as OpenClaw conversation IDs, matching the official Telnyx SMS channel pattern.

## 0.1.10

- Added bounded per-session conversation history for WABA agent calls so each WhatsApp sender keeps continuity across stateless webhook deliveries.
- Agent requests now include prior user/assistant turns for the same normalized WhatsApp sender while keeping different senders isolated.

## 0.1.9

- Added bounded observed-message context for WABA reactions and replies.
- Reactions now include the referenced message text when the target message passed through the gateway.
- Replies now include the referenced message text when the parent message passed through the gateway.
- Batched Meta-style webhook payloads now resolve reactions and replies against messages earlier in the same payload.

## 0.1.8

- Added a published-shape WABA compatibility corpus covering Telnyx and Meta-style text, media, location, contact, reaction, and interactive payload families.
- Added privacy-safe unknown-payload diagnostics that log only payload key/type shape when extraction produces no agent-visible text.
- Preserved nested interactive button/list replies as agent-visible text.

## 0.1.7

- Widened WABA media detection and attachment collection to find image/video/audio/document/sticker payloads under nested Telnyx/Meta wrapper objects.

## 0.1.6

- Widened WABA location detection to find latitude/longitude pairs under any nested Telnyx/Meta wrapper instead of only a fixed list of wrapper keys.

## 0.1.5

- Removed plain SMS reply handling so deployments can use Telnyx's official `telnyx-openclaw-sms-channel` in parallel.
- WABA route now delegates `SMS` payloads to `TELNYX_SMS_DELEGATE_URL`, defaulting to the official channel route at `http://127.0.0.1:18789/telnyx-sms/webhook`.
- Removed `TELNYX_SMS_ALLOWED_NUMBERS` from the plugin env contract.

## 0.1.4

- Extracted the Claudia-local Telnyx WABA plugin into a reusable OpenClaw plugin package.
- Removed Claudia-specific defaults from prompt text and outbound webhook URL construction.
- Added Telnyx media URL safety checks before downloading WABA attachments into OpenClaw's inbound media store.
- Added package verification scripts and parser/media regression tests.

## 0.1.3

- Downloaded Telnyx-provided WABA media URLs into OpenClaw's inbound media store.
- Included local media paths and `media://inbound/...` URIs in prompts.

## 0.1.2

- Expanded WABA attachment parsing for media arrays, WhatsApp media objects, contacts, reactions, and locations.

## 0.1.1

- Added shared-location payload parsing.

## 0.1.0

- Initial Telnyx WABA/SMS/Voice gateway plugin.
