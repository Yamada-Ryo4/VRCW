import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Minimal DOM stub sufficient for glass-select logic. ui-controls.js references
// document/window APIs at call time, not load time, so a tiny shim lets us load
// it and exercise setGlassSelectValue without a browser or jsdom dependency.

function makeEl(tag, props = {}) {
  const el = {
    tagName: String(tag).toUpperCase(),
    style: {},
    attributes: {},
    children: [],
    _childrenByTag: {},
    _childrenByClass: {},
    _text: '',
  };
  const initialClass = props.attributes?.class || props.class;
  const classSet = new Set(initialClass ? String(initialClass).split(/\s+/).filter(Boolean) : []);
  el.classList = {
    add(c) { classSet.add(c); },
    remove(c) { classSet.delete(c); },
    contains(c) { return classSet.has(c); },
    toggle(c, force) { if (force === undefined) force = !classSet.has(c); force ? classSet.add(c) : classSet.delete(c); return force; },
  };
  Object.assign(el, props);
  if (initialClass) el.attributes.class = String(initialClass);
  el.setAttribute = (k, v) => { el.attributes[k] = String(v); };
  el.getAttribute = (k) => (k in el.attributes ? el.attributes[k] : null);
  el.removeAttribute = (k) => { delete el.attributes[k]; };
  el.appendChild = (child) => { el.children.push(child); child.parentNode = el; indexChild(el, child); return child; };
  el.insertBefore = (child, ref) => { el.children.push(child); child.parentNode = el; indexChild(el, child); return child; };
  el.removeChild = (child) => { el.children = el.children.filter(c => c !== child); unindexChild(el, child); return child; };
  el.querySelector = (sel) => querySelector(el, sel);
  el.querySelectorAll = (sel) => querySelectorAll(el, sel);
  el.closest = () => null;
  Object.defineProperty(el, 'textContent', {
    get() { return el._text; },
    set(v) { el._text = String(v); },
  });
  return el;
}

function indexChild(parent, child) {
  const tag = child.tagName;
  (parent._childrenByTag[tag] ||= []).push(child);
}
function unindexChild(parent, child) {
  const arr = parent._childrenByTag[child.tagName];
  if (arr) parent._childrenByTag[child.tagName] = arr.filter(c => c !== child);
}
function querySelector(el, sel) {
  return querySelectorAll(el, sel)[0] || null;
}
function querySelectorAll(el, sel) {
  const out = [];
  if (sel.startsWith('.')) {
    const cls = sel.slice(1);
    walk(el, n => { if (n.classList && n.classList.contains(cls)) out.push(n); });
  } else if (sel.startsWith('input[')) {
    walk(el, n => { if (n.tagName === 'INPUT') out.push(n); });
  } else {
    walk(el, n => { if (n.tagName === String(sel).toUpperCase()) out.push(n); });
  }
  return out;
}
function walk(node, fn) {
  for (const c of node.children || []) { fn(c); walk(c, fn); }
}

// Build the edit-status glass-select DOM mirroring public/index.html.
function buildEditStatusSelect() {
  const select = makeEl('div', { class: 'glass-select' });
  const trigger = makeEl('div', { class: 'glass-select-trigger' });
  const label = makeEl('span', { class: 'selected-label' }); label.attributes['data-i18n'] = 'filterPrivate'; label._text = 'Private';
  trigger.appendChild(label);
  const chevron = makeEl('span', { class: 'chevron' });
  trigger.appendChild(chevron);
  select.appendChild(trigger);

  const options = makeEl('div', { class: 'glass-select-options' });
  const optPrivate = makeEl('div', { class: 'glass-option selected' }); optPrivate.attributes['data-i18n'] = 'filterPrivate'; optPrivate._text = 'Private';
  const optPublic = makeEl('div', { class: 'glass-option' }); optPublic.attributes['data-i18n'] = 'filterPublic'; optPublic._text = 'Public';
  options.appendChild(optPrivate); options.appendChild(optPublic);
  select.appendChild(options);

  const input = makeEl('input'); input.tagName = 'INPUT'; input.attributes.type = 'hidden'; input.attributes.id = 'editStatus'; input.value = 'private';
  select.appendChild(input);

  return { select, label, optPrivate, optPublic, input };
}

const sandbox = {
  window: {},
  document: {
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createComment() { return makeEl('!--'); },
    body: makeEl('body'),
  },
  VRCW: { _mods: {}, registerModule(name, api) { this._mods[name] = api; } },
};

// Load ui-controls.js into the sandbox (no t() needed for value sync path).
const src = readFileSync(new URL('../public/js/ui-controls.js', import.meta.url), 'utf8');
const factory = new Function('window', 'document', 't', 'VRCW', 'renderAppVersionInfo', src + '\n;return { setGlassSelectValue: typeof setGlassSelectValue === "function" ? setGlassSelectValue : undefined, getGlassSelectOptions: typeof getGlassSelectOptions === "function" ? getGlassSelectOptions : undefined };');
const exported = factory(sandbox.window, sandbox.document, () => null, sandbox.VRCW, () => {});

test('setGlassSelectValue is exported from ui-controls.js', () => {
  assert.equal(typeof exported.setGlassSelectValue, 'function', 'setGlassSelectValue must exist so programmatic value changes sync the visible label and selected option');
});

test('setGlassSelectValue updates label, selected class, and hidden input for public', () => {
  assert.equal(typeof exported.getGlassSelectOptions, 'function');
  const { select, label, optPrivate, optPublic, input } = buildEditStatusSelect();

  // Real call path: editAvatar now does setGlassSelectValue(select, av.releaseStatus).
  exported.setGlassSelectValue(select, 'public');

  assert.equal(input.value, 'public', 'hidden input holds the synced value');
  assert.equal(label.textContent, 'Public', 'visible trigger label reflects the synced option');
  assert.equal(optPublic.classList.contains('selected'), true, 'public option is marked selected');
  assert.equal(optPrivate.classList.contains('selected'), false, 'private option is no longer marked selected');
});

test('setGlassSelectValue falls back to private when value is private', () => {
  const { select, label, optPrivate, optPublic, input } = buildEditStatusSelect();
  exported.setGlassSelectValue(select, 'private');
  assert.equal(input.value, 'private');
  assert.equal(label.textContent, 'Private');
  assert.equal(optPrivate.classList.contains('selected'), true);
  assert.equal(optPublic.classList.contains('selected'), false);
});

// Reproduces the real-world regression: applyI18n replaces option textContent
// with translations (e.g. Private→私有, Public→公开). The text-fallback match
// in setGlassSelectValue must NOT rely on textContent, or it breaks for every
// glass-select once the UI is localized. Options declare their value via
// data-value so matching survives i18n.
function buildEditStatusSelectI18n() {
  const select = makeEl('div', { class: 'glass-select' });
  const trigger = makeEl('div', { class: 'glass-select-trigger' });
  const label = makeEl('span', { class: 'selected-label' }); label.attributes['data-i18n'] = 'filterPrivate'; label._text = '私有';
  trigger.appendChild(label);
  trigger.appendChild(makeEl('span', { class: 'chevron' }));
  select.appendChild(trigger);

  const options = makeEl('div', { class: 'glass-select-options' });
  const optPrivate = makeEl('div', { class: 'glass-option selected' }); optPrivate.setAttribute('data-value', 'private'); optPrivate.setAttribute('data-i18n', 'filterPrivate'); optPrivate._text = '私有';
  const optPublic = makeEl('div', { class: 'glass-option' }); optPublic.setAttribute('data-value', 'public'); optPublic.setAttribute('data-i18n', 'filterPublic'); optPublic._text = '公开';
  options.appendChild(optPrivate); options.appendChild(optPublic);
  select.appendChild(options);

  const input = makeEl('input'); input.tagName = 'INPUT'; input.attributes.type = 'hidden'; input.attributes.id = 'editStatus'; input.value = 'private';
  select.appendChild(input);
  return { select, label, optPrivate, optPublic, input };
}

test('setGlassSelectValue syncs label and selected class when options are i18n-translated (data-value wins over text)', () => {
  const { select, label, optPrivate, optPublic, input } = buildEditStatusSelectI18n();
  exported.setGlassSelectValue(select, 'public');
  assert.equal(input.value, 'public', 'hidden input holds public');
  assert.equal(label.textContent, '公开', 'label reflects the translated public option');
  assert.equal(optPublic.classList.contains('selected'), true, 'public option selected');
  assert.equal(optPrivate.classList.contains('selected'), false, 'private option deselected');
});

// Reproduces the original bug directly: WITHOUT data-value, i18n-translated
// option text breaks the text-fallback match, so setGlassSelectValue must not
// silently leave the label untouched. We assert that the contract is satisfied
// via data-value (the fix in index.html), and that bare text matching is NOT
// the relied-upon path. This test uses data-value because that is the fix.
test('setGlassSelectValue does not match by translated text when data-value is absent (documents the pitfall)', () => {
  const select = makeEl('div', { class: 'glass-select' });
  const trigger = makeEl('div', { class: 'glass-select-trigger' });
  const label = makeEl('span', { class: 'selected-label' }); label._text = '私有';
  trigger.appendChild(label); trigger.appendChild(makeEl('span', { class: 'chevron' }));
  select.appendChild(trigger);
  const options = makeEl('div', { class: 'glass-select-options' });
  const optPrivate = makeEl('div', { class: 'glass-option selected' }); optPrivate._text = '私有';
  const optPublic = makeEl('div', { class: 'glass-option' }); optPublic._text = '公开';
  options.appendChild(optPrivate); options.appendChild(optPublic);
  select.appendChild(options);
  const input = makeEl('input'); input.tagName = 'INPUT'; input.value = 'private';
  select.appendChild(input);

  // Without data-value, text fallback compares '公开' === 'public' → no match.
  // The label is NOT updated. This documents why index.html must declare
  // data-value on every glass-option that setGlassSelectValue targets.
  exported.setGlassSelectValue(select, 'public');
  assert.equal(label.textContent, '私有', 'without data-value the label stays stale (pitfall)');
  assert.equal(input.value, 'public', 'hidden input is still set correctly');
});
