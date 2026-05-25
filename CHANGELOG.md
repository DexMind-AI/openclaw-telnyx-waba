# Changelog

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
