import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const html = read('public/index.html');
const css = read('public/style.css');
const shell = read('public/js/worlds-shell.js');
const shared = read('public/js/shell.js');
const core = read('public/js/core.js');
const worlds = read('public/js/worlds.js');
const i18n = read('public/js/i18n.js');
const publicationHandlers = ['openWorldPublicationConfirm', 'closeWorldPublicationConfirm', 'confirmWorldPublication', 'refreshWorldPublicationStatus'];
const tag = id => html.match(new RegExp(`<[^>]+\\bid="${id}"[^>]*>`))?.[0] || '';

test('publication controls remain inside the world editor and cannot submit metadata', () => {
  const start = html.indexOf('id="worldEditModal"');
  const end = html.indexOf('id="worldPublicationConfirmModal"', start);
  assert.ok(start >= 0 && end > start);
  const editor = html.slice(start, end);
  for (const [id, handler] of [['btnWorldPublicationAction', 'openWorldPublicationConfirm'], ['btnRefreshWorldPublication', 'refreshWorldPublicationStatus']]) {
    assert.ok(editor.includes(`id="${id}"`));
    assert.match(tag(id), /type="button"/);
    assert.ok(tag(id).includes(`onclick="${handler}()"`));
  }
  assert.match(tag('worldEditReleaseStatus'), /^<strong/);
  assert.match(tag('worldPublicationEligibility'), /role="status"/);
  assert.match(tag('worldPublicationEligibility'), /aria-live="polite"/);
  assert.doesNotMatch(editor, /data-i18n="world\.edit\.releaseStatus"/);
});

test('publication has its own cancellable confirmation rather than the irreversible-delete dialog', () => {
  const modal = tag('worldPublicationConfirmModal');
  assert.match(modal, /class="[^\"]*hidden/);
  assert.match(modal, /role="alertdialog"/);
  assert.match(modal, /aria-modal="true"/);
  assert.match(modal, /aria-describedby="worldPublicationConfirmWarning"/);
  assert.match(modal, /closeWorldPublicationConfirm\(\)/);
  assert.match(tag('btnCancelWorldPublication'), /closeWorldPublicationConfirm\(\)/);
  assert.match(tag('btnConfirmWorldPublication'), /type="button"/);
  assert.match(tag('btnConfirmWorldPublication'), /confirmWorldPublication\(\)/);
  assert.doesNotMatch(tag('btnConfirmWorldPublication'), /confirmWorldDeletion/);
  assert.match(core, /'worldPublicationConfirmModal': 'closeWorldPublicationConfirm'/);
  assert.match(css, /\.world-publication-actions\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(css, /#worldPublicationConfirmModal \.modal-content\s*\{[^}]*overflow-y:\s*auto/);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size, 'new publication markup must not duplicate existing IDs');
});

test('publication lazy wrappers dispatch only captured management handlers', async () => {
  const calls = [];
  const context = vm.createContext({
    VRCW: { modules: { worldManagement: Object.fromEntries(publicationHandlers.map(name => [name, (...args) => { calls.push([name, ...args]); return name; }])) } },
    _loadWorldsModule: async () => ({}),
    showToast: () => assert.fail('wrapper rejected'), t: key => key,
  });
  context.window = context;
  const dispatcherStart = shell.indexOf('function _callWorldManagement(');
  const dispatcherEnd = shell.indexOf('\nfunction _callWorld(', dispatcherStart);
  vm.runInContext(shell.slice(dispatcherStart, dispatcherEnd), context);
  for (const name of publicationHandlers) {
    const source = shell.match(new RegExp(`function ${name}\\(\\) \\{[^\\n]+\\}`))?.[0];
    assert.ok(source, name + ' has a resident wrapper');
    vm.runInContext(source, context);
    assert.equal(await context[name]('captured-argument'), name);
  }
  assert.deepEqual(calls, publicationHandlers.map(name => [name, 'captured-argument']));
});

test('world cache DTO preserves labs tags without changing cloud favorite membership or package metadata', () => {
  const start = shared.indexOf('function _worldBasicFromItem(');
  const end = shared.indexOf('\nasync function _removeFromListCache', start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({ worldFavoriteIdMap: new Map([['wrld_fake', 'favorite-record']]) });
  vm.runInContext(shared.slice(start, end), context);
  const original = { id: 'wrld_fake', releaseStatus: 'public', tags: ['author_tag_cozy', 'system_labs'], unityPackages: [{ platform: 'standalonewindows' }] };
  const dto = context._worldBasicFromItem(original);
  assert.equal(dto.releaseStatus, 'public');
  assert.deepEqual(dto.tags, original.tags);
  assert.equal(dto.favoriteId, 'favorite-record');
  assert.deepEqual(dto.unityPackages, original.unityPackages);
  assert.equal(context._worldBasicFromItem({ id: 'wrld_fake' }).tags, null);
  const localWriter = core.slice(core.indexOf('  async saveLocalWorld('), core.indexOf('  async removeLocalWorld('));
  assert.match(localWriter, /tags: Array\.isArray\(world\.tags\) \? world\.tags : \[\]/);
  assert.match(worlds, /w\.releaseStatus === 'public' && w\.tags\?\.includes\('system_labs'\) \? t\('world\.publication\.labs'\)/);
});

test('publication copy is translated with matching placeholders and v202 resources', () => {
  const context = vm.createContext({
    window: {}, document: { addEventListener() {}, querySelectorAll() { return []; }, documentElement: {} },
    localStorage: { getItem() { return 'zh'; }, setItem() {} }, navigator: { language: 'zh' },
    VRCW: { registerModule() {} }, renderAppVersionInfo() {},
  });
  vm.runInContext(i18n + '\nglobalThis.dictionaries = I18N;', context);
  const keys = ['title','status','private','public','labs','unknown','publish','unpublish','checking','refresh','unavailable','cannotPublish','managedState','checkFailed','confirmPublishTitle','confirmUnpublishTitle','publishWarning','unpublishWarning','publishConfirm','unpublishConfirm','publishing','unpublishing','publishFailed','unpublishFailed','changedRefreshFailed','outcomeUnknown','syncFailed','published','unpublished','stateChanged'];
  for (const suffix of keys) {
    const key = 'world.publication.' + suffix;
    const placeholders = [];
    for (const lang of ['en', 'zh', 'ja']) {
      const text = context.dictionaries[lang][key];
      assert.equal(typeof text, 'string', lang + ': ' + key);
      placeholders.push([...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort().join(','));
    }
    assert.equal(new Set(placeholders).size, 1, key + ' placeholders');
  }
  assert.equal(context.dictionaries.zh['world.publication.unpublish'].includes('撤回'), true);
  assert.match(context.dictionaries.en['world.publication.publishWarning'], /Labs/i);
  assert.match(context.dictionaries.en['world.publication.unpublishWarning'], /not.*delet|without.*delet/i);
  assert.doesNotMatch(html, /\?v=201|>v201</);
  assert.match(html, /id="appVersionBadge"[^>]*>v202</);
});
