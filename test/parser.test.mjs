import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { Readable } from "node:stream";
import test from "node:test";

async function loadPluginInternals() {
  let code = await fs.readFile(new URL("../dist/index.js", import.meta.url), "utf8");
  code = code.replace(
    'import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";\n',
    "const definePluginEntry = (entry) => entry;\n",
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
  code = code.replace("export default definePluginEntry({", "globalThis.__plugin = definePluginEntry({");
  code += `
    globalThis.__telnyxWabaTest = {
      extractWhatsappMessage,
      handleWhatsappWebhook,
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
