# Telnyx WABA Plugin for OpenClaw

OpenClaw gateway plugin for Telnyx WhatsApp Business API and Telnyx Voice AI Assistant webhooks.

This package exists for deployments that use Telnyx WABA instead of OpenClaw's official WhatsApp Web/Baileys channel. It registers gateway-local HTTP routes and relays validated inbound messages into an OpenClaw agent through the gateway's OpenAI-compatible API.

## Routes

- `/telnyx/whatsapp`: receives Telnyx WhatsApp Business API webhooks. Plain SMS payloads are delegated to Telnyx's official `telnyx-sms` OpenClaw channel on `/telnyx-sms/webhook` when available.
- `/telnyx/voice`: receives Telnyx Call Control webhooks, answers allowed inbound calls, and starts the configured Telnyx AI Assistant.

## Message Handling

The WABA path preserves the useful details Telnyx provides:

- text and interactive replies;
- shared locations with latitude, longitude, optional name, and address;
- image, video, audio, document, and sticker metadata;
- media URLs, IDs, filenames, MIME types, sizes, hashes, and captions;
- contact cards and reactions.

When Telnyx provides a media URL, the plugin downloads it into OpenClaw's inbound media store with `saveRemoteMedia` and includes both the local path and `media://inbound/...` URI in the prompt. The agent can then inspect the media with the same tools used by native channels.

Media downloads use a defense-in-depth URL policy adapted from Telnyx's official SMS/MMS OpenClaw plugin: only HTTPS Telnyx media hosts are accepted, credentials in URLs are rejected, and localhost/private/metadata-service/IP-literal targets are blocked.

## Compatibility Corpus

The test suite includes a WABA fixture corpus in `test/fixtures/waba/` covering published Telnyx and Meta-style payload families:

- Telnyx Messaging `message.received` with `media[]` URLs.
- Telnyx WhatsApp media objects using `link` or `id`.
- Meta Cloud API `entry[].changes[].value.messages[]` wrappers for text, image, location, contact, reaction, and interactive replies.

When a future webhook extracts no agent-visible text, the plugin logs only a redacted payload key/type shape. Add that shape as a fixture before changing parser behavior.

## Environment

Required for WABA:

```sh
TELNYX_API_KEY=KEY...
TELNYX_PUBLIC_KEY=<base64-or-hex-ed25519-public-key>
TELNYX_PHONE_NUMBER=+15551234567
OPENCLAW_GATEWAY_TOKEN=<gateway-token>
```

Useful optional values:

```sh
PUBLIC_BASE_URL=https://agent.example.com
OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789
OPENCLAW_AGENT=main
OPENCLAW_MODEL=openclaw/main
OPENCLAW_ASSISTANT_NAME="the configured OpenClaw agent"
TELNYX_WHATSAPP_ALLOWED_NUMBERS=+15551234567,+15557654321
TELNYX_SMS_DELEGATE_URL=http://127.0.0.1:18789/telnyx-sms/webhook
TELNYX_WABA_DOWNLOAD_ATTACHMENTS=true
TELNYX_WABA_MEDIA_MAX_BYTES=26214400
TELNYX_WABA_MEDIA_DOWNLOAD_TIMEOUT_MS=10000
```

Voice AI Assistant values:

```sh
TELNYX_AI_ASSISTANT_ID=<telnyx-ai-assistant-id>
TELNYX_VOICE_ALLOWED_NUMBERS=+15551234567
```

## Install

From this repo:

```sh
npm install
npm run verify
npm pack --dry-run
```

Install into an OpenClaw gateway with the normal plugin install flow for the target environment, or sync this package into a gateway extension directory when operating a pinned deployment.

## Notes

- WABA is separate from OpenClaw's official `@openclaw/whatsapp` plugin, which uses WhatsApp Web/Baileys.
- Plain SMS/MMS should use Telnyx's official `telnyx-openclaw-sms-channel` plugin in parallel. This plugin can delegate SMS payloads there when Telnyx still points a shared messaging webhook at `/telnyx/whatsapp`.
- The plugin makes inbound media available to the agent; it does not itself run OCR, transcription, or image analysis.
