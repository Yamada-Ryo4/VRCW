/* Shared cloud favorite membership and serialized folder changes. */
const favoriteMenuFlights = new Map();
let favoriteMenuRevision = 0;

function favoriteGroupNames(type, id) {
  if (type === 'avatar') return new Set(avatarFavTagMap.get(id) || []);
  return new Set([...worldFavoriteIndexByGroup].filter(([, ids]) => ids.includes(id)).map(([name]) => name));
}

function favoriteGroupDisplayText(type, group, count, saved, full) {
  const cap = type === 'avatar' ? 50 : 100;
  const countHtml = `<span style="margin-left:4px;font-size:0.8em;opacity:0.7;color:${full && !saved ? '#f87171' : 'inherit'}">(${Number.isFinite(count) ? count : '…'}/${cap})</span>`;
  const name = escHtml(group.displayName || group.name);
  if (saved) return `<span class="favorite-menu-check" aria-hidden="true">✓ </span><span>${name}</span> ${countHtml}`;
  return `<span>${name}</span> ${countHtml}`;
}

function favoriteFolderRows(type, id, groups) {
  const membership = favoriteGroupNames(type, id);
  const counts = type === 'avatar' ? avatarFavGroupCounts : worldFavGroupCounts;
  const cap = type === 'avatar' ? 50 : 100;
  const action = type === 'avatar' ? 'addToFavorite' : 'selectWorldFavoriteGroup';
  const busy = favoriteMenuFlights.has(`${type}:${id}`);
  return groups.map(group => {
    const saved = membership.has(group.name);
    const count = counts.get(group.name);
    const full = Number.isFinite(count) && count >= cap;
    const disabled = busy || (full && !saved);
    const title = saved ? t('world.unfavorite') : full ? t('world.favGroupFull') : '';
    return `<button class="avtrdb-fav-group-btn${saved ? ' avtrdb-fav-group-active' : ''}" data-favgroup="${escHtml(group.name)}" aria-pressed="${saved}" ${disabled ? 'disabled' : ''} title="${escHtml(title)}" onclick="event.stopPropagation();${action}('${escJsAttr(id)}','${escJsAttr(group.name)}',this)">${favoriteGroupDisplayText(type, group, count, saved, full)}</button>`;
  }).join('');
}

async function loadFavoriteMembership(type, id) {
  const session = makeAuthSessionToken();
  const revision = favoriteMenuRevision;
  const records = [];
  const types = type === 'world' ? ['world', 'vrcPlusWorld'] : ['avatar'];
  for (const favoriteType of types) {
    let offset = 0;
    while (true) {
      if (!isAuthSessionCurrent(session)) throw new Error(t('toast.uidMissingRelogin'));
      const response = await apiCall(`/api/vrc/favorites?type=${favoriteType}&n=100&offset=${offset}`, { noAbort: true, noCache: true });
      if (!isAuthSessionCurrent(session)) throw new Error(t('toast.uidMissingRelogin'));
      if (favoriteType === 'vrcPlusWorld' && [403, 404].includes(response.status)) break;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const batch = await response.json();
      if (!Array.isArray(batch)) throw new Error(t('toast.favRecordNotFound'));
      records.push(...batch);
      if (batch.length < 100) break;
      offset += batch.length;
      if (offset >= 10000) throw new Error(t('toast.favRecordNotFound'));
    }
  }
  if (!isAuthSessionCurrent(session)) throw new Error(t('toast.uidMissingRelogin'));
  const matches = records.filter(record => record.favoriteId === id);
  if (revision === favoriteMenuRevision) {
    const counts = type === 'avatar' ? avatarFavGroupCounts : worldFavGroupCounts;
    const index = type === 'avatar' ? avatarFavoriteIndexByGroup : worldFavoriteIndexByGroup;
    const map = type === 'avatar' ? favoriteIdMap : worldFavoriteIdMap;
    const groups = type === 'avatar' ? favoriteGroups : worldFavGroups;
    for (const group of groups) {
      const members = records.filter(record => (record.tags || []).includes(group.name));
      counts.set(group.name, members.length);
      index.set(group.name, members.map(record => record.favoriteId));
    }
    if (matches.length) map.set(id, matches[0].id);
    else map.delete(id);
    if (type === 'avatar') {
      const tags = new Set(matches.flatMap(record => record.tags || []));
      if (tags.size) avatarFavTagMap.set(id, tags);
      else avatarFavTagMap.delete(id);
    }
  }
  return matches;
}

function refreshFavoriteViews(type, id) {
  const groups = type === 'avatar' ? favoriteGroups : worldFavGroups;
  const counts = type === 'avatar' ? avatarFavGroupCounts : worldFavGroupCounts;
  const cap = type === 'avatar' ? 50 : 100;
  for (const group of groups) {
    const button = document.getElementById(type === 'avatar' ? 'cat-' + group.name : 'worldCatFav_' + group.name);
    if (button && counts.has(group.name)) {
      button.textContent = `${group.displayName || group.name} (${counts.get(group.name)}/${cap})`;
    }
  }
  if (type === 'avatar') {
    const detail = document.getElementById('avtrdbDetailModal');
    const detailId = document.getElementById('avtrdbDetailId')?.textContent;
    const detailButton = document.getElementById('avtrdbDetailFavBtn');
    if (detail && !detail.classList.contains('hidden') && detailId === id && detailButton) {
      detailButton.innerHTML = t('avatar.favoriteBtn');
      detailButton.className = 'btn btn-secondary';
      detailButton.setAttribute('aria-haspopup', 'true');
      detailButton.setAttribute('aria-expanded', String(!document.getElementById('avtrdbFavMenu')?.classList.contains('hidden')));
      detailButton.onclick = toggleAvtrdbFavMenu;
    }
    if (typeof _refreshDetailAfterFavChange === 'function') _refreshDetailAfterFavChange(id);
    document.querySelectorAll(`[data-avid="${id}"] .card-fav-quick`).forEach(button => {
      const saved = favoriteIdMap.has(id) || localAvatarIdMap.has(id);
      button.innerHTML = saved ? '<i class="fa-solid fa-star"></i>' : '☆';
      button.title = saved ? t('avatar.favoritedLabel') : t('world.addToFavorites');
    });
    const card = document.getElementById('card-' + id);
    const quick = card?.querySelector('.card-fav-quick');
    if (quick) {
      quick.innerHTML = favoriteIdMap.has(id) || localAvatarIdMap.has(id) ? '<i class="fa-solid fa-star"></i>' : '☆';
    }
  } else if (typeof _refreshWorldFavoriteMenuState === 'function') {
    _refreshWorldFavoriteMenuState(id);
    if (currentWorldDetail?.id === id) {
      for (const buttonId of ['worldDetailMainFavBtn', 'worldDetailFavBtn']) {
        const button = document.getElementById(buttonId);
        if (!button) continue;
        button.setAttribute('aria-haspopup', 'true');
        button.setAttribute('aria-expanded', String(!document.getElementById('worldFavMenu')?.classList.contains('hidden')));
        button.onclick = toggleWorldFavMenu;
      }
    }
    document.querySelectorAll(`[data-fav-btn="${id}"]`).forEach(button => {
      const saved = worldFavoriteIdMap.has(id);
      button.innerHTML = saved ? '<i class="fa-solid fa-star"></i>' : '☆';
      button.title = t('world.addToFavorites');
    });
  }
}

async function applyFavoriteFolderState(type, id, item, record, removed) {
  const map = type === 'avatar' ? favoriteIdMap : worldFavoriteIdMap;
  const counts = type === 'avatar' ? avatarFavGroupCounts : worldFavGroupCounts;
  const index = type === 'avatar' ? avatarFavoriteIndexByGroup : worldFavoriteIndexByGroup;
  const tags = record.tags || [];
  if (removed) map.delete(id);
  else map.set(id, record.id);
  for (const groupName of tags) {
    const members = index.get(groupName) || [];
    index.set(groupName, removed ? members.filter(member => member !== id) : [...new Set([...members, id])]);
    counts.set(groupName, Math.max(0, (counts.get(groupName) || 0) + (removed ? -1 : 1)));
  }
  if (type === 'avatar') {
    const membership = new Set(avatarFavTagMap.get(id) || []);
    for (const tag of tags) removed ? membership.delete(tag) : membership.add(tag);
    if (membership.size) avatarFavTagMap.set(id, membership);
    else avatarFavTagMap.delete(id);
  }
  favoriteMenuRevision++;
  refreshFavoriteViews(type, id);
  const session = makeAuthSessionToken();
  for (const groupName of tags) {
    if (!isAuthSessionCurrent(session)) return;
    if (type === 'avatar') {
      if (removed) await removeAvatarFromFavoriteCache(groupName, id);
      else await upsertAvatarIntoFavoriteCache(groupName, item);
    } else {
      if (removed) await removeWorldFromFavoriteCache(groupName, id);
      else await upsertWorldIntoFavoriteCache(groupName, { ...item, favoriteId: record.id });
    }
  }
  if (!isAuthSessionCurrent(session)) return;
  if (type === 'avatar' && tags.includes(currentCategory)) {
    if (removed) {
      avatars = avatars.filter(avatar => avatar.id !== id);
      visibleAvatars = visibleAvatars.filter(avatar => avatar.id !== id);
      selectedIds.delete(id);
    } else if (!avatars.some(avatar => avatar.id === id)) avatars.unshift(item);
    applyFilters();
    const total = document.getElementById('statTotal');
    if (total) total.textContent = String(avatars.length);
  } else if (type === 'world' && tags.some(tag => currentWorldCategory === 'fav_' + tag)) {
    if (removed) {
      allWorlds = allWorlds.filter(world => world.id !== id);
      selectedWorldIds.delete(id);
    } else if (!allWorlds.some(world => world.id === id)) allWorlds.unshift({ ...item, favoriteId: record.id });
    filterWorlds();
    const stats = document.getElementById('worldStats');
    if (stats) stats.textContent = t('world.worldCount', { count: allWorlds.length });
  }
  refreshFavoriteViews(type, id);
}

async function changeFavoriteFolder(type, id, groupName, item) {
  const key = `${type}:${id}`;
  if (favoriteMenuFlights.has(key)) return;
  const session = makeAuthSessionToken();
  const assertCurrent = () => {
    if (!isAuthSessionCurrent(session)) throw new Error(t('toast.uidMissingRelogin'));
  };
  favoriteMenuFlights.set(key, true);
  refreshFavoriteViews(type, id);
  try {
    const groups = type === 'avatar' ? favoriteGroups : worldFavGroups;
    if (!groups.some(group => group.name === groupName)) throw new Error(t('toast.favRecordNotFound'));
    const records = await loadFavoriteMembership(type, id);
    assertCurrent();
    const removing = records.some(record => (record.tags || []).includes(groupName));
    const counts = type === 'avatar' ? avatarFavGroupCounts : worldFavGroupCounts;
    if (!removing && (counts.get(groupName) || 0) >= (type === 'avatar' ? 50 : 100)) {
      throw new Error(t('world.favGroupFull'));
    }
    const toRemove = removing ? records.filter(record => (record.tags || []).includes(groupName)) : records;
    for (const record of toRemove) {
      const response = await apiCall(`/api/vrc/favorites/${encodeURIComponent(record.id)}`, { method: 'DELETE', noAbort: true });
      assertCurrent();
      if (!response.ok && response.status !== 404) throw new Error(`HTTP ${response.status}`);
      await applyFavoriteFolderState(type, id, item, record, true);
      assertCurrent();
    }
    if (removing) {
      const remaining = records.filter(record => !toRemove.includes(record));
      if (remaining.length) {
        (type === 'avatar' ? favoriteIdMap : worldFavoriteIdMap).set(id, remaining[0].id);
      }
    }
    if (!removing) {
      const favoriteType = type === 'world' && groupName.startsWith('vrcPlusWorlds') ? 'vrcPlusWorld' : type;
      const response = await apiCall('/api/vrc/favorites', {
        method: 'POST', noAbort: true,
        json: { type: favoriteType, favoriteId: id, tags: [groupName] },
      });
      assertCurrent();
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error?.message || `HTTP ${response.status}`);
      }
      const record = await response.json();
      assertCurrent();
      if (!record?.id) throw new Error(t('toast.favRecordNotFound'));
      await applyFavoriteFolderState(type, id, item, { id: record.id, tags: [groupName] }, false);
      assertCurrent();
    }
  } finally {
    favoriteMenuFlights.delete(key);
    if (isAuthSessionCurrent(session)) refreshFavoriteViews(type, id);
  }
}
