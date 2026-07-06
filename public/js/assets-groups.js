/*
 * VRCW - assets-groups.js
 * Heavy assets/economy panel logic. Global nav and groups live in groups-shell.js.
 */

// ── Assets caching helpers ───────────────────────────────────────────────
// Every assets sub-page used to round-trip /api/vrc/auth/user just to get the
// caller's own id, then fire its real request — 2 serial calls per sub-page
// open, no cache at all. getMyId() reuses the session-global currentUserId
// (set during showMainApp) and only falls back to /auth/user when it's missing.
// Each cacheable sub-page stores its raw API response in IDB under
// `assets_<page>` with an age stamp; TTL varies by how stale-prone the data is.
const ASSETS_CACHE_TTL_MS = 2 * 60 * 1000;   // 2 min — tx/sub/inventory/props/gallery/prints/emoji
const BALANCE_CACHE_TTL_MS = 30 * 1000;       // 30s — balance changes right after a purchase

async function getMyId() {
  if (typeof currentUserId !== 'undefined' && currentUserId) return currentUserId;
  try {
    const me = await (await apiCall('/api/vrc/auth/user')).json();
    if (me && me.id) return me.id;
  } catch (_) {}
  return '';
}

// Read a cached asset payload. Returns { data, fresh } where fresh means the
// TTL hasn't expired (caller can skip the API entirely).
async function readAssetsCache(page, ttlMs) {
  try {
    const data = await idb.get('assets_' + page);
    if (data == null) return { data: null, fresh: false };
    const age = (await idb.get('assets_age_' + page)) || 0;
    return { data, fresh: age > 0 && (Date.now() - age) < ttlMs };
  } catch (_) {
    return { data: null, fresh: false };
  }
}

async function writeAssetsCache(page, data) {
  try {
    await idb.set('assets_' + page, data);
    await idb.set('assets_age_' + page, Date.now());
  } catch (_) {}
}

// Drop every assets cache (called on logout so a different account doesn't
// briefly show the previous user's wallet / inventory).
function invalidateAssetsCache() {
  const pages = ['balance', 'store', 'tx', 'sub', 'gallery', 'prints', 'emoji', 'inventory', 'props'];
  pages.forEach(p => {
    try { idb.set('assets_age_' + p, 0); } catch (_) {}
  });
}

function initAssetsTab() {
  document.querySelectorAll('#assetsPanel .cat-btn').forEach(b => b.classList.remove('active', 'btn-primary'));
  const btn = document.getElementById('cat-assets-balance');
  if (btn) {
    btn.classList.add('active', 'btn-primary');
    switchAssetsPage('balance');
  }
}

let _assetsGen = 0;  // incremented each time a sub-tab is clicked

function switchAssetsPage(page) {
  document.querySelectorAll('#assetsPanel .cat-btn').forEach(b => b.classList.remove('active', 'btn-primary'));
  const btn = document.getElementById('cat-assets-' + page);
  if (btn) btn.classList.add('active', 'btn-primary');

  const content = document.getElementById('assetsContentArea');
  content.innerHTML = `<div style="color:var(--text-muted);margin:20px;">${t('assets.loading')}</div>`;

  const gen = ++_assetsGen;  // capture current generation
  if (page === 'balance') fetchBalance(content, gen);
  else if (page === 'store') fetchStore(content, gen);
  else if (page === 'tx') fetchTransactions(content, gen);
  else if (page === 'sub') fetchSubscriptions(content, gen);
  else if (page === 'gallery') fetchGalleryOnly(content, gen);
  else if (page === 'prints') fetchPrints(content, gen);
  else if (page === 'emoji') fetchEmoji(content, gen);
  else if (page === 'inventory') fetchInventory(content, gen);
  else if (page === 'props') fetchProps(content, gen);
}

async function fetchBalance(container, gen) {
  // Balance is the most stale-prone asset (changes the instant you buy
  // something), so it gets the shortest TTL — 30s. Still beats re-fetching
  // on every sub-page switch within half a minute.
  const { data: cached, fresh } = await readAssetsCache('balance', BALANCE_CACHE_TTL_MS);
  if (fresh && cached) {
    if (_assetsGen !== gen) return;
    _renderBalance(container, cached);
    return;
  }
  try {
    const myId = await getMyId();
    if (_assetsGen !== gen) return;
    if (!myId) throw new Error("Not logged in");
    const bal = await (await apiCall(`/api/vrc/user/${myId}/balance`, { noAbort: true })).json();
    if (_assetsGen !== gen) return;
    await writeAssetsCache('balance', bal);
    _renderBalance(container, bal);
  } catch(e) {
    if (isAbortError(e)) return;  // tab switch cancelled — not a real failure
    if (_assetsGen !== gen) return;
    // Keep stale cache visible on transient failure instead of a red error.
    if (cached) _renderBalance(container, cached);
    else container.innerHTML = `<div style="color:var(--error);">Failed to load balance: ${escHtml(String(e.message))}</div>`;
  }
}

function _renderBalance(container, bal) {
  container.innerHTML = `
    <h2 style="margin-bottom:16px;"><i class="fa-solid fa-wallet"></i> ${t('assets.wallet')}</h2>
    <div class="my-profile-card" style="display:flex;align-items:center;gap:20px;max-width:400px;">
      <div style="width:60px;height:60px;background:var(--bg-glass);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:2rem;color:var(--warning);"><i class="fa-solid fa-coins"></i> </div>
      <div>
        <div style="font-size:0.8rem;color:var(--text-muted);">${t('assets.currentCredits')}</div>
        <div style="font-size:1.8rem;font-weight:700;color:var(--text-primary);">${escHtml(String(bal.balance||0))} <span style="font-size:0.5em;color:var(--text-muted);">VRC</span></div>
      </div>
    </div>
    <p style="margin-top:12px;color:var(--text-muted);font-size:0.85rem;">${t('assets.walletHint')}</p>
  `;
}

async function fetchStore(container, gen) {
  try {
    container.innerHTML = `<div style="color:var(--text-muted);margin:20px;">${t('assets.loadingStore')}</div>`;
    const [balResp, listResp] = await Promise.all([
      apiCall('/api/vrc/economy/balance', { noAbort: true }),
      apiCall('/api/vrc/economy/listings?n=20&offset=0', { noAbort: true })
    ]);
    if (_assetsGen !== gen) return;

    let balHtml = '';
    if (balResp.ok) {
      const bal = await balResp.json();
      const credits = bal.balance ?? bal.credits ?? bal.amount ?? '—';
      balHtml = `<div style="display:flex;align-items:center;gap:12px;padding:14px 18px;background:linear-gradient(135deg,rgba(255, 255, 255, 0.15),rgba(255, 255, 255, 0.1));border:1px solid rgba(255, 255, 255, 0.3);border-radius:12px;margin-bottom:20px;">
        <span style="font-size:1.6em;"><i class="fa-solid fa-gem" style="color: #00f2fe;"></i> </span>
        <div>
          <div style="font-size:0.75em;color:var(--text-muted);font-weight:600;letter-spacing:.05em;text-transform:uppercase;">VRChat Credits</div>
          <div style="font-size:1.4em;font-weight:700;color:#d4d4d8;">${escHtml(String(credits))}</div>
        </div>
        <a href="https://vrchat.com/home/marketplace/storefront" target="_blank" class="btn btn-secondary" style="margin-left:auto;font-size:0.8em;">${t('assets.openStore')}</a>
      </div>`;
    }

    let listingsHtml = '';
    if (listResp.ok) {
      const data = await listResp.json();
      const items = Array.isArray(data) ? data : (data.listings || data.results || []);
      if (items.length) {
        listingsHtml = `<h3 style="font-size:0.9rem;margin-bottom:12px;">${t('assets.storeItems')}</h3>` +
          '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;">' +
          items.map(item => {
            const img = proxyImg(item.thumbnailImageUrl || item.imageUrl || '');
            const name = escHtml(item.displayName || item.name || item.id || t('assets.product'));
            const price = item.priceTokens != null ? `<i class="fa-solid fa-gem" style="color: #00f2fe;"></i> ${item.priceTokens}` : (item.price ? `$${(item.price/100).toFixed(2)}` : '');
            const type = escHtml(item.productType || item.type || '');
            return `<div style="background:var(--bg-glass);border:1px solid var(--border);border-radius:10px;overflow:hidden;cursor:pointer;" onclick="window.open('https://vrchat.com/home/marketplace','_blank')">
              ${img ? `<img src="${img}" style="width:100%;aspect-ratio:4/3;object-fit:cover;" loading="lazy" onerror="this.style.display='none'">` : '<div style="width:100%;aspect-ratio:4/3;background:var(--bg-secondary);"></div>'}
              <div style="padding:8px 10px;">
                <div style="font-size:0.85em;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${name}</div>
                <div style="font-size:0.72em;color:var(--text-muted);">${type}</div>
                ${price ? `<div style="font-size:0.8em;color:#d4d4d8;font-weight:600;margin-top:4px;">${price}</div>` : ''}
              </div>
            </div>`;
          }).join('') + '</div>';
      } else {
        listingsHtml = `<div style="color:var(--text-muted);font-size:0.85em;">${t('assets.noListings')}</div>`;
      }
    } else {
      // Listings may require special perms - just link to website
      listingsHtml = `<div style="padding:20px;text-align:center;background:var(--bg-glass);border:1px solid var(--border);border-radius:10px;">
        <div style="font-size:2em;margin-bottom:8px;"><i class="fa-solid fa-shop"></i> </div>
        <div style="font-size:0.85em;color:var(--text-muted);margin-bottom:12px;">${t('assets.viewListingsOnSite')}</div>
        <a href="https://vrchat.com/home/marketplace/storefront" target="_blank" class="btn btn-primary" style="font-size:0.85em;">${t('assets.openVrcStore')}</a>
      </div>`;
    }

    container.innerHTML = `<h2 style="margin-bottom:16px;"><i class="fa-solid fa-shop"></i> ${t('assets.store')}</h2>` + balHtml + listingsHtml;
  } catch(e) {
    if (isAbortError(e)) return;
    container.innerHTML = `<div style="color:var(--error);">${t('toast.loadFailMsg', {msg: e.message})}</div>`;
  }
}

async function fetchTransactions(container, gen) {
  try {
    // Cache-first: transactions rarely change, 2-min TTL avoids re-fetching
    // on every sub-page switch.
    const { data: cached, fresh } = await readAssetsCache('tx', ASSETS_CACHE_TTL_MS);
    let tx;
    if (fresh && cached) {
      tx = cached;
    } else {
      const r = await apiCall('/api/vrc/Steam/transactions');
      if (gen != null && _assetsGen !== gen) return;
      if (!r.ok) throw new Error('HTTP ' + r.status);
      tx = await r.json();
      if (gen != null && _assetsGen !== gen) return;
      await writeAssetsCache('tx', tx);
    }
    container.innerHTML = `<h2 style="margin-bottom:16px;"><i class="fa-solid fa-money-bill-transfer"></i> ${t('assets.transactions')}</h2>`;
    if (!tx || (Array.isArray(tx) && tx.length === 0)) {
      container.innerHTML += `<div style="color:var(--text-muted);">${t('assets.noTransactions')}</div>`;
      return;
    }
    const items = Array.isArray(tx) ? tx : [tx];
    const statusColors = {succeeded:'#86efac',expired:'#fbbf24',failed:'#f87171'};
    const statusLabels = {succeeded:t('assets.tx.succeeded'),expired:t('assets.tx.expired'),failed:t('assets.tx.failed')};
    container.innerHTML += items.map(t => {
      const sub = t.subscription || {};
      const amt = t.amount || sub.amount;
      const amtStr = amt ? (amt / 100).toFixed(2) : '—';
      const created = t.created_at ? new Date(t.created_at).toLocaleString(getLocale(),{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : '';
      const st = t.status || 'unknown';
      const stColor = statusColors[st] || 'var(--text-muted)';
      const stLabel = statusLabels[st] || st;
      const giftTo = t.isGift && t.targetDisplayName ? ' → <i class="fa-solid fa-gift"></i> ' + escHtml(t.targetDisplayName) : '';
      const isCredits = t.active && t.orderId && t.orderId.startsWith('tx_');
      
      return `<div style="display:flex;align-items:center;gap:12px;padding:12px 16px;background:var(--bg-glass);border:1px solid var(--border);border-radius:12px;margin-bottom:8px; transition: transform 0.2s;" onmouseover="this.style.transform='translateX(4px)'" onmouseout="this.style.transform='none'">
        <div style="width:36px;height:36px;border-radius:50%;background:${isCredits ? 'rgba(255, 255, 255, 0.1)' : 'rgba(255, 255, 255, 0.1)'};display:flex;align-items:center;justify-content:center;font-size:1.1em;border:1px solid var(--border);">
          ${isCredits ? '<i class="fa-solid fa-gem" style="color: #00f2fe;"></i> ' : '<i class="fa-solid fa-credit-card"></i> '}
        </div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;font-size:0.85em;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(sub.description || t.id || t('assets.transaction'))} ${giftTo}</div>
          <div style="font-size:0.68em;color:var(--text-muted);margin-top:2px;">${created} · ID: ${escHtml(t.id?.substring(0,8))}</div>
        </div>
        <div style="text-align:right;flex-shrink:0;">
          <div style="font-size:0.9em;font-weight:700;color:var(--text-primary);">$${amtStr} <span style="font-size:0.75em;opacity:0.6;font-weight:400;">USD</span></div>
          <div style="font-size:0.7em;font-weight:700;color:${stColor};margin-top:2px;">${stLabel}</div>
        </div>
      </div>`;
    }).join('');
  } catch(e) {
    if (isAbortError(e)) return;
    container.innerHTML = `<div style="color:var(--error);">${t('toast.loadFailMsg', {msg: e.message})}</div>`;
  }
}

async function fetchSubscriptions(container, gen) {
  try {
    const { data: cached, fresh } = await readAssetsCache('sub', ASSETS_CACHE_TTL_MS);
    let subs;
    if (fresh && cached) {
      subs = cached;
    } else {
      subs = await (await apiCall('/api/vrc/auth/user/subscription')).json();
      if (gen != null && _assetsGen !== gen) return;
      await writeAssetsCache('sub', subs);
    }
    container.innerHTML = `<h2 style="margin-bottom:16px;"><i class="fa-solid fa-star"></i> ${t('assets.vrcPlus')}</h2>`;
    if (!subs || subs.length === 0) {
      container.innerHTML += `<div style="color:var(--text-muted);">${t('assets.noSubscriptions')}</div>`;
      return;
    }
    container.innerHTML += subs.map(s => `<div class="my-profile-card" style="margin-bottom:12px;">
      <h3 style="color:#d4d4d8;margin-bottom:4px;">${escHtml(s.description || s.tier || 'VRChat Plus')}</h3>
      <div style="font-size:0.8rem;color:var(--text-secondary);">
        ${t('assets.status')}: <span style="color:var(--success);">${escHtml(s.status || 'active')}</span><br>
        ${t('assets.type')}: ${escHtml(s.store || 'Unknown')}<br>
        ${t('assets.expiresAt')}: ${escHtml(s.expires ? new Date(s.expires).toLocaleString() : t('assets.permanent'))}
      </div>
    </div>`).join('');
  } catch(e) {
    container.innerHTML = `<div style="color:var(--error);">Failed to load subscriptions: ${escHtml(e.message)}</div>`;
  }
}

async function fetchEmoji(container, gen) {
  try {
    // 3 parallel API calls per open — cache the whole bundle.
    const { data: cached, fresh } = await readAssetsCache('emoji', ASSETS_CACHE_TTL_MS);
    let emojis, emojisAnim, stickers;
    if (fresh && cached) {
      emojis = cached.emojis || [];
      emojisAnim = cached.emojisAnim || [];
      stickers = cached.stickers || [];
    } else {
      container.innerHTML = `<div style="color:var(--text-muted);margin:20px;">${t('assets.loadingShort')}</div>`;
      const [rEmoji, rEmojiAnim, rSticker] = await Promise.all([
        apiCall('/api/vrc/files?tag=emoji&n=100'),
        apiCall('/api/vrc/files?tag=emojianimated&n=100'),
        apiCall('/api/vrc/files?tag=sticker&n=100'),
      ]);
      emojis = rEmoji.ok ? await rEmoji.json() : [];
      emojisAnim = rEmojiAnim.ok ? await rEmojiAnim.json() : [];
      stickers = rSticker.ok ? await rSticker.json() : [];
      if (_assetsGen !== gen) return;
      await writeAssetsCache('emoji', { emojis, emojisAnim, stickers });
    }
    const allEmojis = emojis.concat(emojisAnim);

    const renderFileGrid = (files, emptyText) => {
      if (!files || !files.length) return '<div style="color:var(--text-muted);font-size:0.85em;margin-bottom:20px;">' + emptyText + '</div>';
      return '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:10px;margin-bottom:20px;">' +
        files.map(f => {
          const imgUrl = proxyImg(extractFileVersionUrl(f));
          const animMeta = getEmojiAnimMeta(f);
          const isAnimated = !!animMeta || (f.tags && f.tags.includes('emojianimated'));
          // For animated emoji with frame metadata, render an animated spritesheet tile.
          const TILE = 56;
          let media;
          if (animMeta) {
            const innerStyle = animatedEmojiStyle(imgUrl, animMeta.fps, animMeta.frames, animMeta.loopStyle, TILE);
            media = '<div style="width:' + TILE + 'px;height:' + TILE + 'px;overflow:hidden;position:relative;">' +
                      '<div style="' + innerStyle + '"></div>' +
                    '</div>';
          } else {
            media = '<img src="' + escHtml(imgUrl) + '" style="width:' + TILE + 'px;height:' + TILE + 'px;object-fit:contain;" loading="lazy" onerror="this.style.opacity=\'0.3\'">';
          }
          return '<div title="' + escHtml(f.name || f.id) + '" style="background:var(--bg-glass);border:1px solid var(--border);border-radius:8px;overflow:hidden;display:flex;flex-direction:column;align-items:center;padding:6px;gap:4px;position:relative;">' +
            (isAnimated ? `<span style="position:absolute;top:4px;right:4px;font-size:0.55em;background:#52525b;color:#fff;padding:1px 4px;border-radius:3px;z-index:2;">${t('assets.animated')}</span>` : '') +
            media +
            '<div style="font-size:0.6em;color:var(--text-muted);text-align:center;width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escHtml(f.name || '') + '</div>' +
          '</div>';
        }).join('') +
      '</div>';
    };

    container.innerHTML = `<h2 style="margin-bottom:16px;"><i class="fa-solid fa-face-smile"></i> ${t('assets.emoji')}</h2>` +
      '<div class="vrc-upload-row">' +
        makeUploadCard({title:t('assets.uploadStaticEmoji'), hint:t('assets.uploadStaticEmojiHint'), tag:'emoji', accept:'image/png,image/jpeg,image/webp', refreshPage:'emoji'}) +
        makeUploadCard({title:t('assets.uploadAnimEmoji'), hint:t('assets.uploadAnimEmojiHint'), tag:'emojianimated', accept:'image/gif', refreshPage:'emoji'}) +
        makeUploadCard({title:t('assets.uploadSticker'), hint:t('assets.uploadStickerHint'), tag:'sticker', accept:'image/png,image/jpeg,image/webp', refreshPage:'emoji'}) +
      '</div>' +
      `<h3 style="font-size:0.9rem;margin-bottom:10px;">${t('assets.customEmojis', {count: allEmojis.length})}</h3>` +
      renderFileGrid(allEmojis, t('assets.noCustomEmojis')) +
      `<h3 style="font-size:0.9rem;margin-bottom:10px;">${t('assets.stickers', {count: stickers.length})}</h3>` +
      renderFileGrid(stickers, t('assets.noStickers'));
  } catch(e) {
    if (isAbortError(e)) return;
    container.innerHTML = `<div style="color:var(--error);">${t('toast.loadFailMsg', {msg: e.message})}</div>`;
  }
}

// ═══════════════════════════════════════════════════════════
// INVENTORY (库存物品: 无人机/传送门/加载屏/掉落物等)
// GET /inventory → { data: [...] } paginated, + GET /inventory/global
// ═══════════════════════════════════════════════════════════
const _equipSlotLabels = { drone: t('assets.slot.drone'), portal: t('assets.slot.portal'), warp: t('assets.slot.warp'), loadingscreen: t('assets.slot.loadingscreen') };

async function fetchInventory(container, gen) {
  try {
    // Inventory pagination can fire up to 5 API calls — cache it hard.
    const { data: cachedItems, fresh } = await readAssetsCache('inventory', ASSETS_CACHE_TTL_MS);
    let items;
    if (fresh && Array.isArray(cachedItems)) {
      items = cachedItems;
    } else {
      container.innerHTML = `<div style="color:var(--text-muted);margin:20px;">${t('assets.loadingInventory')}</div>`;
      items = [];
      // Paginate (cap at a few pages to stay within request budget)
      for (let i = 0; i < 5; i++) {
        const r = await apiCall(`/api/vrc/inventory?n=100&offset=${i * 100}&order=newest`);
        if (_assetsGen !== gen) return;
        if (!r.ok) break;
        const j = await r.json().catch(() => ({}));
        const batch = j.data || j.items || (Array.isArray(j) ? j : []);
        if (!batch.length) break;
        items.push(...batch);
        if (batch.length < 100) break;
      }
      if (_assetsGen !== gen) return;
      await writeAssetsCache('inventory', items);
    }

    // Group by itemType for readability
    const groups = {};
    for (const it of items) {
      const t = it.itemType || it.type || 'other';
      (groups[t] = groups[t] || []).push(it);
    }
    const typeLabel = { prop: t('assets.type.prop'), emoji: t('assets.type.emoji'), sticker: t('assets.type.sticker'), gift: t('assets.type.gift'), drop: t('assets.type.drop'), other: t('assets.type.other') };

    const card = (it) => {
      const img = proxyImg(it.imageUrl || it.thumbnailImageUrl || (it.metadata && it.metadata.imageUrl) || '');
      const equipped = it.isEquipped || (it.flags && it.flags.includes('equipped'));
      const slot = it.equipSlot || (it.metadata && it.metadata.equipSlot);
      const canEquip = ['drone', 'portal', 'warp', 'loadingscreen'].includes(slot);
      return '<div style="background:var(--bg-glass);border:1px solid var(--border);border-radius:10px;overflow:hidden;display:flex;flex-direction:column;">' +
        (img ? `<img src="${escHtml(img)}" style="width:100%;aspect-ratio:1/1;object-fit:cover;" loading="lazy" onerror="this.style.display='none'">` : '<div style="width:100%;aspect-ratio:1/1;background:var(--bg-secondary);display:flex;align-items:center;justify-content:center;font-size:2em;"><i class="fa-solid fa-gift"></i> </div>') +
        '<div style="padding:8px 10px;display:flex;flex-direction:column;gap:4px;">' +
          `<div style="font-size:0.8em;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(it.name || it.id || '')}</div>` +
          (slot ? `<div style="font-size:0.65em;color:var(--text-muted);">${t('assets.slotLabel')}: ${escHtml(_equipSlotLabels[slot] || slot)}</div>` : '') +
          (canEquip ? `<button class="btn btn-secondary" style="font-size:0.7em;padding:4px;" onclick="equipInventoryItem('${escJsAttr(it.id)}','${escJsAttr(slot)}',${equipped ? 'true' : 'false'})">${equipped ? t('assets.unequip') : t('assets.equip')}</button>` : '') +
        '</div></div>';
    };

    let html = `<h2 style="margin-bottom:16px;">${t('assets.itemsTitle', {count: items.length})}</h2>`;
    if (!items.length) {
      html += `<div style="color:var(--text-muted);font-size:0.9em;">${t('assets.noInventory')}</div>`;
    } else {
      for (const [t2, list] of Object.entries(groups)) {
        html += `<h3 style="font-size:0.9rem;margin:14px 0 10px;">${typeLabel[t2] || ('<i class="fa-solid fa-box"></i> ' + t2)} (${list.length})</h3>`;
        html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:12px;">' +
          list.map(card).join('') + '</div>';
      }
    }
    container.innerHTML = html;
  } catch(e) {
    if (isAbortError(e)) return;
    container.innerHTML = `<div style="color:var(--error);">${t('toast.loadFailMsg', {msg: escHtml(e.message)})}</div>`;
  }
}

async function equipInventoryItem(inventoryId, slot, currentlyEquipped) {
  try {
    let r;
    if (currentlyEquipped) {
      r = await apiCall(`/api/vrc/inventory/${inventoryId}/equip`, { method: 'DELETE' });
    } else {
      r = await apiCall(`/api/vrc/inventory/${inventoryId}/equip`, { method: 'PUT', json: { equipSlot: slot } });
    }
    if (r.ok) {
      showToast(currentlyEquipped ? t('assets.unequipped') : t('assets.equipped'), 'success');
      // Equipment state changed — drop the cache so the reload shows it.
      try { idb.set('assets_age_inventory', 0); } catch (_) {}
      switchAssetsPage('inventory');
    } else {
      const err = await r.json().catch(() => ({}));
      showToast(t('assets.equipFail', {action: currentlyEquipped ? t('assets.unequip') : t('assets.equip'), msg: (err.error?.message || ('HTTP ' + r.status))}), 'error');
    }
  } catch(e) { showToast(t('toast.errorMsg', {msg: e.message}), 'error'); }
}

// ═══════════════════════════════════════════════════════════
// PROPS (道具) — GET /props, GET /props/{id}
// ═══════════════════════════════════════════════════════════
async function fetchProps(container, gen) {
  try {
    const { data: cached, fresh } = await readAssetsCache('props', ASSETS_CACHE_TTL_MS);
    let props;
    if (fresh && Array.isArray(cached)) {
      props = cached;
    } else {
      container.innerHTML = `<div style="color:var(--text-muted);margin:20px;">${t('assets.loadingProps')}</div>`;
      const myId = await getMyId();
      if (_assetsGen !== gen) return;
      if (!myId) throw new Error(t('assets.notLoggedIn'));
      // /props lists the current user's props (owned)
      const r = await apiCall(`/api/vrc/props?userId=${myId}&n=100`);
      if (_assetsGen !== gen) return;
      props = r.ok ? await r.json().catch(() => []) : [];
      if (!Array.isArray(props)) props = props.data || [];
      await writeAssetsCache('props', props);
    }

    let html = `<h2 style="margin-bottom:16px;">${t('assets.propsTitle', {count: props.length})}</h2>`;
    if (!props.length) {
      html += `<div style="color:var(--text-muted);font-size:0.9em;">${t('assets.noProps')}</div>`;
    } else {
      html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px;">' +
        props.map(p => {
          const img = proxyImg(p.imageUrl || p.thumbnailImageUrl || '');
          const published = p.releaseStatus === 'public' || p.published;
          return '<div style="background:var(--bg-glass);border:1px solid var(--border);border-radius:10px;overflow:hidden;">' +
            (img ? `<img src="${escHtml(img)}" style="width:100%;aspect-ratio:1/1;object-fit:cover;" loading="lazy" onerror="this.style.display='none'">` : '<div style="width:100%;aspect-ratio:1/1;background:var(--bg-secondary);display:flex;align-items:center;justify-content:center;font-size:2em;"><i class="fa-solid fa-wand-magic-sparkles"></i> </div>') +
            '<div style="padding:8px 10px;">' +
              `<div style="font-size:0.82em;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(p.name || p.id || '')}</div>` +
              `<div style="font-size:0.65em;color:${published ? '#4ade80' : 'var(--text-muted)'};margin-top:2px;">${published ? t('assets.published') : t('assets.unpublished')}</div>` +
            '</div></div>';
        }).join('') + '</div>';
    }
    container.innerHTML = html;
  } catch(e) {
    if (isAbortError(e)) return;
    container.innerHTML = `<div style="color:var(--error);">${t('toast.loadFailMsg', {msg: escHtml(e.message)})}</div>`;
  }
}


VRCW.registerModule('assets', {
  initAssetsTab,
  switchAssetsPage,
  fetchBalance,
  fetchStore,
  fetchTransactions,
  fetchSubscriptions,
  fetchEmoji,
  fetchInventory,
  equipInventoryItem,
  fetchProps,
});
renderAppVersionInfo();
