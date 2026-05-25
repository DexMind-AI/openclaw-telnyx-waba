import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { Readable } from "node:stream";
import test from "node:test";

async function loadPluginInternals() {
  let code = await fs.readFile(new URL("../dist/index.js", import.meta.url), "utf8");
  code = code.replace(
    'import { defineChannelPluginEntry, createChatChannelPlugin, createChannelPluginBase } from "openclaw/plugin-sdk/channel-core";\n',
    [
      "const defineChannelPluginEntry = (entry) => entry;",
      "const createChatChannelPlugin = (plugin) => plugin;",
      "const createChannelPluginBase = (base) => base;",
      "",
    ].join("\n"),
  );
  code = code.replace(
    'import { createHybridChannelConfigBase } from "openclaw/plugin-sdk/channel-config-helpers";\n',
    "const createHybridChannelConfigBase = (config) => config;\n",
  );
  code = code.replace(
    'import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/direct-dm";\n',
    [
      "const dispatchInboundDirectDmWithRuntime = async (params) => {",
      "  globalThis.__telnyxWabaDispatches = globalThis.__telnyxWabaDispatches || [];",
      "  globalThis.__telnyxWabaDispatches.push(params);",
      '  await params.deliver({ text: "agent reply" });',
      '  return { route: { sessionKey: "test-session" }, storePath: "/tmp/session.jsonl", ctxPayload: {} };',
      "};",
      "",
    ].join("\n"),
  );
  code = code.replace(
    'import { saveRemoteMedia } from "openclaw/plugin-sdk/media-runtime";\n',
    [
      "const saveRemoteMedia = async (params) => ({",
      '  path: "/home/node/.openclaw/media/inbound/" + params.filePathHint + "---test-id",',
      '  contentType: params.fallbackContentType || "application/octet-stream",',
      "  size: 1234,",
      "});",
      "",
    ].join("\n"),
  );
  code = code.replace("export default defineChannelPluginEntry({", "globalThis.__plugin = defineChannelPluginEntry({");
  code += `
    globalThis.__telnyxWabaTest = {
      extractWhatsappMessage,
      dispatchWhatsappPayload,
      setTelnyxWabaRuntime,
      handleWhatsappWebhook,
      diagnosticPayloadShape,
      validateMediaUrl,
      publicWebhookUrl,
    };
  `;
  await import(`data:text/javascript,${encodeURIComponent(code)}`);
  return globalThis.__telnyxWabaTest;
}

test("extracts text and shared WhatsApp locations", async () => {
  const { extractWhatsappMessage } = await loadPluginInternals();

  const text = await extractWhatsappMessage({
    from: "+15551234567",
    whatsapp_message: { text: { body: "hello" } },
  });
  assert.equal(text.text, "hello");

  const location = await extractWhatsappMessage({
    from: "+15551234567",
    whatsapp_message: {
      location: {
        latitude: 48.85837,
        longitude: 2.294481,
        name: "Eiffel Tower",
        address: "Paris",
      },
    },
  });
  assert.match(location.text, /latitude 48\.85837, longitude 2\.294481/);
  assert.match(location.text, /Eiffel Tower/);

  const nestedLocation = await extractWhatsappMessage({
    from: { phone_number: "+15551234567" },
    type: "whatsapp",
    whatsapp: {
      messages: [
        {
          type: "location",
          location: {
            latitude: "51.5074",
            longitude: "-0.1278",
            url: "https://maps.google.com/?q=51.5074,-0.1278",
          },
        },
      ],
    },
  });
  assert.match(nestedLocation.text, /latitude 51\.5074, longitude -0\.1278/);
  assert.match(nestedLocation.text, /https:\/\/maps\.google\.com/);
});

test("downloads safe Telnyx media and exposes local media references", async () => {
  const { extractWhatsappMessage } = await loadPluginInternals();

  const message = await extractWhatsappMessage({
    from: "+15551234567",
    type: "MMS",
    text: "see this",
    media: [
      {
        url: "https://media.telnyx.com/messages/example-image.png",
        content_type: "image/png",
        sha256: "abc123",
        size: 102400,
      },
    ],
  });

  assert.match(message.text, /Local media path: \/home\/node\/\.openclaw\/media\/inbound\/example-image\.png---test-id/);
  assert.match(message.text, /Media URI: media:\/\/inbound\/example-image\.png---test-id/);
  assert.match(message.text, /Downloaded size: 1234 bytes/);

  const nestedMessage = await extractWhatsappMessage({
    from: { phone_number: "+15551234567" },
    type: "whatsapp",
    whatsapp: {
      messages: [
        {
          type: "image",
          image: {
            id: "a521caac-4127-4801-997d-f954af4d7154",
            link: "https://media.telnyx.com/messages/nested-image.jpg",
            mime_type: "image/jpeg",
            caption: "What do you see here",
          },
        },
      ],
    },
  });
  assert.match(nestedMessage.text, /Caption: What do you see here/);
  assert.match(nestedMessage.text, /Local media path: \/home\/node\/\.openclaw\/media\/inbound\/image-a521caac-4127-4801-997d-f954af4d7154---test-id/);
  assert.match(nestedMessage.text, /Media URI: media:\/\/inbound\/image-a521caac-4127-4801-997d-f954af4d7154---test-id/);
});

test("rejects unsafe media URLs before download", async () => {
  const { extractWhatsappMessage, validateMediaUrl } = await loadPluginInternals();

  assert.deepEqual(validateMediaUrl("http://media.telnyx.com/messages/example-image.png"), {
    ok: false,
    reason: "media URL must use https",
  });
  assert.deepEqual(validateMediaUrl("https://169.254.169.254/latest/meta-data"), {
    ok: false,
    reason: "private or reserved IP address is not allowed",
  });

  const message = await extractWhatsappMessage({
    from: "+15551234567",
    type: "MMS",
    media: [{ url: "https://example.com/image.png", content_type: "image/png" }],
  });
  assert.match(message.text, /Download error: host is not an allowed Telnyx media host: example\.com/);
  assert.doesNotMatch(message.text, /Local media path:/);
});

test("preserves contacts, reactions, and outbound webhook URL behavior", async () => {
  const { extractWhatsappMessage, publicWebhookUrl } = await loadPluginInternals();

  const message = await extractWhatsappMessage({
    from: "+15551234567",
    whatsapp_message: {
      contacts: [
        {
          name: { formatted_name: "Ada Lovelace" },
          phones: [{ phone: "+15557654321" }],
        },
      ],
      reaction: { emoji: "👍", message_id: "wamid.123" },
    },
  });

  assert.match(message.text, /Contact card\. Name: Ada Lovelace\. Phones: \+15557654321\./);
  assert.match(message.text, /Reaction\. Emoji: 👍\. Message ID: wamid\.123\./);
  assert.equal(publicWebhookUrl("/telnyx/whatsapp"), undefined);
});

test("reactions include the referenced message text when the message was seen", async () => {
  const { extractWhatsappMessage } = await loadPluginInternals();

  await extractWhatsappMessage({
    id: "wamid.reference-message",
    from: "+15551234567",
    type: "text",
    text: "Now I just hope he doesn't have to eject a warp core anytime soon. 🖖",
  });

  const reaction = await extractWhatsappMessage({
    from: "+15551234567",
    type: "reaction",
    reaction: {
      emoji: "😂",
      message_id: "wamid.reference-message",
    },
  });

  assert.match(reaction.text, /Reaction\. Emoji: 😂\. Message ID: wamid\.reference-message\./);
  assert.match(reaction.text, /Reacted message: Now I just hope he doesn't have to eject a warp core anytime soon\./);
});

test("replies include the referenced message text when the message was seen", async () => {
  const { extractWhatsappMessage } = await loadPluginInternals();

  await extractWhatsappMessage({
    id: "wamid.reply-parent",
    from: "+15551234567",
    type: "text",
    text: "The parent message Claudia should see.",
  });

  const reply = await extractWhatsappMessage({
    id: "wamid.reply-child",
    from: "+15551234567",
    type: "text",
    context: { id: "wamid.reply-parent" },
    text: "This is the reply body.",
  });

  assert.match(reply.text, /Replied-to message: The parent message Claudia should see\./);
  assert.match(reply.text, /This is the reply body\./);
});

test("reactions and replies resolve messages earlier in the same webhook payload", async () => {
  const { extractWhatsappMessage } = await loadPluginInternals();

  const message = await extractWhatsappMessage({
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  id: "wamid.same-payload-parent",
                  type: "text",
                  text: { body: "Same payload parent text." },
                },
                {
                  type: "reaction",
                  reaction: {
                    emoji: "😂",
                    message_id: "wamid.same-payload-parent",
                  },
                },
                {
                  id: "wamid.same-payload-reply",
                  type: "text",
                  context: { id: "wamid.same-payload-parent" },
                  text: { body: "Same payload reply body." },
                },
              ],
            },
          },
        ],
      },
    ],
  });

  assert.match(message.text, /Reacted message: Same payload parent text\./);
  assert.match(message.text, /Replied-to message: Same payload parent text\./);
  assert.match(message.text, /Same payload reply body\./);
});

test("WABA dispatches inbound messages through the OpenClaw direct-DM runtime", async () => {
  const previousApiKey = process.env.TELNYX_API_KEY;
  const previousPhoneNumber = process.env.TELNYX_PHONE_NUMBER;
  process.env.TELNYX_API_KEY = "test-api-key";
  process.env.TELNYX_PHONE_NUMBER = "+15557654321";
  const previousFetch = globalThis.fetch;
  const outbound = [];
  globalThis.__telnyxWabaDispatches = [];
  globalThis.fetch = async (url, init) => {
    outbound.push({ url: String(url), body: JSON.parse(init.body) });
    return {
      ok: true,
      async json() {
        return { data: { id: "outbound-message-id" } };
      },
    };
  };

  try {
    const { dispatchWhatsappPayload, setTelnyxWabaRuntime } = await loadPluginInternals();
    setTelnyxWabaRuntime({ channel: {} });
    await dispatchWhatsappPayload({}, "+1 (555) 123-4567", {
      id: "wamid.inbound",
      from: { phone_number: "+15551234567" },
      to: { phone_number: "+15557654321" },
      type: "text",
      text: "hello with native channel context",
    });

    assert.equal(globalThis.__telnyxWabaDispatches.length, 1);
    const dispatch = globalThis.__telnyxWabaDispatches[0];
    assert.equal(dispatch.channel, "telnyx-waba");
    assert.equal(dispatch.channelLabel, "WhatsApp");
    assert.deepEqual(dispatch.peer, { kind: "direct", id: "+15551234567" });
    assert.equal(dispatch.senderId, "+15551234567");
    assert.equal(dispatch.rawBody, "hello with native channel context");
    assert.equal(dispatch.bodyForAgent, "hello with native channel context");
    assert.equal(dispatch.messageId, "wamid.inbound");

    assert.equal(outbound.length, 1);
    assert.equal(outbound[0].url, "https://api.telnyx.com/v2/messages/whatsapp");
    assert.equal(outbound[0].body.to, "+1 (555) 123-4567");
    assert.equal(outbound[0].body.whatsapp_message.text.body, "agent reply");
  } finally {
    globalThis.fetch = previousFetch;
    delete globalThis.__telnyxWabaDispatches;
    if (previousApiKey === undefined) {
      delete process.env.TELNYX_API_KEY;
    } else {
      process.env.TELNYX_API_KEY = previousApiKey;
    }
    if (previousPhoneNumber === undefined) {
      delete process.env.TELNYX_PHONE_NUMBER;
    } else {
      process.env.TELNYX_PHONE_NUMBER = previousPhoneNumber;
    }
  }
});

test("WABA webhook delegates SMS payloads away from WABA processing", async () => {
  const previousDelegateUrl = process.env.TELNYX_SMS_DELEGATE_URL;
  process.env.TELNYX_SMS_DELEGATE_URL = "false";
  const { handleWhatsappWebhook } = await loadPluginInternals();
  const body = JSON.stringify({
    data: {
      event_type: "message.received",
      payload: {
        type: "SMS",
        from: { phone_number: "+15551234567" },
        text: "hello by sms",
      },
    },
  });
  const req = Readable.from([Buffer.from(body)]);
  req.method = "POST";
  req.headers = { "content-type": "application/json" };

  const headers = {};
  const res = {
    statusCode: 0,
    setHeader(name, value) {
      headers[name.toLowerCase()] = value;
    },
    end(payload) {
      this.body = payload;
    },
  };

  try {
    assert.equal(await handleWhatsappWebhook(req, res), true);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
      ok: true,
      ignored: "sms_delegate_disabled",
    });
  } finally {
    if (previousDelegateUrl === undefined) {
      delete process.env.TELNYX_SMS_DELEGATE_URL;
    } else {
      process.env.TELNYX_SMS_DELEGATE_URL = previousDelegateUrl;
    }
  }
});

test("diagnostic payload shape does not include scalar message contents", async () => {
  const { diagnosticPayloadShape } = await loadPluginInternals();
  const shape = diagnosticPayloadShape({
    whatsapp: {
      messages: [
        {
          type: "image",
          image: {
            caption: "private caption",
            id: "private-media-id",
          },
        },
      ],
    },
  });

  assert.match(shape, /"caption":"string"/);
  assert.match(shape, /"id":"string"/);
  assert.doesNotMatch(shape, /private caption/);
  assert.doesNotMatch(shape, /private-media-id/);
});
