/*
 * VRCW — media-profile.js
 * GIF转精灵图/上传卡片/相册/拍立得/邀请自己/管理记录/编辑资料
 *
 * 注意：本项目为「经典脚本」(非 ES module)，全部按顺序加载、共享全局作用域。
 * 函数声明会提升为全局，跨文件调用没问题；请勿改为 type="module"。
 */
// GIF → PNG Spritesheet Converter (for emojianimated)
// ═══════════════════════════════════════════════════════════
async function gifToSpritesheet(file, fpsOverride) {
  // Parse GIF using gifuct-js
  const buf = await file.arrayBuffer();
  let frames;
  try {
    const gif = window.parseGIF(buf);
    frames = window.decompressFrames(gif, true);
  } catch(e) {
    throw new Error(t('media.gifParseError', {msg: e.message}));
  }
  if (!frames || frames.length < 2) throw new Error(t('media.gifNeed2Frames'));

  // Auto-detect FPS from GIF frame delays (delay is in centiseconds)
  // gifuct-js exposes frame.delay in centiseconds (1/100 s)
  const avgDelayCentisec = frames.reduce((s, f) => s + (f.delay || 10), 0) / frames.length;
  const detectedFps = Math.round(100 / avgDelayCentisec);  // centisec → fps
  const fps = fpsOverride !== undefined ? Math.min(Math.max(fpsOverride, 1), 64) : Math.min(Math.max(detectedFps, 1), 64);

  // Clamp frames to VRChat limit (max 64)
  const SHEET_SIZE = 1024;
  const totalFrames = Math.min(frames.length, 64);
  // Pick best grid: 2x2 (4), 4x4 (16), 8x8 (64)
  let cols;
  if (totalFrames <= 4)  { cols = 2; }
  else if (totalFrames <= 16) { cols = 4; }
  else { cols = 8; }
  const rows = cols;
  const frameSize = SHEET_SIZE / cols;  // 512, 256, or 128

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SHEET_SIZE;
  const ctx = canvas.getContext('2d');

  // Patch all frames onto the canvas grid
  for (let i = 0; i < cols * rows && i < totalFrames; i++) {
    const f = frames[i];
    // Draw gifuct frame to a temp canvas
    const tmp = document.createElement('canvas');
    tmp.width = f.dims.width; tmp.height = f.dims.height;
    const tmpCtx = tmp.getContext('2d');
    const id = tmpCtx.createImageData(f.dims.width, f.dims.height);
    id.data.set(f.patch);
    tmpCtx.putImageData(id, 0, 0);
    const col = i % cols;
    const row = Math.floor(i / cols);
    ctx.drawImage(tmp, col * frameSize, row * frameSize, frameSize, frameSize);
  }

  // Export as PNG Blob
  const pngBlob = await new Promise(res => canvas.toBlob(res, 'image/png'));
  return { blob: pngBlob, frames: totalFrames, framesOverTime: fps, detectedFps };
}

function makeUploadCard(opts) {
  // opts: { id, title, hint, tag, accept, refreshPage, showFps }
  const uniqueId = 'upl_' + opts.tag + '_' + Date.now();
  const isAnimated = opts.tag === 'emojianimated';
  return `<div class="vrc-upload-card">
    <h4>${opts.title}</h4>
    <div class="vrc-upload-zone" id="zone_${uniqueId}"
      ondragover="event.preventDefault();this.classList.add('dragover')"
      ondragleave="this.classList.remove('dragover')"
      ondrop="event.preventDefault();this.classList.remove('dragover');document.getElementById('${uniqueId}').files=event.dataTransfer.files;onUploadFileSelected('${uniqueId}','${opts.tag}')">
      <span class="upload-icon">${isAnimated ? '🎞️' : '<i class="fa-solid fa-cloud-arrow-up"></i> '}</span>
      <span class="upload-label">${escHtml(t('media.clickOrDragFile'))}</span>
      <span class="upload-hint">${opts.hint}</span>
      <span class="upload-selected" id="sel_${uniqueId}">${escHtml(t('media.noFileSelected'))}</span>
      <span class="upload-dim" id="dim_${uniqueId}" style="font-size:0.72em;color:var(--text-muted);"></span>
      <input type="file" id="${uniqueId}" accept="${opts.accept}"
        onchange="onUploadFileSelected('${uniqueId}','${opts.tag}')">
    </div>
    ${isAnimated ? `<label style="font-size:0.78em;color:var(--text-muted);display:flex;align-items:center;gap:8px;margin-top:6px;">${escHtml(t('media.animFps'))}<input type="range" id="fps_${uniqueId}" min="1" max="64" value="12" style="flex:1;"><span id="fpsval_${uniqueId}">12</span></label>` : ''}
    <button class="vrc-upload-btn" id="btn_${uniqueId}" disabled
      onclick="uploadToVRCStyled('${escJsAttr(uniqueId)}','${escJsAttr(opts.tag)}','${escJsAttr(opts.refreshPage)}')">${escHtml(t('media.upload'))}</button>
    <div class="vrc-upload-status" id="status_${uniqueId}"></div>
  </div>`;
}

async function onUploadFileSelected(inputId, tag) {
  const input  = document.getElementById(inputId);
  const sel    = document.getElementById('sel_' + inputId);
  const dim    = document.getElementById('dim_' + inputId);
  const btn    = document.getElementById('btn_' + inputId);
  const fpsEl  = document.getElementById('fpsval_' + inputId);
  const fpsSl  = document.getElementById('fps_' + inputId);
  if (!input || !input.files || !input.files[0]) return;
  const f = input.files[0];
  const tooBig = f.size > 10 * 1024 * 1024;
  sel.textContent = f.name + ' (' + (f.size/1024/1024).toFixed(2) + ' MB)';
  sel.style.color = tooBig ? '#f87171' : 'var(--accent-light)';
  // Sync FPS slider label
  if (fpsEl && fpsSl) {
    fpsSl.oninput = () => fpsEl.textContent = fpsSl.value;
  }
  // For static emoji/sticker—show dimension warning if needed
  if (tag === 'emoji' || tag === 'sticker') {
    const img = new Image();
    const objUrl = URL.createObjectURL(f);
    img.onload = () => {
      URL.revokeObjectURL(objUrl);
      const ok = img.width <= 1024 && img.height <= 1024;
      if (dim) dim.textContent = img.width + '×' + img.height + (ok ? '' : t('media.exceeds1024'));
      if (dim) dim.style.color = ok ? 'var(--text-muted)' : '#f87171';
      btn.disabled = tooBig || !ok;
    };
    img.onerror = () => { URL.revokeObjectURL(objUrl); btn.disabled = tooBig; };
    img.src = objUrl;
  } else if (tag === 'emojianimated') {
    // For GIFs, auto-detect FPS from frame delays
    if (f.type === 'image/gif') {
      if (dim) { dim.innerHTML = t('media.readingGifFps'); dim.style.color = 'var(--text-muted)'; }
      const buf = await f.arrayBuffer();
      try {
        const gif = window.parseGIF(buf);
        const gifFrames = window.decompressFrames(gif, false);
        const avgDelay = gifFrames.reduce((s, fr) => s + (fr.delay || 10), 0) / gifFrames.length;
        const detectedFps = Math.min(Math.max(Math.round(100 / avgDelay), 1), 64);
        if (fpsSl) { fpsSl.value = detectedFps; }
        if (fpsEl) { fpsEl.textContent = detectedFps; }
        if (dim) {
          dim.innerHTML = t('media.gifDetectedFps', {frames: gifFrames.length, fps: detectedFps});
          dim.style.color = 'var(--accent-light)';
        }
      } catch(e) {
        if (dim) { dim.textContent = t('media.gifParseFailManualFps'); dim.style.color = '#f87171'; }
      }
    } else {
      if (dim) dim.textContent = t('media.animEmojiNeedGif');
      if (dim) dim.style.color = '#f87171';
    }
    btn.disabled = tooBig;
  } else {
    btn.disabled = tooBig;
  }
}

async function uploadToVRCStyled(inputId, tag, refreshPage) {
  const input    = document.getElementById(inputId);
  const btn      = document.getElementById('btn_' + inputId);
  const statusEl = document.getElementById('status_' + inputId);
  const fpsSl    = document.getElementById('fps_' + inputId);
  if (!input || !input.files || !input.files[0]) { statusEl.textContent = t('media.selectFileFirst'); return; }
  let file = input.files[0];
  if (file.size > 10*1024*1024) { statusEl.innerHTML = t('media.fileOver10mb'); statusEl.style.color='#f87171'; return; }

  btn.disabled = true;
  statusEl.style.color = 'var(--text-muted)';

  const fd = new FormData();

  try {
    if (tag === 'emojianimated') {
      // GIF → Spritesheet conversion
      statusEl.innerHTML = t('media.convertingGif');
      if (file.type !== 'image/gif') throw new Error(t('media.animEmojiMustGif'));
      const fps = fpsSl ? parseInt(fpsSl.value) || 12 : 12;
      const { blob, frames, framesOverTime } = await gifToSpritesheet(file, fps);
      fd.append('filestring', blob, 'spritesheet.png');
      fd.append('tagstring', 'emojianimated');
      fd.append('frames', String(frames));
      fd.append('framesOverTime', String(framesOverTime));
      statusEl.innerHTML = t('media.uploadingSpritesheet', {frames: frames, fps: framesOverTime});
    } else if (tag === 'emoji' || tag === 'sticker') {
      // Static emoji/sticker — validate 1024×1024
      statusEl.innerHTML = t('media.checkingSize');
      await new Promise((res, rej) => {
        const img = new Image();
        const objUrl = URL.createObjectURL(file);
        img.onload = () => {
          URL.revokeObjectURL(objUrl);
          if (img.width > 1024 || img.height > 1024) rej(new Error(t('media.imgSizeExceeds', {w: img.width, h: img.height})));
          else res();
        };
        img.onerror = () => { URL.revokeObjectURL(objUrl); res(); }; // if can't load dimensions, proceed anyway
        img.src = objUrl;
      });
      fd.append('filestring', file, file.name);
      fd.append('tagstring', tag);
      statusEl.innerHTML = t('media.uploading');
    } else {
      // gallery, icon, prints preview
      fd.append('filestring', file, file.name);
      fd.append('tagstring', tag);
      statusEl.innerHTML = t('media.uploading');
    }

    // Route through apiCall (fresh in-memory vrcAuth + multipart boundary auto-set).
    const r = await apiCall('/api/vrc/file/image', {
      method: 'POST',
      body: fd
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error('HTTP ' + r.status + ': ' + txt.substring(0, 200));
    }
    statusEl.innerHTML = t('media.uploadSuccess');
    statusEl.style.color = '#86efac';
    input.value = '';
    const selEl = document.getElementById('sel_' + inputId);
    if (selEl) selEl.textContent = t('media.noFileSelected');
    const dimEl = document.getElementById('dim_' + inputId);
    if (dimEl) dimEl.textContent = '';
    // Drop the cached payload for this sub-page so the reload actually
    // re-fetches (otherwise the 2-min TTL would serve stale data right
    // after an upload).
    if (refreshPage && typeof invalidateAssetsCache === 'function') invalidateAssetsCache();
    setTimeout(() => { if (refreshPage) switchAssetsPage(refreshPage); }, 1800);
  } catch(e) {
    statusEl.innerHTML = '<i class="fa-solid fa-xmark"></i> ' + escHtml(e.message);
    statusEl.style.color = '#f87171';
    btn.disabled = false;
  }
}

async function fetchGalleryOnly(container, gen) {
  try {
    const { data: cached, fresh } = await readAssetsCache('gallery', ASSETS_CACHE_TTL_MS);
    let files;
    if (fresh && Array.isArray(cached)) {
      files = cached;
    } else {
      container.innerHTML = '<div style="color:var(--text-muted);margin:20px;">' + escHtml(t('loading')) + '</div>';
      const r = await apiCall('/api/vrc/files?tag=gallery&n=60');
      if (gen != null && _assetsGen !== gen) return;
      files = r.ok ? await r.json() : [];
      await writeAssetsCache('gallery', files);
    }
    container.innerHTML = '<h2 style="margin-bottom:16px;">' + escHtml(t('media.vrcGallery')) + '</h2>';
    container.innerHTML += '<div class="vrc-upload-row">' + makeUploadCard({
      title: t('media.uploadToGallery'), hint: t('media.galleryHint'),
      tag:'gallery', accept:'image/*', refreshPage:'gallery', id:'gallery'
    }) + '</div>';
    container.innerHTML += '<h3 style="font-size:0.92rem;margin-bottom:12px;">' + t('media.myGallery', {count: files.length}) + '</h3>';
    if (files.length) {
      container.innerHTML += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px;">' +
        files.map(f => {
          const imgUrl = proxyImg(extractFileVersionUrl(f));
          return '<div style="border-radius:8px;overflow:hidden;background:var(--bg-glass);border:1px solid var(--border);cursor:pointer;" onclick="if(this.querySelector(\'img\').src)window.open(this.querySelector(\'img\').src,\'_blank\')">' +
            '<img src="' + escHtml(imgUrl) + '" style="width:100%;aspect-ratio:1/1;object-fit:cover;display:block;" loading="lazy" onerror="this.style.display=\'none\'">' +
            '<div style="padding:4px 6px;font-size:0.68em;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escHtml(f.name||'') + '</div>' +
          '</div>';
        }).join('') + '</div>';
    } else {
      container.innerHTML += '<div style="color:var(--text-muted);font-size:0.85em;">' + escHtml(t('media.noGalleryImages')) + '</div>';
    }
  } catch(e) {
    if (isAbortError(e)) return;
    container.innerHTML = '<div style="color:var(--error);">' + escHtml(t('toast.loadFailMsg', {msg: e.message})) + '</div>';
  }
}

// ═══════════════════════════════════════════════════════════
// PRINTS (拍立得照片) - separate page
// ═══════════════════════════════════════════════════════════
async function fetchPrints(container, gen) {
  try {
    const { data: cached, fresh } = await readAssetsCache('prints', ASSETS_CACHE_TTL_MS);
    let prints;
    if (fresh && Array.isArray(cached)) {
      prints = cached;
    } else {
      container.innerHTML = '<div style="color:var(--text-muted);margin:20px;">' + escHtml(t('loading')) + '</div>';
      const myId = await getMyId();
      if (gen != null && _assetsGen !== gen) return;
      const r = await apiCall('/api/vrc/prints/user/' + myId + '?n=100&offset=0');
      if (gen != null && _assetsGen !== gen) return;
      prints = r.ok ? await r.json() : [];
      await writeAssetsCache('prints', prints);
    }
    const printUploadId = 'printUpl_' + Date.now();
    container.innerHTML = '<h2 style="margin-bottom:12px;">' + escHtml(t('media.prints')) + '</h2>' +
      '<div class="vrc-upload-card" style="max-width:420px;margin-bottom:20px;">' +
        '<h4>' + t('media.uploadPrint') + '</h4>' +
        '<div class="vrc-upload-zone" id="zone_' + printUploadId + '"' +
          ' ondragover="event.preventDefault();this.classList.add(\'dragover\')"' +
          ' ondragleave="this.classList.remove(\'dragover\')"' +
          ' ondrop="event.preventDefault();this.classList.remove(\'dragover\');document.getElementById(\'' + printUploadId + '\').files=event.dataTransfer.files;onPrintFileSelected(\'' + printUploadId + '\')">' +
          '<span class="upload-icon"><i class="fa-solid fa-camera"></i> </span>' +
          '<span class="upload-label">' + escHtml(t('media.clickOrDragPhoto')) + '</span>' +
          '<span class="upload-hint">' + escHtml(t('media.printHint')) + '</span>' +
          '<span class="upload-selected" id="sel_' + printUploadId + '">' + escHtml(t('media.noFileSelected')) + '</span>' +
          '<input type="file" id="' + printUploadId + '" accept="image/*" onchange="onPrintFileSelected(\'' + printUploadId + '\')">' +
        '</div>' +
        '<input type="text" id="note_' + printUploadId + '" class="input-field" placeholder="' + t('media.printNotePlaceholder') + '" style="font-size:0.8em;padding:6px 10px;margin-top:4px;">' +
        '<button class="vrc-upload-btn" id="btn_' + printUploadId + '" disabled onclick="uploadPrint(\'' + printUploadId + '\')">' + escHtml(t('media.upload')) + '</button>' +
        '<div class="vrc-upload-status" id="status_' + printUploadId + '"></div>' +
      '</div>';
    if (!prints.length) {
      container.innerHTML += '<div style="color:var(--text-muted);font-size:0.85em;padding:40px;text-align:center;">' + escHtml(t('media.noPrints')) + '</div>';
      return;
    }
    container.innerHTML += '<div style="font-size:0.78em;color:var(--text-muted);margin-bottom:16px;">' + escHtml(t('media.printsCount', {count: prints.length})) + '</div>';
    container.innerHTML += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:18px;">' +
      prints.map(p => {
        const rawUrl = (p.files && p.files.image) ? p.files.image : (p.imageUrl || p.thumbnailImageUrl || '');
        const imgUrl = proxyImg(rawUrl);
        const world = p.worldName || p.worldId || '';
        const author = p.ownerDisplayName || '';
        const date = p.createdAt ? new Date(p.createdAt).toLocaleDateString(getLocale()) : '';
        return '<div class="print-card" style="position:relative;cursor:pointer;background:#fff;border-radius:4px;padding:10px 10px 20px;box-shadow:0 4px 18px rgba(0,0,0,0.45);transition:transform 0.15s;" onmouseover="this.style.transform=\'scale(1.03)\'" onmouseout="this.style.transform=\'\'">' +
          '<button title="' + t('media.delete') + '" onclick="event.stopPropagation(); deletePrint(\'' + escJsAttr(p.id) + '\', this)" style="position:absolute;top:6px;right:6px;z-index:3;background:rgba(0,0,0,0.55);color:#fff;border:none;border-radius:50%;width:24px;height:24px;cursor:pointer;font-size:0.8em;line-height:1;">×</button>' +
          '<img onclick="window.open(\'' + escJsAttr(imgUrl) + '\',\'_blank\')" src="' + escHtml(imgUrl) + '" style="width:100%;aspect-ratio:4/3;object-fit:cover;display:block;border-radius:2px;" loading="lazy" onerror="this.style.display=\'none\'">' +
          '<div style="margin-top:8px;">' +
            '<div style="font-size:0.7em;color:#555;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:sans-serif;">' + escHtml(world) + '</div>' +
            '<div style="font-size:0.65em;color:#888;font-family:sans-serif;display:flex;justify-content:space-between;">' +
              '<span>' + escHtml(author) + '</span><span>' + date + '</span>' +
            '</div>' +
          '</div>' +
        '</div>';
      }).join('') + '</div>';
  } catch(e) {
    if (isAbortError(e)) return;
    container.innerHTML = '<div style="color:var(--error);">' + escHtml(t('toast.loadFailMsg', {msg: e.message})) + '</div>';
  }
}

// Delete a polaroid print (DELETE /prints/{printId})
async function deletePrint(printId, btn) {
  if (!confirm(t('confirm.deletePrint'))) return;
  if (btn) btn.disabled = true;
  try {
    const r = await apiCall(`/api/vrc/prints/${printId}`, { method: 'DELETE' });
    if (r.ok) {
      // Use the explicit `.print-card` selector — `btn.closest('div')` was
      // grabbing the inner caption row (a descendant <div>) and yanking it,
      // leaving an empty white card visible until the next refresh.
      const card = btn && (btn.closest('.print-card') || btn.closest('div'));
      if (card && card.parentElement) card.remove();
      showToast(t('toast.printDeleted'), 'success');
      logMsg(t('log.printDeleted'), 'info');
    } else {
      if (btn) btn.disabled = false;
      showToast(t('toast.deleteFailHttp', {status: r.status}), 'error');
    }
  } catch(e) {
    if (btn) btn.disabled = false;
    showToast(t('toast.deleteFail', {msg: e.message}), 'error');
  }
}
function onPrintFileSelected(inputId) {
  const input = document.getElementById(inputId);
  const sel   = document.getElementById('sel_' + inputId);
  const btn   = document.getElementById('btn_' + inputId);
  if (!input || !input.files || !input.files[0]) return;
  const f = input.files[0];
  sel.textContent = f.name + ' (' + (f.size/1024/1024).toFixed(2) + ' MB)';
  sel.style.color  = f.size > 10*1024*1024 ? '#f87171' : 'var(--accent-light)';
  btn.disabled = f.size > 10*1024*1024;
}

async function uploadPrint(inputId) {
  const input    = document.getElementById(inputId);
  const btn      = document.getElementById('btn_' + inputId);
  const statusEl = document.getElementById('status_' + inputId);
  const noteEl   = document.getElementById('note_' + inputId);
  if (!input || !input.files || !input.files[0]) { statusEl.textContent = t('media.selectFileFirst'); return; }
  const file = input.files[0];
  if (file.size > 10*1024*1024) { statusEl.innerHTML = t('media.fileOver10mb'); statusEl.style.color='#f87171'; return; }
  btn.disabled = true;
  statusEl.innerHTML = t('media.uploadingProcessing');
  statusEl.style.color = 'var(--text-muted)';
  try {
    // VRCX ALWAYS converts prints to PNG before uploading.
    // The VRChat POST /prints API strictly expects a PNG blob.
    const imgUrl = URL.createObjectURL(file);
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error(t('media.imgParseError')));
      img.src = imgUrl;
    });
    
    // Draw to canvas and convert to PNG blob
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const pngBlob = await new Promise(res => canvas.toBlob(res, 'image/png'));
    URL.revokeObjectURL(imgUrl);

    statusEl.innerHTML = t('media.uploadingSending');
    const fd = new FormData();
    fd.append('image', pngBlob, 'image.png');
    fd.append('timestamp', new Date().toISOString());
    if (noteEl && noteEl.value.trim()) fd.append('note', noteEl.value.trim());

    // Route through apiCall so X-VRC-Auth is attached (raw fetch would strip it
    // and VRChat returns 401 → silent print upload failure). Same trap as the
    // groups-instance.js vrcGroupAction fix.
    const r = await apiCall('/api/vrc/prints', { method: 'POST', body: fd });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error('HTTP ' + r.status + ': ' + txt);
    }
    statusEl.innerHTML = t('media.uploadSuccess');
    statusEl.style.color = '#86efac';
    if (input) input.value = '';
    const sel = document.getElementById('sel_' + inputId);
    if (sel) sel.textContent = t('media.noFileSelected');
    if (typeof invalidateAssetsCache === 'function') invalidateAssetsCache();
    setTimeout(() => switchAssetsPage('prints'), 2000);
  } catch(e) {
    statusEl.innerHTML = '<i class="fa-solid fa-xmark"></i> ' + escHtml(e.message);
    statusEl.style.color = '#f87171';
    btn.disabled = false;
  }
}

// ═══════════════════════════════════════════════════════════════
// Friend Log & Change Detection Logic
// ═══════════════════════════════════════════════════════════════


VRCW.registerModule('mediaAssets', {
  gifToSpritesheet,
  makeUploadCard,
  onUploadFileSelected,
  uploadToVRCStyled,
  fetchGalleryOnly,
  fetchPrints,
  deletePrint,
  onPrintFileSelected,
  uploadPrint,
});
renderAppVersionInfo();
