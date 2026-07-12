/*
 * VRCW - ui-controls.js
 * Resident shared UI controls used by multiple classic scripts and inline handlers.
 */

function getGlassSelectOptions(el) {
  return el.querySelector('.glass-select-options') || el.__glassSelectOptions || null;
}

function portalGlassSelectOptions(el, opts) {
  if (!opts || opts.__glassSelectOwner) return;
  opts.__glassSelectOwner = el;
  opts.__glassSelectPlaceholder = document.createComment('glass-select-options');
  el.__glassSelectOptions = opts;
  opts.parentNode.insertBefore(opts.__glassSelectPlaceholder, opts);
  document.body.appendChild(opts);
}

function restoreGlassSelectOptions(opts) {
  if (!opts || !opts.__glassSelectOwner) return;
  const owner = opts.__glassSelectOwner;
  const placeholder = opts.__glassSelectPlaceholder;
  if (placeholder && placeholder.parentNode) {
    placeholder.parentNode.insertBefore(opts, placeholder);
    placeholder.parentNode.removeChild(placeholder);
  }
  owner.__glassSelectOptions = null;
  opts.__glassSelectOwner = null;
  opts.__glassSelectPlaceholder = null;
}

function resetGlassSelectOptions(opts) {
  if (!opts) return;
  // Hide immediately BEFORE removing positional overrides.
  // Without this, removing position:fixed restores the CSS default
  // `transition: all 0.3s`, causing the panel to animate from its
  // fixed viewport coords back to the default absolute position —
  // the "fly across the screen" artifact on close.
  opts.style.setProperty('opacity', '0', 'important');
  opts.style.setProperty('pointer-events', 'none', 'important');
  opts.style.setProperty('transition', 'none', 'important');
  // Now safe to remove all positional overrides; panel is invisible
  opts.style.removeProperty('position');
  opts.style.removeProperty('top');
  opts.style.removeProperty('left');
  opts.style.removeProperty('right');
  opts.style.removeProperty('width');
  opts.style.removeProperty('max-height');
  opts.style.removeProperty('overflow-y');
  // Finally remove the hide overrides so CSS defaults take over
  // (opacity:0 + pointer-events:none are already the CSS defaults
  // for .glass-select-options when the parent lacks .active)
  opts.style.removeProperty('opacity');
  opts.style.removeProperty('pointer-events');
  opts.style.removeProperty('transition');
  opts.style.removeProperty('transform');
  restoreGlassSelectOptions(opts);
}

function positionGlassSelectOptions(el) {
  const opts = getGlassSelectOptions(el);
  if (!opts) return;

  const r = el.getBoundingClientRect();
  const width = Math.max(r.width, 160);
  const isMobile = window.matchMedia && window.matchMedia('(max-width: 768px)').matches;

  // Modal overlays use backdrop-filter, which makes position:fixed relative to
  // the modal instead of the viewport in Chromium. Keep modal dropdowns anchored
  // to their trigger. Search dropdowns must instead escape the clipped grid area,
  // so portal them to body before applying fixed viewport coordinates.
  if (el.closest('.modal')) {
    opts.style.position = 'absolute';
    opts.style.top = 'calc(100% + 6px)';
    opts.style.left = '0';
    opts.style.right = 'auto';
    opts.style.width = width + 'px';
    opts.style.setProperty('opacity', '1', 'important');
    opts.style.setProperty('transform', 'translateY(0)', 'important');
    opts.style.setProperty('pointer-events', 'auto', 'important');
    opts.style.setProperty('transition', 'none', 'important');
    return;
  }

  if (el.closest('.search-box-glass')) {
    portalGlassSelectOptions(el, opts);
  }

  const margin = 8;
  const bottomReserve = isMobile ? 72 : margin;
  const left = Math.max(margin, Math.min(r.left, window.innerWidth - width - margin));
  const naturalHeight = opts.scrollHeight || opts.offsetHeight || 240;
  const belowTop = r.bottom + 4;
  const belowSpace = window.innerHeight - bottomReserve - belowTop - margin;
  const aboveSpace = r.top - margin - 4;
  const openAbove = isMobile && belowSpace < Math.min(naturalHeight, 180) && aboveSpace > belowSpace;
  const maxHeight = Math.max(120, Math.min(naturalHeight, openAbove ? aboveSpace : belowSpace));

  opts.style.setProperty('position', 'fixed', 'important');
  opts.style.setProperty('top', (openAbove ? Math.max(margin, r.top - 4 - maxHeight) : belowTop) + 'px', 'important');
  opts.style.setProperty('left', left + 'px', 'important');
  opts.style.setProperty('right', 'auto', 'important');
  opts.style.setProperty('width', width + 'px', 'important');
  opts.style.setProperty('max-height', maxHeight + 'px', 'important');
  opts.style.setProperty('overflow-y', naturalHeight > maxHeight ? 'auto' : 'hidden', 'important');
  opts.style.setProperty('opacity', '1', 'important');
  opts.style.setProperty('transform', 'translateY(0)', 'important');
  opts.style.setProperty('pointer-events', 'auto', 'important');
  opts.style.setProperty('transition', 'none', 'important');
}

function toggleGlassSelect(e, el) {
  e.stopPropagation();
  const isNowActive = !el.classList.contains('active');

  document.querySelectorAll('.glass-select.active').forEach(s => {
    if (s !== el) {
      s.classList.remove('active');
      resetGlassSelectOptions(getGlassSelectOptions(s));
    }
  });

  el.classList.toggle('active', isNowActive);

  if (isNowActive) {
    positionGlassSelectOptions(el);
  } else {
    resetGlassSelectOptions(getGlassSelectOptions(el));
  }
}

// Programmatically set a glass-select's value and sync the visible label +
// `.selected` highlight, mirroring what selectGlassOption does on user click.
// editAvatar needs this: setting only the hidden input's value leaves the
// trigger label stuck on the old option (e.g. showing "Private" for a model
// whose releaseStatus is actually public).
function setGlassSelectValue(select, val) {
  if (!select) return;
  const input = select.querySelector('input[type="hidden"]');
  if (input) input.value = val;
  const label = select.querySelector('.selected-label');
  let matched = null;
  getGlassSelectOptions(select).querySelectorAll('.glass-option').forEach(opt => {
    // Match either the option's declared value (onclick 'private'/'public')
    // or, failing that, case-insensitive text. Classic defines option values
    // inline via selectGlassOption(this, 'private'); there is no data-value
    // attribute today, so we fall back to text for robustness.
    const declared = opt.getAttribute('data-value') || opt.getAttribute('data-glass-value') || opt.getAttribute('data-val');
    const matches = declared ? declared === val : (opt.textContent || '').trim().toLowerCase() === String(val).toLowerCase();
    if (matches) {
      matched = opt;
    } else {
      opt.classList.remove('selected');
    }
  });
  if (matched) {
    matched.classList.add('selected');
    if (label) {
      label.textContent = matched.textContent;
      const i18nKey = matched.getAttribute('data-i18n');
      if (i18nKey) {
        label.setAttribute('data-i18n', i18nKey);
        const translated = t(i18nKey);
        if (translated) label.textContent = translated;
      } else {
        label.removeAttribute('data-i18n');
      }
    }
  }
}

function selectGlassOption(e, el, val, callbackName) {
  e.stopPropagation();
  const select = el.closest('.glass-select') || el.parentNode.__glassSelectOwner;
  if (!select) return;
  setGlassSelectValue(select, val);
  getGlassSelectOptions(select).querySelectorAll('.glass-option').forEach(opt => opt.classList.remove('selected'));
  el.classList.add('selected');

  // The clicked option is authoritative even when legacy markup has no
  // data-value and its translated text cannot be matched back to `val`.
  const label = select.querySelector('.selected-label');
  if (label) {
    label.textContent = el.textContent;
    const i18nKey = el.getAttribute('data-i18n');
    if (i18nKey) label.setAttribute('data-i18n', i18nKey);
    else label.removeAttribute('data-i18n');
  }

  select.classList.remove('active');
  resetGlassSelectOptions(getGlassSelectOptions(select));

  if (callbackName && typeof window[callbackName] === 'function') {
    window[callbackName]();
  }
}

function closeActiveGlassSelects() {
  document.querySelectorAll('.glass-select.active').forEach(s => {
    s.classList.remove('active');
    resetGlassSelectOptions(getGlassSelectOptions(s));
  });
}

document.addEventListener('click', closeActiveGlassSelects);
window.addEventListener('resize', closeActiveGlassSelects);
document.addEventListener('scroll', e => {
  if (e.target?.closest?.('.glass-select-options')) return;
  closeActiveGlassSelects();
}, true);
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', closeActiveGlassSelects);
  window.visualViewport.addEventListener('scroll', closeActiveGlassSelects);
}

VRCW.registerModule('uiControls', {
  toggleGlassSelect,
  selectGlassOption,
  setGlassSelectValue,
});
renderAppVersionInfo();
