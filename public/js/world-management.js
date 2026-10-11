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
  // A dispatched publication request may succeed even if its response/refetch
  // fails. Reconcile before allowing another publication or metadata save.
  const publicationChanges = new Map();
  let editContext = null;
  let deleteContext = null;
  let publicationContext = null;
  let editGeneration = 0;
  let deleteGeneration = 0;
  let publicationGeneration = 0;
  let publicationReadGeneration = 0;

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
    const current = context.operation === 'edit' ? editContext : context.operation === 'delete' ? deleteContext : publicationContext;
    const generation = context.operation === 'edit' ? editGeneration : context.operation === 'delete' ? deleteGeneration : publicationGeneration;
    return current === context && context.dialogGeneration === generation
      && sessionCurrent(context, sessionToken) && visible(element(context.modalId));
  }

  function publicationEditorCurrent(context) {
    const editor = context.operation === 'edit' ? context : context.editorContext;
    return !!editor && editor === editContext && dialogCurrent(editor)
      && detailCurrent(editor) && element('worldEditId')?.textContent === editor.worldId;
  }

  function publicationChange(worldId) {
    const change = publicationChanges.get(worldId);
    if (change && (!isAuthSessionCurrent(change.sessionToken) || change.sessionToken.accountId !== currentUserId)) {
      publicationChanges.delete(worldId);
      return null;
    }
    return change || null;
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
        button.disabled = busy || deleted || (context.operation === 'edit' && !!publicationChange(context.worldId));
        button.setAttribute('aria-busy', busy ? 'true' : 'false');
      }
      const statusElement = element(context.statusId);
      if (deleted && !context.deleteCommitted) {
        statusElement.textContent = message('world.manage.staleContext', 'This world or account changed. Reopen the dialog.');
      } else if (!busy && statusElement?.textContent === message('world.manage.busy', 'Another operation on this world is still running.')) {
        statusElement.textContent = '';
      }
    }
    syncPublicationUi();
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

  function closeWorldPublicationConfirm() {
    publicationContext = null;
    publicationGeneration += 1;
    invalidatePublicationRead();
    hideDialog('worldPublicationConfirmModal');
  }

  function closeWorldEditModal() {
    closeWorldPublicationConfirm();
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
      dialogGeneration: operation === 'edit' ? ++editGeneration : operation === 'delete' ? ++deleteGeneration : ++publicationGeneration,
      modalId: operation === 'edit' ? 'worldEditModal' : operation === 'delete' ? 'worldDeleteConfirmModal' : 'worldPublicationConfirmModal',
      statusId: operation === 'edit' ? 'worldEditStatus' : operation === 'delete' ? 'worldDeleteConfirmStatus' : 'worldPublicationConfirmStatus',
      buttonId: operation === 'edit' ? 'btnSaveWorldEdit' : operation === 'delete' ? 'btnConfirmWorldDelete' : 'btnConfirmWorldPublication',
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
    for (const field of Object.keys(FIELD_IDS)) controls[field].value = editValue(world, field);
    // Capture actual control values (number inputs and textareas may normalize
    // legacy data). Unchanged controls must never clear or default server data.
    context.initialValues = Object.freeze(Object.fromEntries(Object.entries(controls).map(([field, control]) => [field, control.value])));
    editContext = context;
    element('worldEditId').textContent = world.id;
    element('worldEditReleaseStatus').textContent = publicationLabel(world);
    element('worldEditStatus').textContent = activeFlight(world.id)
      ? message('world.manage.busy', 'Another operation on this world is still running.') : '';
    showDialog(context, 'worldEditName');
    if (publicationWidgets() && publicationAction(world) === 'publish' && !publicationChange(world.id)) {
      void readPublicationEligibility(context);
    }
    return true;
  }

  function editValue(world, field) {
    let value = world[field];
    if (field === 'tags') value = (Array.isArray(value) ? value : []).filter(isAuthorTag).map(tag => tag.slice(11)).join(', ');
    if (field === 'urlList') value = Array.isArray(value) ? value.map(displayValue).join('\n') : displayValue(value);
    return displayValue(value);
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

  function publicationWidgets() {
    return !!element('btnWorldPublicationAction') && !!element('worldPublicationEligibility');
  }

  function publicationAction(world) {
    if (!world || !Array.isArray(world.tags) || world.tags.some(tag => typeof tag !== 'string')) return null;
    if (world.releaseStatus === 'public') return 'unpublish';
    if (world.releaseStatus === 'private' && !world.tags.includes('system_labs') && !world.tags.includes('system_approved')) return 'publish';
    return null; // Hidden, unknown, and contradictory private + publication markers are managed states.
  }

  function publicationSignature(world) {
    return JSON.stringify([world.releaseStatus, world.tags?.includes?.('system_labs'), world.tags?.includes?.('system_approved')]);
  }

  function publicationLabel(world) {
    const key = world?.releaseStatus === 'public' && Array.isArray(world.tags) && world.tags.includes('system_labs')
      ? 'labs' : ['private', 'public'].includes(world?.releaseStatus) ? world.releaseStatus : 'unknown';
    return message('world.publication.' + key, { private: 'Private', public: 'Public', labs: 'Community Labs', unknown: 'Unknown / managed' }[key]);
  }

  function invalidatePublicationRead() {
    publicationReadGeneration += 1;
    if (editContext?.publicationState === 'checking') editContext.publicationState = 'unchecked';
  }

  function publicationNotice(context, text) {
    if (publicationEditorCurrent(context)) {
      const editor = context.operation === 'edit' ? context : context.editorContext;
      editor.publicationNotice = text;
    }
    if (context.operation !== 'edit' && publicationEditorCurrent(context) && detailCurrent(context)) status(context, text);
  }

  function syncPublicationUi() {
    const editor = editContext;
    if (!editor || !publicationEditorCurrent(editor)) return;
    const world = editor.originalWorld;
    const action = publicationAction(world);
    const busy = !!activeFlight(editor.worldId);
    const deleted = alreadyDeleted(editor.worldId);
    const change = publicationChange(editor.worldId);
    const checking = editor.publicationState === 'checking';
    const ready = action === 'unpublish' || (action === 'publish' && editor.publicationState === 'eligible');
    element('worldEditReleaseStatus').textContent = publicationLabel(world);
    const actionButton = element('btnWorldPublicationAction');
    if (actionButton) {
      actionButton.textContent = message('world.publication.' + (action || 'unavailable'), action === 'publish' ? 'Publish' : action === 'unpublish' ? 'Unpublish' : 'Unavailable');
      actionButton.disabled = busy || deleted || !!change || !ready;
      actionButton.setAttribute('aria-busy', busy || checking ? 'true' : 'false');
    }
    const eligibility = element('worldPublicationEligibility');
    if (eligibility) eligibility.textContent = change?.message || editor.publicationNotice
      || (!action ? message('world.publication.managedState', 'This publication state cannot be changed here.')
        : checking ? message('world.publication.checking', 'Checking publication eligibility…')
          : ready ? '' : message('world.publication.unavailable', 'Publication eligibility is unavailable. Refresh to retry.'));
    const refresh = element('btnRefreshWorldPublication');
    if (refresh) refresh.disabled = busy || checking || deleted;
    const context = publicationContext;
    if (!context || !dialogCurrent(context) || !publicationEditorCurrent(context) || !detailCurrent(context)) return;
    const button = element('btnConfirmWorldPublication');
    if (button) {
      button.disabled = busy || deleted || !!change || !ready || context.invalidated
        || context.action !== action || context.confirmedSignature !== publicationSignature(world);
      button.setAttribute('aria-busy', busy ? 'true' : 'false');
    }
    const confirmRefresh = element('btnRefreshWorldPublicationConfirm');
    if (confirmRefresh) confirmRefresh.disabled = busy || checking || deleted;
  }

  async function publicationEligibility(worldId, current) {
    const response = await apiCall(`/api/vrc/worlds/${encodeURIComponent(worldId)}/publish`, {
      noAbort: true, noCache: true, noDedupe: true,
    });
    if (!current()) return null;
    const body = await jsonOrNull(response);
    if (!current()) return null;
    if (!response.ok || body?.error) throw new Error(responseMessage(body, response));
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.canPublish !== 'boolean') {
      throw new Error(message('world.manage.responseInvalid', 'The server did not return a matching world record.'));
    }
    return body.canPublish;
  }

  async function readPublicationEligibility(editor) {
    if (!publicationWidgets() || !publicationEditorCurrent(editor) || publicationAction(editor.originalWorld) !== 'publish'
        || alreadyDeleted(editor.worldId) || activeFlight(editor.worldId) || publicationChange(editor.worldId)) return false;
    const generation = ++publicationReadGeneration;
    const operationGeneration = worldGenerations.get(editor.worldId) || 0;
    const current = () => generation === publicationReadGeneration && publicationEditorCurrent(editor)
      && !alreadyDeleted(editor.worldId) && !activeFlight(editor.worldId)
      && (worldGenerations.get(editor.worldId) || 0) === operationGeneration;
    editor.publicationState = 'checking';
    editor.publicationNotice = '';
    syncPublicationUi();
    try {
      const eligible = await publicationEligibility(editor.worldId, current);
      if (!current() || eligible === null) return false;
      editor.publicationState = eligible ? 'eligible' : 'blocked';
      editor.publicationNotice = eligible ? '' : message('world.publication.cannotPublish', 'VRChat does not currently allow this world to be published.');
      return eligible;
    } catch (error) {
      if (!current()) return false;
      editor.publicationState = 'blocked';
      editor.publicationNotice = message('world.publication.checkFailed', 'Checking publication failed: {msg}', { msg: error.message });
      return false;
    } finally {
      if (current()) syncPublicationUi();
    }
  }

  function openWorldPublicationConfirm() {
    const editor = editContext;
    if (!editor || !publicationWidgets() || !publicationEditorCurrent(editor) || alreadyDeleted(editor.worldId)
        || activeFlight(editor.worldId) || publicationChange(editor.worldId)) return false;
    const action = publicationAction(editor.originalWorld);
    if (!action || (action === 'publish' && editor.publicationState !== 'eligible')
        || publicationSignature(currentWorldDetail) !== publicationSignature(editor.originalWorld)) return false;
    for (const id of ['worldPublicationConfirmModal', 'worldPublicationConfirmTitle', 'worldPublicationConfirmName',
      'worldPublicationConfirmId', 'worldPublicationConfirmWarning', 'worldPublicationConfirmStatus', 'btnCancelWorldPublication', 'btnConfirmWorldPublication']) {
      if (!element(id)) return false;
    }
    closeWorldPublicationConfirm();
    const context = capture(action, makeAuthSessionToken());
    context.editorContext = editor;
    context.originalWorld = editor.originalWorld;
    context.action = action;
    context.confirmedSignature = publicationSignature(editor.originalWorld);
    publicationContext = context;
    element('worldPublicationConfirmTitle').textContent = message('world.publication.' + (action === 'publish' ? 'confirmPublishTitle' : 'confirmUnpublishTitle'), action === 'publish' ? 'Publish this world?' : 'Unpublish this world?');
    element('worldPublicationConfirmName').textContent = displayValue(editor.originalWorld.name || editor.worldId);
    element('worldPublicationConfirmId').textContent = editor.worldId;
    element('worldPublicationConfirmWarning').textContent = message('world.publication.' + (action === 'publish' ? 'publishWarning' : 'unpublishWarning'), action === 'publish'
      ? 'Publication is subject to VRChat eligibility and review. Your unsaved edits will not be submitted.'
      : 'This removes the world from public discovery. Your unsaved edits will not be submitted.');
    element('btnConfirmWorldPublication').textContent = message('world.publication.' + (action === 'publish' ? 'publishConfirm' : 'unpublishConfirm'), action === 'publish' ? 'Confirm publication' : 'Confirm unpublication');
    element('worldPublicationConfirmStatus').textContent = '';
    showDialog(context, 'btnCancelWorldPublication');
    return true;
  }

  function publicationFlightCurrent(flight, requireConfirmedState = false) {
    const context = flight.context;
    return flights.get(context.worldId) === flight && worldGenerations.get(context.worldId) === flight.generation
      && sessionCurrent(context, flight.sessionToken) && !alreadyDeleted(context.worldId)
      && element(context.operation === 'edit' ? 'worldEditId' : 'worldPublicationConfirmId')?.textContent === context.worldId
      && (!requireConfirmedState || (dialogCurrent(context, flight.sessionToken) && detailCurrent(context, flight.sessionToken)
        && publicationEditorCurrent(context) && !context.invalidated
        && publicationSignature(currentWorldDetail) === context.confirmedSignature));
  }

  function publicationPreflightCurrent(flight) {
    return publicationFlightCurrent(flight) && dialogCurrent(flight.context, flight.sessionToken)
      && detailCurrent(flight.context, flight.sessionToken) && publicationEditorCurrent(flight.context);
  }

  async function publicationWorld(context, current) {
    const response = await apiCall(`/api/vrc/worlds/${encodeURIComponent(context.worldId)}`, {
      noAbort: true, noCache: true, noDedupe: true,
    });
    if (!current()) return null;
    const world = await jsonOrNull(response);
    if (!current()) return null;
    if (!response.ok || world?.error) throw new Error(responseMessage(world, response));
    if (!authoritativeWorld(world, context, {}) || typeof world.releaseStatus !== 'string' || !world.releaseStatus
        || !Array.isArray(world.tags) || world.tags.some(tag => typeof tag !== 'string')) {
      throw new Error(message('world.manage.responseInvalid', 'The server did not return a matching world record.'));
    }
    return world;
  }

  function rebasePublicationEditor(world, context) {
    if (!publicationEditorCurrent(context) || !detailCurrent(context)) return;
    const editor = context.operation === 'edit' ? context : context.editorContext;
    const controls = editControls();
    const initialValues = {};
    for (const field of Object.keys(FIELD_IDS)) {
      const dirty = controls[field].value !== editor.initialValues[field];
      const draft = controls[field].value;
      controls[field].value = editValue(world, field);
      initialValues[field] = controls[field].value; // Read normalized browser control values.
      if (dirty) controls[field].value = draft;
    }
    editor.originalWorld = frozenCopy(world);
    editor.initialValues = Object.freeze(initialValues);
    editor.publicationState = 'unchecked';
    editor.publicationNotice = '';
    element('worldEditReleaseStatus').textContent = publicationLabel(world);
  }

  async function syncPublicationWorld(world, flight, hook) {
    const options = callbackOptions(flight);
    if (!options.isOperationCurrent()) return false;
    rebasePublicationEditor(world, flight.context);
    await hook(world, options);
    return options.isOperationCurrent();
  }

  function publicationResult(world, action) {
    const applied = (action === 'publish' && publicationAction(world) === 'unpublish')
      || (action === 'unpublish' && publicationAction(world) === 'publish');
    return message('world.publication.' + (applied ? action === 'publish' ? 'published' : 'unpublished' : 'stateChanged'), applied
      ? action === 'publish' ? 'Publication completed.' : 'Unpublication completed.' : 'The publication state changed. Review the current status.')
      + ' ' + publicationLabel(world);
  }

  async function confirmWorldPublication() {
    const context = publicationContext;
    if (!context || context.invalidated || !publicationEditorCurrent(context) || !detailCurrent(context)
        || publicationChange(context.worldId) || context.action !== publicationAction(context.editorContext.originalWorld)
        || (context.action === 'publish' && context.editorContext.publicationState !== 'eligible')) return false;
    const hook = typeof applyWorldManagementUpdate === 'function' ? applyWorldManagementUpdate : null;
    if (!hook) { status(context, message('world.manage.integrationUnavailable', 'World management is not ready.')); return false; }
    const flight = beginOperation(context, makeAuthSessionToken());
    if (!flight) return false;
    invalidatePublicationRead();
    const options = callbackOptions(flight);
    const preflightCurrent = () => publicationPreflightCurrent(flight) && !context.invalidated;
    const operationCurrent = () => publicationFlightCurrent(flight);
    let phase = 'check';
    let change = null;
    status(context, message('world.publication.checking', 'Checking publication eligibility…'));
    try {
      const fresh = await publicationWorld(context, preflightCurrent);
      if (!fresh || !preflightCurrent()) return false;
      if (publicationSignature(fresh) !== context.confirmedSignature || publicationAction(fresh) !== context.action) {
        context.invalidated = true;
        await syncPublicationWorld(fresh, flight, hook);
        if (options.isOperationCurrent()) publicationNotice(context, message('world.publication.stateChanged', 'The publication state changed. Review the current status.'));
        return false; // Never replay a confirmed action against a changed state.
      }
      rebasePublicationEditor(fresh, context);
      if (context.action === 'publish') {
        const eligible = await publicationEligibility(context.worldId, preflightCurrent);
        if (!preflightCurrent() || eligible === null) return false;
        context.editorContext.publicationState = eligible ? 'eligible' : 'blocked';
        if (!eligible) {
          publicationNotice(context, message('world.publication.cannotPublish', 'VRChat does not currently allow this world to be published.'));
          return false;
        }
      }
      if (!preflightCurrent()) return false;
      phase = 'write';
      change = { sessionToken: flight.sessionToken, action: context.action, committed: false, message: '' };
      publicationChanges.set(context.worldId, change); // Remember uncertain outcomes as well as committed writes.
      status(context, message('world.publication.' + (context.action === 'publish' ? 'publishing' : 'unpublishing'), context.action === 'publish' ? 'Publishing…' : 'Unpublishing…'));
      const response = await apiCall(`/api/vrc/worlds/${encodeURIComponent(context.worldId)}/publish`, {
        method: context.action === 'publish' ? 'PUT' : 'DELETE', noAbort: true, noCache: true, noDedupe: true,
      });
      if (!operationCurrent()) return false;
      const body = response.status === 204 ? null : await jsonOrNull(response);
      if (!operationCurrent()) return false;
      if (!response.ok || body?.error) {
        publicationChanges.delete(context.worldId); // Explicit rejection is retryable; transport errors are not.
        change = null;
        throw new Error(responseMessage(body, response));
      }
      change.committed = true;
      context.invalidated = true;
      phase = 'refresh';
      const world = await publicationWorld(context, options.isOperationCurrent);
      if (!world || !options.isOperationCurrent()) return false;
      phase = 'sync';
      if (!await syncPublicationWorld(world, flight, hook)) return false;
      publicationNotice(context, publicationResult(world, context.action));
      if (publicationAction(world) === 'publish') {
        phase = 'check';
        if (publicationEditorCurrent(context)) context.editorContext.publicationState = 'checking';
        const eligible = await publicationEligibility(context.worldId, operationCurrent);
        if (!operationCurrent() || eligible === null) return false;
        if (publicationEditorCurrent(context)) {
          context.editorContext.publicationState = eligible ? 'eligible' : 'blocked';
          if (!eligible) publicationNotice(context, message('world.publication.cannotPublish', 'VRChat does not currently allow this world to be published.'));
        }
      }
      publicationChanges.delete(context.worldId);
      return true; // Keep the matching editor and its unsaved drafts; show actual returned state.
    } catch (error) {
      if (!options.isOperationCurrent()) return false;
      const key = change ? phase === 'sync' ? 'syncFailed' : change.committed ? 'changedRefreshFailed' : 'outcomeUnknown'
        : phase === 'check' ? 'checkFailed' : context.action === 'publish' ? 'publishFailed' : 'unpublishFailed';
      const fallback = change ? phase === 'sync' ? 'Publication changed, but updating the local view failed: {msg}'
        : change.committed ? 'The publication request succeeded, but refreshing the world failed: {msg}'
          : 'The publication request outcome is unknown; refresh the world before trying again: {msg}'
        : phase === 'check' ? 'Checking publication failed: {msg}' : context.action === 'publish' ? 'Publish failed: {msg}' : 'Unpublish failed: {msg}';
      const text = message('world.publication.' + key, fallback, { msg: error.message });
      if (change) change.message = text;
      else if (phase === 'check' && publicationEditorCurrent(context)) context.editorContext.publicationState = 'blocked';
      publicationNotice(context, text);
      return false;
    } finally {
      finishOperation(flight);
    }
  }

  async function refreshWorldPublicationStatus() {
    const editor = editContext;
    if (!editor || !publicationWidgets() || !publicationEditorCurrent(editor) || alreadyDeleted(editor.worldId)
        || activeFlight(editor.worldId)) return false;
    const context = publicationContext && dialogCurrent(publicationContext) && publicationEditorCurrent(publicationContext) ? publicationContext : editor;
    const hook = typeof applyWorldManagementUpdate === 'function' ? applyWorldManagementUpdate : null;
    if (!hook) { publicationNotice(context, message('world.manage.integrationUnavailable', 'World management is not ready.')); syncPublicationUi(); return false; }
    const flight = beginOperation(context, makeAuthSessionToken());
    if (!flight) return false;
    invalidatePublicationRead();
    editor.publicationState = 'checking';
    editor.publicationNotice = '';
    const current = () => publicationFlightCurrent(flight);
    const change = publicationChange(editor.worldId);
    let phase = 'refresh';
    try {
      const world = await publicationWorld(context, current);
      if (!world || !current()) return false;
      if (context !== editor && publicationSignature(world) !== context.confirmedSignature) context.invalidated = true;
      phase = 'sync';
      if (!await syncPublicationWorld(world, flight, hook) || !current()) return false;
      publicationChanges.delete(editor.worldId);
      if (change) publicationNotice(context, publicationResult(world, change.action));
      else if (context.invalidated) publicationNotice(context, message('world.publication.stateChanged', 'The publication state changed. Review the current status.'));
      phase = 'check';
      if (publicationAction(world) === 'publish') {
        editor.publicationState = 'checking';
        const eligible = await publicationEligibility(editor.worldId, current);
        if (!current() || eligible === null) return false;
        editor.publicationState = eligible ? 'eligible' : 'blocked';
        if (!eligible) publicationNotice(context, message('world.publication.cannotPublish', 'VRChat does not currently allow this world to be published.'));
      }
      return true;
    } catch (error) {
      if (!current()) return false;
      editor.publicationState = 'blocked';
      const pending = publicationChange(editor.worldId);
      const key = pending ? phase === 'sync' ? 'syncFailed' : pending.committed ? 'changedRefreshFailed' : 'outcomeUnknown' : 'checkFailed';
      const text = message('world.publication.' + key, pending
        ? phase === 'sync' ? 'Publication changed, but updating the local view failed: {msg}'
          : pending.committed ? 'The publication request succeeded, but refreshing the world failed: {msg}'
            : 'The publication request outcome is unknown; refresh the world before trying again: {msg}'
        : 'Checking publication failed: {msg}', { msg: error.message });
      if (pending) pending.message = text;
      publicationNotice(context, text);
      return false;
    } finally {
      if (current() && editor.publicationState === 'checking') editor.publicationState = 'unchecked';
      finishOperation(flight);
    }
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
        || element(context.operation === 'edit' ? 'worldEditId' : context.operation === 'delete' ? 'worldDeleteConfirmId' : 'worldPublicationConfirmId')?.textContent !== context.worldId) {
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
    invalidatePublicationRead();
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
      isDetailCurrent: () => detailCurrent(context, flight.sessionToken)
        && (!['publish', 'unpublish'].includes(context.operation) || publicationEditorCurrent(context)),
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
    if (activeFlight(context.worldId) || publicationChange(context.worldId)) return false;
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
    openWorldPublicationConfirm,
    closeWorldPublicationConfirm,
    confirmWorldPublication,
    refreshWorldPublicationStatus,
  });
  // Register private function references, not shell/global wrappers. Lazy
  // callers must dispatch to modules.worldManagement, not modules.worlds.
  if (typeof VRCW !== 'undefined' && typeof VRCW.registerModule === 'function') VRCW.registerModule('worldManagement', handlers);
  Object.assign(window, handlers);
})();
