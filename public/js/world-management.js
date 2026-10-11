/*
 * Shared classic-script world management. Load after worlds.js.
 * Only official, visible, owned details may start a mutation. List/favorite/IDB
 * synchronization belongs to applyWorldManagementUpdate/Delete in worlds.js.
 * Those awaited hooks must use options.sessionToken for IDB and recheck
 * options.isSessionCurrent() after every await. Repaint only when
 * options.isDetailCurrent(); close deleted detail only when ALSO
 * options.isDialogCurrent(). Resetting a dialog never cancels its world lock.
 */
(function () {
  'use strict';

  const WORLD_ID = /^wrld_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const FIELD_IDS = Object.freeze({
    name: 'worldEditName',
    description: 'worldEditDescription',
    capacity: 'worldEditCapacity',
    recommendedCapacity: 'worldEditRecommendedCapacity',
    tags: 'worldEditTags',
    previewYoutubeId: 'worldEditPreviewYoutubeId',
    urlList: 'worldEditUrlList',
  });
  const flights = new Map();
  const worldGenerations = new Map();
  const deletedWorlds = new Map();
  let editContext = null;
  let deleteContext = null;
  let editGeneration = 0;
  let deleteGeneration = 0;

  const element = id => document.getElementById(id);
  const displayValue = value => value == null ? '' : String(value);
  const isAuthorTag = tag => typeof tag === 'string' && tag.startsWith('author_tag_');
  const sameArray = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
  const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

  function safeHttpUrl(value) {
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || /[\u0000-\u0020\u007f]/.test(value)) return false;
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password;
    } catch (_) { return false; }
  }

  function message(key, fallback, values = {}) {
    const translated = typeof t === 'function' ? t(key, values) : key;
    if (translated && translated !== key) return translated;
    return fallback.replace(/\{(\w+)\}/g, (_, name) => displayValue(values[name]));
  }

  function visible(modal) {
    return !!modal && !modal.hidden && !modal.classList.contains('hidden')
      && modal.style.display !== 'none' && modal.getAttribute?.('aria-hidden') !== 'true';
  }

  function frozenCopy(value) {
    const copy = JSON.parse(JSON.stringify(value));
    const freeze = object => {
      if (object && typeof object === 'object') {
        Object.values(object).forEach(freeze);
        Object.freeze(object);
      }
      return object;
    };
    return freeze(copy);
  }

  function ownedDetail(world = currentWorldDetail) {
    const loaded = currentWorldDetail;
    const token = window._worldDetailActiveToken;
    return !!world && !!loaded && WORLD_ID.test(world.id || '')
      && world.id === loaded.id && !world.isInvalid && !loaded.isInvalid
      && typeof currentUserId === 'string' && !!currentUserId
      && world.authorId === currentUserId && loaded.authorId === currentUserId
      && !!token && token.id === world.id && isUiTokenCurrent(token)
      && element('worldDetailId')?.textContent === world.id
      && visible(element('worldDetailModal'));
  }

  function sessionCurrent(context, sessionToken = context.sessionToken) {
    return !!context && currentUserId === context.accountId
      && context.ownerId === context.accountId
      && isAuthSessionCurrent(context.sessionToken)
      && isAuthSessionCurrent(sessionToken);
  }

  function detailCurrent(context, sessionToken = context.sessionToken) {
    return sessionCurrent(context, sessionToken)
      && window._worldDetailActiveToken === context.detailToken
      && ownedDetail() && currentWorldDetail.id === context.worldId;
  }

  function dialogCurrent(context, sessionToken = context.sessionToken) {
    const current = context.operation === 'edit' ? editContext : deleteContext;
    const generation = context.operation === 'edit' ? editGeneration : deleteGeneration;
    return current === context && context.dialogGeneration === generation
      && sessionCurrent(context, sessionToken) && visible(element(context.modalId));
  }

  function status(context, text) {
    if (dialogCurrent(context)) element(context.statusId).textContent = text;
  }

  function activeFlight(worldId) {
    const flight = flights.get(worldId);
    return flight && sessionCurrent(flight.context, flight.sessionToken) ? flight : null;
  }

  function alreadyDeleted(worldId) {
    const token = deletedWorlds.get(worldId);
    if (!token) return false;
    if (!isAuthSessionCurrent(token) || token.accountId !== currentUserId) {
      deletedWorlds.delete(worldId);
      return false;
    }
    return true;
  }

  function syncDialogButtons() {
    for (const context of [editContext, deleteContext]) {
      if (!context || !dialogCurrent(context)) continue;
      const busy = !!activeFlight(context.worldId);
      const deleted = alreadyDeleted(context.worldId);
      const button = element(context.buttonId);
      if (button) {
        button.disabled = busy || deleted;
        button.setAttribute('aria-busy', busy ? 'true' : 'false');
      }
      const statusElement = element(context.statusId);
      if (deleted && !context.deleteCommitted) {
        statusElement.textContent = message('world.manage.staleContext', 'This world or account changed. Reopen the dialog.');
      } else if (!busy && statusElement?.textContent === message('world.manage.busy', 'Another operation on this world is still running.')) {
        statusElement.textContent = '';
      }
    }
  }

  function showDialog(context, focusId) {
    const modal = element(context.modalId);
    modal.hidden = false;
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    if (typeof modalZTop === 'function') modal.style.zIndex = modalZTop();
    if (modal.dataset.scrollLocked !== '1' && typeof lockBodyScroll === 'function') {
      lockBodyScroll();
      modal.dataset.scrollLocked = '1';
    }
    syncDialogButtons();
    element(focusId)?.focus();
  }

  function hideDialog(id) {
    const modal = element(id);
    if (!modal) return;
    modal.hidden = true;
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    if (modal.dataset.scrollLocked === '1') {
      modal.dataset.scrollLocked = '';
      if (typeof unlockBodyScroll === 'function') unlockBodyScroll();
    }
  }

  function closeWorldEditModal() {
    editContext = null;
    editGeneration += 1;
    hideDialog('worldEditModal');
  }

  function closeWorldDeleteConfirm() {
    deleteContext = null;
    deleteGeneration += 1;
    hideDialog('worldDeleteConfirmModal');
  }

  function resetWorldManagementDialogs() {
    closeWorldEditModal();
    closeWorldDeleteConfirm();
    // A dispatched mutation may already have succeeded. Keep its lock until
    // its response and synchronization finish; a new dialog cannot race it.
  }

  function updateWorldOwnerActions(world = null, loading = false) {
    const available = !loading && ownedDetail(world) && !alreadyDeleted(world.id);
    const parent = element('worldDetailOwnerActions');
    if (parent) {
      parent.hidden = !available;
      parent.classList.toggle('hidden', !available);
      parent.setAttribute('aria-hidden', available ? 'false' : 'true');
    }
    for (const id of ['worldDetailEditBtn', 'worldDetailDeleteBtn']) {
      const button = element(id);
      if (!button) continue;
      button.hidden = !available;
      button.classList.toggle('hidden', !available);
      button.disabled = !available || !!activeFlight(world.id);
      button.setAttribute('aria-hidden', available ? 'false' : 'true');
    }
    // Never set inline display/flex: responsive CSS remains authoritative.
    return available;
  }

  function capture(operation, sessionToken) {
    const world = currentWorldDetail;
    const source = Array.isArray(allWorlds) ? allWorlds.find(item => item?.id === world.id) : null;
    return {
      operation,
      worldId: world.id,
      ownerId: world.authorId,
      accountId: currentUserId,
      sessionToken,
      detailToken: window._worldDetailActiveToken,
      category: typeof currentWorldCategory === 'string' ? currentWorldCategory : '',
      originalWorld: frozenCopy(world),
      sourceWorld: source ? frozenCopy(source) : null,
      selected: typeof selectedWorldIds !== 'undefined' && selectedWorldIds.has(world.id),
      dialogGeneration: operation === 'edit' ? ++editGeneration : ++deleteGeneration,
      modalId: operation === 'edit' ? 'worldEditModal' : 'worldDeleteConfirmModal',
      statusId: operation === 'edit' ? 'worldEditStatus' : 'worldDeleteConfirmStatus',
      buttonId: operation === 'edit' ? 'btnSaveWorldEdit' : 'btnConfirmWorldDelete',
    };
  }

  function editControls() {
    const controls = {};
    for (const [field, id] of Object.entries(FIELD_IDS)) {
      controls[field] = element(id);
      if (!controls[field]) throw new Error(message('world.manage.integrationUnavailable', 'World management is not ready.'));
    }
    return controls;
  }

  function editCurrentWorld() {
    const sessionToken = makeAuthSessionToken();
    if (!ownedDetail() || !isAuthSessionCurrent(sessionToken) || alreadyDeleted(currentWorldDetail.id)) return false;
    if (editContext && dialogCurrent(editContext) && detailCurrent(editContext)) return true;
    if (!element('worldEditModal') || !element('worldEditId') || !element('worldEditReleaseStatus')
        || !element('worldEditStatus') || !element('btnSaveWorldEdit')) return false;
    const controls = editControls();
    closeWorldEditModal();
    closeWorldDeleteConfirm();
    const context = capture('edit', sessionToken);
    const world = context.originalWorld;
    for (const field of Object.keys(FIELD_IDS)) {
      let value = world[field];
      if (field === 'tags') value = (Array.isArray(value) ? value : []).filter(isAuthorTag).map(tag => tag.slice(11)).join(', ');
      if (field === 'urlList') value = Array.isArray(value) ? value.map(displayValue).join('\n') : displayValue(value);
      controls[field].value = displayValue(value);
    }
    // Capture actual control values (number inputs and textareas may normalize
    // legacy data). Unchanged controls must never clear or default server data.
    context.initialValues = Object.freeze(Object.fromEntries(Object.entries(controls).map(([field, control]) => [field, control.value])));
    editContext = context;
    element('worldEditId').textContent = world.id;
    element('worldEditReleaseStatus').textContent = displayValue(world.releaseStatus);
    element('worldEditStatus').textContent = activeFlight(world.id)
      ? message('world.manage.busy', 'Another operation on this world is still running.') : '';
    showDialog(context, 'worldEditName');
    return true;
  }

  function editPayload(context) {
    const controls = editControls();
    const original = context.originalWorld;
    const payload = {};
    const name = controls.name.value.trim();
    if (!name) throw new Error(message('world.edit.nameRequired', 'Enter a world name.'));
    if (controls.name.value !== context.initialValues.name && name !== original.name) payload.name = name;
    if (controls.description.value !== context.initialValues.description) payload.description = controls.description.value;

    for (const field of ['capacity', 'recommendedCapacity']) {
      const raw = controls[field].value;
      if (raw === context.initialValues[field]) continue;
      const value = raw.trim();
      if (!value && original[field] == null) continue;
      const number = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 0) {
        throw new Error(message(`world.edit.${field}Invalid`, field === 'capacity'
          ? 'Capacity must be a non-negative safe integer.' : 'Recommended capacity must be a non-negative safe integer.'));
      }
      if (number !== original[field]) payload[field] = number;
    }
    // No client-invented capacity cap or recommended-capacity relation.

    if (controls.tags.value !== context.initialValues.tags) {
      if (original.tags != null && !Array.isArray(original.tags)) {
        throw new Error(message('world.edit.tagsUnavailable', 'Original tags are unavailable; reload the world before editing keywords.'));
      }
      const keywords = [...new Set(controls.tags.value.split(',').map(keyword => keyword.trim()).filter(Boolean))];
      if (keywords.some(keyword => /^(?:author_tag_|system_|admin_)/i.test(keyword) || /[\u0000-\u001f\u007f]/.test(keyword))) {
        throw new Error(message('world.edit.tagsInvalid', 'Enter keywords only, without author_tag_, system_, or admin_ prefixes.'));
      }
      const authors = keywords.map(keyword => 'author_tag_' + keyword);
      const originalTags = original.tags || [];
      const tags = [];
      let index = 0;
      for (const tag of originalTags) {
        if (!isAuthorTag(tag)) tags.push(tag); // Preserve reserved/unknown entries and their relative order exactly.
        else if (index < authors.length) tags.push(authors[index++]);
      }
      tags.push(...authors.slice(index));
      if (!sameArray(tags, originalTags)) payload.tags = tags;
    }

    if (controls.previewYoutubeId.value !== context.initialValues.previewYoutubeId) {
      const video = controls.previewYoutubeId.value.trim();
      if (video && !/^[A-Za-z0-9_-]{11}$/.test(video)) {
        throw new Error(message('world.edit.videoInvalid', 'Enter a plain 11-character YouTube video ID, or leave it blank.'));
      }
      if (video !== original.previewYoutubeId) payload.previewYoutubeId = video;
    }

    if (controls.urlList.value !== context.initialValues.urlList) {
      const urls = controls.urlList.value.split(/\r\n?|\n/).map(url => url.trim()).filter(Boolean);
      for (const value of urls) {
        if (!safeHttpUrl(value)) {
          throw new Error(message('world.edit.urlInvalid', 'Each URL must use HTTP or HTTPS and contain no username or password.'));
        }
      }
      if (!sameArray(urls, Array.isArray(original.urlList) ? original.urlList : [])) payload.urlList = urls;
    }
    // Deliberately no publication, author, build, package, or image fields.
    return payload;
  }

  function deleteCurrentWorld() {
    const sessionToken = makeAuthSessionToken();
    if (!ownedDetail() || !isAuthSessionCurrent(sessionToken) || alreadyDeleted(currentWorldDetail.id)) return false;
    if (deleteContext && dialogCurrent(deleteContext) && detailCurrent(deleteContext)) return true;
    if (!element('worldDeleteConfirmModal') || !element('worldDeleteConfirmName') || !element('worldDeleteConfirmId')
        || !element('worldDeleteConfirmStatus') || !element('btnConfirmWorldDelete')) return false;
    closeWorldEditModal();
    closeWorldDeleteConfirm();
    const context = capture('delete', sessionToken);
    deleteContext = context;
    element('worldDeleteConfirmName').textContent = displayValue(context.originalWorld.name || context.worldId);
    element('worldDeleteConfirmId').textContent = context.worldId;
    element('worldDeleteConfirmStatus').textContent = activeFlight(context.worldId)
      ? message('world.manage.busy', 'Another operation on this world is still running.') : '';
    showDialog(context, 'btnCancelWorldDelete');
    return true; // Opening/cancelling never dispatches DELETE.
  }

  function beginOperation(context, sessionToken) {
    if (alreadyDeleted(context.worldId)) {
      if (!context.deleteCommitted) status(context, message('world.manage.staleContext', 'This world or account changed. Reopen the dialog.'));
      syncDialogButtons();
      return null;
    }
    if (!dialogCurrent(context, sessionToken) || !detailCurrent(context, sessionToken)
        || element(context.operation === 'edit' ? 'worldEditId' : 'worldDeleteConfirmId')?.textContent !== context.worldId) {
      status(context, message('world.manage.staleContext', 'This world or account changed. Reopen the dialog.'));
      return null;
    }
    if (activeFlight(context.worldId)) {
      status(context, message('world.manage.busy', 'Another operation on this world is still running.'));
      return null;
    }
    const generation = (worldGenerations.get(context.worldId) || 0) + 1;
    worldGenerations.set(context.worldId, generation);
    const flight = { context, sessionToken, generation };
    flights.set(context.worldId, flight);
    syncDialogButtons();
    return flight;
  }

  function callbackOptions(flight) {
    const context = flight.context;
    return Object.freeze({
      worldId: context.worldId,
      ownerId: context.ownerId,
      accountId: context.accountId,
      sessionToken: flight.sessionToken,
      category: context.category,
      detailToken: context.detailToken,
      originalWorld: context.originalWorld,
      sourceWorld: context.sourceWorld,
      selected: context.selected,
      dialogGeneration: context.dialogGeneration,
      operationGeneration: flight.generation,
      operation: context.operation,
      isSessionCurrent: () => sessionCurrent(context, flight.sessionToken),
      isDetailCurrent: () => detailCurrent(context, flight.sessionToken),
      isDialogCurrent: () => dialogCurrent(context, flight.sessionToken),
      isOperationCurrent: () => sessionCurrent(context, flight.sessionToken)
        && flights.get(context.worldId) === flight && worldGenerations.get(context.worldId) === flight.generation,
    });
  }

  function finishOperation(flight) {
    if (flights.get(flight.context.worldId) !== flight) return;
    flights.delete(flight.context.worldId);
    // Recompute live state rather than blindly enabling an old dialog's button.
    // A stale account's finally must not touch the replacement account's DOM.
    if (sessionCurrent(flight.context, flight.sessionToken)) {
      syncDialogButtons();
      updateWorldOwnerActions(currentWorldDetail);
    }
  }

  async function jsonOrNull(response) {
    try { return await response.json(); } catch (_) { return null; }
  }

  function responseMessage(body, response) {
    return (typeof body?.error?.message === 'string' && body.error.message)
      || (typeof body?.error === 'string' && body.error)
      || (typeof body?.message === 'string' && body.message)
      || `HTTP ${response.status}`;
  }

  function authoritativeWorld(world, context, payload) {
    if (!world || typeof world !== 'object' || Array.isArray(world) || world.error
        || world.id !== context.worldId || !WORLD_ID.test(world.id)
        || world.authorId !== context.ownerId || world.isInvalid || typeof world.name !== 'string'
        || hasOwn(world, '__proto__') || hasOwn(world, 'constructor') || hasOwn(world, 'prototype')) return false;
    for (const field of [...Object.keys(FIELD_IDS), 'releaseStatus']) {
      if ((hasOwn(context.originalWorld, field) || hasOwn(payload, field)) && !hasOwn(world, field)) return false;
    }
    // Reject newly malformed values, but an untouched legacy field is not a
    // reason to overwrite it or to invent a default. The response remains
    // authoritative: do not require it to equal the submitted changes.
    for (const field of Object.keys(FIELD_IDS)) {
      if (!hasOwn(payload, field) && JSON.stringify(world[field]) === JSON.stringify(context.originalWorld[field])) continue;
      const value = world[field];
      if (field === 'name' && (typeof value !== 'string' || !value.trim())) return false;
      if (field === 'description' && value != null && typeof value !== 'string') return false;
      if (['capacity', 'recommendedCapacity'].includes(field)
          && (value != null ? !Number.isSafeInteger(value) || value < 0 : hasOwn(payload, field))) return false;
      if (field === 'tags' && value == null && hasOwn(payload, field)) return false;
      if (field === 'tags' && value != null) {
        if (!Array.isArray(value)) return false;
        const unknown = (Array.isArray(context.originalWorld.tags) ? context.originalWorld.tags : []).filter(tag => typeof tag !== 'string');
        if (value.some(tag => typeof tag !== 'string' && !unknown.some(original => JSON.stringify(tag) === JSON.stringify(original)))) return false;
      }
      if (field === 'previewYoutubeId' && value != null
          && (typeof value !== 'string' || (value !== '' && !/^[A-Za-z0-9_-]{11}$/.test(value)))) return false;
      if (field === 'urlList' && value == null && hasOwn(payload, field)) return false;
      if (field === 'urlList' && value != null) {
        const legacy = Array.isArray(context.originalWorld.urlList) ? context.originalWorld.urlList : [];
        if (!Array.isArray(value) || value.some(url => typeof url !== 'string' || (!legacy.includes(url) && !safeHttpUrl(url)))) return false;
      }
    }
    return world.releaseStatus == null || typeof world.releaseStatus === 'string';
  }

  async function saveWorldEdit() {
    const context = editContext;
    if (!context) return false;
    const sessionToken = makeAuthSessionToken(); // Capture at the click, before any await.
    if (alreadyDeleted(context.worldId)) {
      status(context, message('world.manage.staleContext', 'This world or account changed. Reopen the dialog.'));
      syncDialogButtons();
      return false;
    }
    if (!dialogCurrent(context, sessionToken) || !detailCurrent(context, sessionToken)
        || element('worldEditId')?.textContent !== context.worldId) {
      status(context, message('world.manage.staleContext', 'This world or account changed. Reopen the dialog.'));
      return false;
    }
    if (activeFlight(context.worldId)) return false;
    let payload;
    try { payload = editPayload(context); }
    catch (error) { status(context, error.message); return false; }
    if (!Object.keys(payload).length) {
      status(context, message('world.edit.noChanges', 'No changes to save.'));
      return false;
    }
    const hook = typeof applyWorldManagementUpdate === 'function' ? applyWorldManagementUpdate : null;
    if (!hook) {
      status(context, message('world.manage.integrationUnavailable', 'World management is not ready.'));
      return false;
    }
    const flight = beginOperation(context, sessionToken);
    if (!flight) return false;
    const options = callbackOptions(flight);
    let phase = 'write';
    status(context, message('world.edit.saving', 'Saving…'));
    try {
      const response = await apiCall(`/api/vrc/worlds/${encodeURIComponent(context.worldId)}`, {
        method: 'PUT', json: payload, noAbort: true, noCache: true, noDedupe: true,
      });
      if (!options.isOperationCurrent()) return false;
      const body = await jsonOrNull(response);
      if (!options.isOperationCurrent()) return false;
      if (!response.ok || body?.error) throw new Error(responseMessage(body, response));
      phase = 'refresh';
      let world = body;
      if (!authoritativeWorld(world, context, payload)) {
        const fresh = await apiCall(`/api/vrc/worlds/${encodeURIComponent(context.worldId)}`, {
          noAbort: true, noCache: true, noDedupe: true,
        });
        if (!options.isOperationCurrent()) return false;
        world = await jsonOrNull(fresh);
        if (!options.isOperationCurrent()) return false;
        if (!fresh.ok) throw new Error(responseMessage(world, fresh));
        if (!authoritativeWorld(world, context, payload)) {
          throw new Error(message('world.manage.responseInvalid', 'The server did not return a matching world record.'));
        }
      }
      phase = 'sync';
      await hook(world, options); // Never synthesize a result from the submitted form.
      if (!options.isOperationCurrent()) return false;
      if (options.isDialogCurrent()) closeWorldEditModal();
      return true;
    } catch (error) {
      if (!options.isOperationCurrent()) return false;
      const key = phase === 'write' ? 'world.edit.saveFailed' : phase === 'refresh' ? 'world.edit.savedRefreshFailed' : 'world.edit.syncFailed';
      const fallback = phase === 'write' ? 'Save failed: {msg}' : phase === 'refresh'
        ? 'Saved, but refreshing the world failed: {msg}' : 'Saved, but updating the local view failed: {msg}';
      status(context, message(key, fallback, { msg: error.message }));
      return false;
    } finally {
      finishOperation(flight);
    }
  }

  async function confirmWorldDeletion() {
    const context = deleteContext;
    if (!context) return false;
    const sessionToken = makeAuthSessionToken(); // A confirmation, not opening, starts DELETE.
    const hook = typeof applyWorldManagementDelete === 'function' ? applyWorldManagementDelete : null;
    if (!hook) {
      status(context, message('world.manage.integrationUnavailable', 'World management is not ready.'));
      return false;
    }
    const flight = beginOperation(context, sessionToken);
    if (!flight) return false;
    const options = callbackOptions(flight);
    let deleted = false;
    status(context, message('world.delete.deleting', 'Deleting…'));
    try {
      const response = await apiCall(`/api/vrc/worlds/${encodeURIComponent(context.worldId)}`, {
        method: 'DELETE', noAbort: true, noCache: true, noDedupe: true,
      });
      if (!options.isOperationCurrent()) return false;
      if (!response.ok) {
        const body = await jsonOrNull(response);
        if (!options.isOperationCurrent()) return false;
        throw new Error(responseMessage(body, response));
      }
      deleted = true; // A successful DELETE may have an empty body (200/204).
      context.deleteCommitted = true;
      deletedWorlds.set(context.worldId, sessionToken);
      // Remember the successful mutation even if synchronization fails. Do not
      // put this marker in detailCurrent(): the original hook still needs its
      // live detail/dialog guards to close the matching detail safely.
      syncDialogButtons();
      updateWorldOwnerActions(currentWorldDetail);
      await hook(context.originalWorld, options);
      if (!options.isOperationCurrent()) return false;
      if (options.isDialogCurrent()) closeWorldDeleteConfirm();
      return true;
    } catch (error) {
      if (!options.isOperationCurrent()) return false;
      status(context, message(deleted ? 'world.delete.syncFailed' : 'world.delete.failed', deleted
        ? 'Deleted, but updating the local view failed: {msg}' : 'Delete failed: {msg}', { msg: error.message }));
      return false;
    } finally {
      finishOperation(flight);
    }
  }

  const handlers = Object.freeze({
    editCurrentWorld,
    saveWorldEdit,
    closeWorldEditModal,
    updateWorldOwnerActions,
    deleteCurrentWorld,
    confirmWorldDeletion,
    closeWorldDeleteConfirm,
    resetWorldManagementDialogs,
  });
  // Register private function references, not shell/global wrappers. Lazy
  // callers must dispatch to modules.worldManagement, not modules.worlds.
  if (typeof VRCW !== 'undefined' && typeof VRCW.registerModule === 'function') VRCW.registerModule('worldManagement', handlers);
  Object.assign(window, handlers);
})();
