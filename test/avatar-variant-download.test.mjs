import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../public/js/avatars.js', import.meta.url), 'utf8');
const start = source.indexOf('async function downloadSingleAvatar(');
const end = source.indexOf('// ── Upload Mode Toggle ──', start);
assert.ok(start >= 0 && end > start, 'downloadSingleAvatar source found');
const fnSource = source.slice(start, end);

function harness({ fresh, responses = [], useSaveDir = true } = {}) {
  const requested = [];
  const anchorClicks = [];
  const logs = [];
  const queue = [...responses];
  const saveDirHandle = useSaveDir ? {
    name: 'VRCW',
    queryPermission: async () => 'granted',
    getFileHandle: (name, options = {}) => {
      if (options.create) return { createWritable: async () => ({ write() {}, close() {} }) };
      const error = new Error('NotFoundError');
      error.name = 'NotFoundError';
      throw error;
    },
  } : null;
  const context = vm.createContext({
    console: { warn() {} },
    document: {
      getElementById: () => null,
      createElement: () => ({
        style: {}, href: '', download: '',
        click() { anchorClicks.push({ href: this.href, download: this.download }); },
      }),
      body: { appendChild() {}, removeChild() {} },
    },
    t: key => key,
    logMsg: (message, type) => logs.push({ message, type }),
    fetchOfficialAvatarData: async () => fresh,
    saveDirHandle,
    API_BASE: 'https://proxy.test',
    vrcAuth: 'synthetic-auth',
    fetch: async url => {
      requested.push(String(url));
      if (queue.length) {
        const reply = queue.shift();
        return { ok: false, status: reply.status, text: async () => reply.body };
      }
      return {
        ok: true, status: 200,
        headers: { get: () => 'application/octet-stream' },
        blob: async () => ({ size: 50000 }),
      };
    },
  });
  vm.runInContext(fnSource + '\nglobalThis.downloadSingleAvatar = downloadSingleAvatar;', context);
  return { context, requested, logs, anchorClicks };
}

const downloadUrl = proxyUrl => new URL(proxyUrl).searchParams.get('url');
const pkg = (platform, variant, assetUrl) => ({ platform, variant, assetUrl });
const base = 'https://api.vrchat.cloud/api/1/file';

test('a security-only PC package downloads the plain /file path, never variant/security', async () => {
  const fresh = {
    id: 'avtr_1', name: 'Sec Only',
    unityPackages: [pkg('standalonewindows', 'security', `${base}/file_1/3/variant/security`)],
  };
  const h = harness({ fresh });
  await h.context.downloadSingleAvatar({ id: 'avtr_1', name: 'Sec Only' });
  assert.equal(h.requested.length, 1);
  assert.equal(downloadUrl(h.requested[0]), `${base}/file_1/3/file`);
  assert.doesNotMatch(h.requested[0], /variant%2Fsecurity|variant\/security/);
});

test('plain and security packages of the same file collapse into one /file request', async () => {
  const fresh = {
    id: 'avtr_2', name: 'Both',
    unityPackages: [
      pkg('standalonewindows', 'security', `${base}/file_2/7/variant/security`),
      pkg('standalonewindows', '', `${base}/file_2/7/file`),
    ],
  };
  const h = harness({ fresh });
  await h.context.downloadSingleAvatar({ id: 'avtr_2', name: 'Both' });
  assert.equal(h.requested.length, 1);
  assert.equal(downloadUrl(h.requested[0]), `${base}/file_2/7/file`);
});

test('impostor packages stay skipped and distinct candidates retry in order', async () => {
  const fresh = {
    id: 'avtr_3', name: 'Retry',
    unityPackages: [
      pkg('standalonewindows', 'security', `${base}/file_1/3/variant/security`),
      pkg('standalonewindows', 'impostor', `${base}/file_1/3/variant/impostor`),
      pkg('standalonewindows', '', `${base}/file_9/2/file`),
    ],
  };
  const h = harness({ fresh, responses: [{ status: 403, body: 'AccessDenied' }] });
  await h.context.downloadSingleAvatar({ id: 'avtr_3', name: 'Retry' });
  assert.deepEqual(h.requested.map(downloadUrl), [`${base}/file_9/2/file`, `${base}/file_1/3/file`]);
  assert.ok(h.logs.some(log => log.type === 'success'));
});

test('quest security variants fall back to their /file path when no PC package exists', async () => {
  const fresh = {
    id: 'avtr_4', name: 'Quest',
    unityPackages: [
      pkg('android', 'security', `${base}/file_4/1/variant/security`),
      pkg('android', '', `${base}/file_4/1/file`),
    ],
  };
  const h = harness({ fresh });
  await h.context.downloadSingleAvatar({ id: 'avtr_4', name: 'Quest' });
  assert.equal(h.requested.length, 1);
  assert.equal(downloadUrl(h.requested[0]), `${base}/file_4/1/file`);
});

test('a root legacy assetUrl holding variant/security is rewritten too', async () => {
  const fresh = {
    id: 'avtr_5', name: 'Legacy',
    assetUrl: `${base}/file_5/8/variant/security`,
    unityPackages: [],
  };
  const h = harness({ fresh });
  await h.context.downloadSingleAvatar({ id: 'avtr_5', name: 'Legacy' });
  assert.equal(h.requested.length, 1);
  assert.equal(downloadUrl(h.requested[0]), `${base}/file_5/8/file`);
});

test('browser-default download also uses the rewritten first candidate', async () => {
  const fresh = {
    id: 'avtr_6', name: 'Anchor',
    unityPackages: [pkg('standalonewindows', 'security', `${base}/file_6/2/variant/security`)],
  };
  const h = harness({ fresh, useSaveDir: false });
  await h.context.downloadSingleAvatar({ id: 'avtr_6', name: 'Anchor' });
  assert.equal(h.requested.length, 0);
  assert.equal(h.anchorClicks.length, 1);
  assert.equal(downloadUrl(h.anchorClicks[0].href), `${base}/file_6/2/file`);
  assert.match(h.anchorClicks[0].download, /^Anchor_avtr_6\.vrca$/);
});

test('source keeps the plain-path contract and never requests variant/security by default', () => {
  assert.match(fnSource, /downloadAssetUrl = url =>/);
  assert.match(fnSource, /url\.split\('\/variant\/security'\)\.join\('\/file'\)/);
  assert.doesNotMatch(fnSource, /unshift\(pkg\.assetUrl\)|push\(pkg\.assetUrl\)/);
});
