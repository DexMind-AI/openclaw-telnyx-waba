import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
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
      '  path: "/home/node/.openclaw/media/inbound/" + params.filePathHint + "---corpus-id",',
      '  contentType: params.fallbackContentType || "application/octet-stream",',
      "  size: 2345,",
      "});",
      "",
    ].join("\n"),
  );
  code = code.replace("export default definePluginEntry({", "globalThis.__plugin = definePluginEntry({");
  code += `
    globalThis.__telnyxWabaCorpusTest = {
      extractWhatsappMessage,
    };
  `;
  await import(`data:text/javascript,${encodeURIComponent(code)}`);
  return globalThis.__telnyxWabaCorpusTest;
}

async function loadFixtures() {
  const fixturesDir = new URL("./fixtures/waba/", import.meta.url);
  const entries = await fs.readdir(fixturesDir);
  const fixtures = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json")) continue;
    const file = new URL(entry, fixturesDir);
    fixtures.push({
      file: path.basename(file.pathname),
      ...(JSON.parse(await fs.readFile(file, "utf8"))),
    });
  }
  return fixtures;
}

test("published WABA compatibility corpus normalizes into agent-visible text", async (t) => {
  const { extractWhatsappMessage } = await loadPluginInternals();
  const fixtures = await loadFixtures();
  assert.ok(fixtures.length >= 5, "expected WABA compatibility fixtures");

  for (const fixture of fixtures) {
    await t.test(fixture.name || fixture.file, async () => {
      const result = await extractWhatsappMessage(fixture.payload);
      const text = result.text || "";

      for (const expected of fixture.expectedTextIncludes || []) {
        assert.match(text, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${fixture.file} missing ${expected}\n${text}`);
      }
      for (const excluded of fixture.expectedTextExcludes || []) {
        assert.doesNotMatch(text, new RegExp(excluded.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${fixture.file} unexpectedly included ${excluded}\n${text}`);
      }
    });
  }
});
