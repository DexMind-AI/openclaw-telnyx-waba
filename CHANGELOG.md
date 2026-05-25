# Changelog

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
