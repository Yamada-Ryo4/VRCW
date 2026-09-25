import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const commonSource = await readFile(new URL('../public/js/common.js', import.meta.url), 'utf8');
const shellSource = await readFile(new URL('../public/js/shell.js', import.meta.url), 'utf8');
const commonModules = {};
const commonContext = {
  URL,
  document: { addEventListener() {} },
  VRCW: { registerModule(name, module) { commonModules[name] = module; } },
  renderAppVersionInfo() {},
  // common.js touches shared globals from core.js at module scope; stub the
  // ones its startup path reaches so the parser under test can be loaded.
  idb: { async get() { return null; }, async set() {}, async keys() { return []; } },
  worldNameCache: new Map(),
};
runInNewContext(commonSource, commonContext, { filename: 'public/js/common.js' });
assert.equal(typeof commonModules.common?.parseDirectOpenId, 'function', 'common.js exports parseDirectOpenId');
const parseDirectOpenId = input => {
  const parsed = commonModules.common.parseDirectOpenId(input);
  return parsed ? { type: parsed.type, id: parsed.id } : null;
};
const validId = 'wrld_12345678-1234-1234-1234-123456789abc';

test('direct-open parser accepts an exact naked world ID', () => {
  assert.deepEqual(parseDirectOpenId(validId), {type:'wrld', id:validId});
  assert.deepEqual(parseDirectOpenId(`  ${validId}  `), {type:'wrld', id:validId});
});

test('direct-open parser accepts an HTTPS VRChat world URL and returns only parsed ID data', () => {
  assert.deepEqual(parseDirectOpenId(`https://vrchat.com/home/world/${validId}`), {type:'wrld', id:validId});
  assert.deepEqual(parseDirectOpenId(`https://VRCHAT.com/home/world/${validId}`), {type:'wrld', id:validId});
});

test('direct-open parser handles exact avatar and user IDs with correct types', () => {
  const avatarId = validId.replace('wrld_', 'avtr_');
  const userId = validId.replace('wrld_', 'usr_');
  assert.deepEqual(parseDirectOpenId(avatarId), {type:'avtr', id:avatarId});
  assert.deepEqual(parseDirectOpenId(userId), {type:'usr', id:userId});
});

test('direct-open URL paths must match the supported VRChat entity type', () => {
  assert.deepEqual(parseDirectOpenId(`https://vrchat.com/home/avatar/${validId.replace('wrld_', 'avtr_')}`), {type:'avtr', id:validId.replace('wrld_', 'avtr_')});
  assert.deepEqual(parseDirectOpenId(`https://vrchat.com/home/user/${validId.replace('wrld_', 'usr_')}`), {type:'usr', id:validId.replace('wrld_', 'usr_')});
});

test('direct world parser rejects non-exact IDs, unrelated hosts, and unsafe URL forms', () => {
  const invalid = [
    `${validId}/extra`,
    `prefix-${validId}`,
    `http://vrchat.com/home/world/${validId}`,
    `https://evil.example/home/world/${validId}`,
    `https://vrchat.com.evil.example/home/world/${validId}`,
    `https://www.vrchat.com/home/world/${validId}`,
    `https://user@vrchat.com/home/world/${validId}`,
    `https://vrchat.com:444/home/world/${validId}`,
    `https://vrchat.com/home/world/${validId}?next=https://evil.example`,
    `https://vrchat.com/home/world/${validId}#${validId}`,
    `https://vrchat.com/home/world/${validId}/${validId}`,
    `https://vrchat.com/home/avatar/${validId}`,
    `https://vrchat.com/home/world/${validId.replace('wrld_', 'avtr_')}`,
    'wrld_not-a-valid-id',
    'https://vrchat.com/home/world/wrld_12345678-1234-1234-1234-123456789abz',
  ];
  for (const value of invalid) assert.equal(parseDirectOpenId(value), null, value);
});

test('direct-open UI is available from expanded, collapsed, and mobile navigation', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<button(?=[^>]*id="navItemDirectOpen")(?=[^>]*onclick="openDirectOpenModal\(\)")[^>]*>/);
  const collapsedStart = html.indexOf('id="globalNavCollapsed"');
  const collapsedEnd = html.indexOf('<div class="main-content"', collapsedStart);
  const collapsedNav = html.slice(collapsedStart, collapsedEnd);
  assert.match(collapsedNav, /<button(?=[^>]*id="navIconDirectOpen")(?=[^>]*onclick="openDirectOpenModal\(\)")[^>]*>/);
  assert.match(html, /<button(?=[^>]*id="mobileDirectOpenBtn")(?=[^>]*onclick="openDirectOpenModal\(\)")[^>]*>/);
  assert.equal((html.match(/id="navItemDirectOpen"/g) || []).length, 1);
  assert.equal((html.match(/id="navIconDirectOpen"/g) || []).length, 1);
  assert.equal((html.match(/id="mobileDirectOpenBtn"/g) || []).length, 1);
  assert.match(html, /id="directOpenModal"[\s\S]*?id="directOpenInput"/);
  assert.equal((html.match(/id="directOpenModal"/g) || []).length, 1);
  assert.equal((html.match(/id="directOpenInput"/g) || []).length, 1);
  assert.match(html, /<button(?=[^>]*id="worldDetailCloseBtn")(?=[^>]*onclick="closeWorldDetail\(\)")[^>]*>/);
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const mobileCssStart = css.indexOf('@media (max-width: 768px)', css.indexOf('@media (max-width: 768px)') + 1);
  const mobileCss = css.slice(mobileCssStart);
  assert.match(mobileCss, /#worldDetailDeleteBtn\s*,\s*#worldDetailCloseBtn\s*\{\s*display:\s*flex !important/);
  assert.match(mobileCss, /#worldDetailLocalFavBtn\s*,[\s\S]*?#worldDetailJoinBtn\s*\{\s*display:\s*none !important/);
  assert.doesNotMatch(mobileCss, /world-detail-header-btns \.btn-icon:not\(\[title=/, 'mobile CSS does not depend on localized title text');
  const mobileActions = html.slice(html.indexOf('class="world-detail-mobile-actions"'), html.indexOf('id="worldDetailFavStatus"'));
  assert.match(mobileActions, /<button(?=[^>]*id="worldDetailMobileLocalFavBtn")(?=[^>]*onclick="toggleWorldLocalFavorite\(\)")[^>]*>/);
  assert.match(mobileActions, /<button(?=[^>]*id="worldDetailFavBtn")(?=[^>]*onclick="toggleWorldFavMenu\(event\)")[^>]*>/);
  assert.match(mobileActions, /onclick="joinWorldInstance\(\)"/);
  assert.match(mobileActions, /<button(?=[^>]*id="worldDetailMobileDownloadBtn")(?=[^>]*onclick="downloadCurrentWorld\(\)")[^>]*>/);
  assert.match(shellSource, /document\.activeElement/);
  assert.match(shellSource, /requestAnimationFrame\(\(\) => input\.focus\(\)\)/);
  assert.match(shellSource, /function submitDirectOpen\(\)/);
  assert.match(shellSource, /parseDirectOpenId\(input\?\.value\)/);
  const core = readFileSync(new URL('../public/js/core.js', import.meta.url), 'utf8');
  assert.match(core, /'directOpenModal': 'closeDirectOpenModal'/);
});

test('local world favorites use IndexedDB v5 and a separate local_worlds object store', async () => {
  const core = await readFile(new URL('../public/js/core.js', import.meta.url), 'utf8');
  assert.match(core, /indexedDB\.open\("vrcw_DB", 5\)/);
  assert.match(core, /createObjectStore\("local_worlds", \{ keyPath: "id" \}\)/);
  assert.match(core, /async getLocalWorlds\(\)/);
  assert.match(core, /async saveLocalWorld\(world\)/);
  assert.match(core, /async removeLocalWorld\(id\)/);
  assert.match(core, /transaction\("local_worlds"/);
  const worlds = await readFile(new URL('../public/js/worlds.js', import.meta.url), 'utf8');
  assert.match(worlds, /if \(category === 'local'\)/);
});

test('local world favorites stay separate from cloud favorite group mutation code', async () => {
  const worlds = await readFile(new URL('../public/js/worlds.js', import.meta.url), 'utf8');
  const core = await readFile(new URL('../public/js/core.js', import.meta.url), 'utf8');
  assert.match(worlds, /localWorldIdMap\.has\(world\.id\)/);
  assert.match(worlds, /toggleWorldLocalFavorite\(/);
  assert.match(worlds, /quickWorldFav\(/);
  assert.match(worlds, /quickWorldLocalFav\(/);
  assert.match(core, /idb\.saveLocalWorld\(record\)/);
  assert.doesNotMatch(core.match(/async function saveToLocalWorldFavorite[\s\S]*?\n}\n/)?.[0] || '', /\/api\/vrc\/favorites/);
});
