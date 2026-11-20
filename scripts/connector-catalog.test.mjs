import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';

const bundle = await build({
    entryPoints: [new URL('../webview/shared/connector-catalog.ts', import.meta.url).pathname],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'LumoConnectorCatalog',
    platform: 'browser',
});

const context = {};
vm.runInNewContext(bundle.outputFiles[0].text, context);
const { BUILTIN_CONNECTORS } = context.LumoConnectorCatalog;

test('every registered built-in connector has a catalog entry', () => {
    assert.deepEqual(
        Array.from(BUILTIN_CONNECTORS, (entry) => entry.id),
        ['filesystem', 'bash', 'browser', 'proton_mail', 'luminance'],
    );
});

test('browser catalog entry matches the registered connector', () => {
    const browser = BUILTIN_CONNECTORS.find((entry) => entry.id === 'browser');
    assert.ok(browser, 'browser must be listed in BUILTIN_CONNECTORS');
    assert.equal(browser.category, 'device');
    assert.equal(browser.name, 'Browser');
    assert.equal(browser.description, 'Fetch and read web pages.');
    assert.equal(browser.iconSrc, 'images/connectors/browser.svg');
});
