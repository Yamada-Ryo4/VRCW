import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const core = readFileSync(new URL('../public/js/core.js', import.meta.url), 'utf8');
const common = readFileSync(new URL('../public/js/common.js', import.meta.url), 'utf8');
const logging = readFileSync(new URL('../public/js/logging.js', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('../public/js/i18n.js', import.meta.url), 'utf8');
const index = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('icon-prefixed messages render one safe icon and keep dynamic HTML as text', () => {
  const helperStart = core.indexOf('function appendIconText');
  const helperEnd = core.indexOf('function scriptUrlWithVersion', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helperSource = core.slice(helperStart, helperEnd);

  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.attributes = {};
      this.children = [];
    }
    setAttribute(name, value) {
      this.attributes[name] = value;
    }
    replaceChildren(...children) {
      this.children = children;
    }
  }

  const document = {
    createElement: tagName => new FakeElement(tagName),
    createTextNode: text => ({ nodeType: 3, textContent: text }),
  };
  const context = { document };
  runInNewContext(`${helperSource}; this.appendIconText = appendIconText;`, context);

  const target = new FakeElement('div');
  context.appendIconText(target, '<i class="fa-solid fa-check"></i> Updated <img src=x onerror=alert(1)>');
  assert.equal(target.children[0].tagName, 'i');
  assert.equal(target.children[0].attributes.class, 'fa-solid fa-check');
  assert.equal(target.children[1].textContent, ' Updated <img src=x onerror=alert(1)>');

  const invalid = new FakeElement('div');
  context.appendIconText(invalid, '<i class="fa-solid fa-check" onclick="alert(1)"></i> Unsafe');
  assert.equal(invalid.children.length, 1);
  assert.equal(invalid.children[0].textContent, '<i class="fa-solid fa-check" onclick="alert(1)"></i> Unsafe');
});

test('logs and toasts use the safe renderer without trusted HTML logging', () => {
  assert.match(core, /function showToast[\s\S]*?appendIconText\(el, msg\)/);
  assert.match(logging, /function logMsg[\s\S]*?appendIconText\(text, msg\)/);
  assert.match(common, /function friendLogMsg[\s\S]*?appendIconText\(d, msg,/);
  assert.match(common, /function worldLogMsg[\s\S]*?appendIconText\(d, msg,/);

  const publicJsUrl = new URL('../public/js/', import.meta.url);
  const scripts = readdirSync(publicJsUrl)
    .filter(name => name.endsWith('.js'))
    .map(name => readFileSync(new URL(name, publicJsUrl), 'utf8'))
    .join('\n');
  assert.doesNotMatch(scripts, /\blogMsgHtml\s*\(/);
});

test('text-only sink icon translation uses a leading prefix', () => {
  for (const label of ['Boop sent', '已发送戳一下', 'Boop を送信しました']) {
    assert.match(
      i18n,
      new RegExp(`"toast\\.boopSent":\\s*['"]<i class=\\\\?"fa-solid fa-hand\\\\?"><\\/i> ${label}['"]`),
    );
  }
});

test('pure deployment cache version advances to v182', () => {
  assert.match(index, /id="appVersionBadge">v182</);
  assert.match(index, /js\/core\.js\?v=182/);
  assert.match(index, /js\/i18n\.js\?v=182/);
  assert.match(index, /js\/common\.js\?v=182/);
  assert.match(index, /js\/logging\.js\?v=182/);
  assert.doesNotMatch(index, /\?v=181/);
});
