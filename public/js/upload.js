/*
 * VRCW — upload.js
 * 上传(MD5/BLAKE2/gzip/缩略图/蓝图补丁/startUpload)/玻璃下拉
 *
 * 注意：本项目为「经典脚本」(非 ES module)，全部按顺序加载、共享全局作用域。
 * 函数声明会提升为全局，跨文件调用没问题；请勿改为 type="module"。
 */
document.querySelectorAll('input[name="uploadMode"]').forEach((r) => {
  r.addEventListener("change", function () {
    document
      .getElementById("newFields")
      .classList.toggle("hidden", this.value !== "new");
    document
      .getElementById("updateFields")
      .classList.toggle("hidden", this.value !== "update");
  });
});

// ── File Selection / Drag ──
const dropZone = document.getElementById("dropZone");
const fileInput = document.getElementById("fileInput");

if (dropZone) {
  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
  });
  dropZone.addEventListener("dragleave", () =>
    dropZone.classList.remove("dragover"),
  );
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    addFiles(
      Array.from(e.dataTransfer.files).filter((f) => f.name.endsWith(".vrca")),
    );
  });
}
if (fileInput) {
  fileInput.addEventListener("change", () => {
    addFiles(Array.from(fileInput.files));
    fileInput.value = "";
  });
}

function addFiles(files) {
  files.forEach((f) => {
    if (!uploadFiles.some((u) => u.name === f.name)) uploadFiles.push(f);
  });
  renderFileList();
  document.getElementById("btnUpload").disabled = uploadFiles.length === 0;
}

function renderFileList() {
  const container = document.getElementById("file-list-container");
  const list = document.getElementById("file-list");
  if (uploadFiles.length === 0) {
    container.classList.add("hidden");
    return;
  }
  container.classList.remove("hidden");
  list.innerHTML = uploadFiles
    .map(
      (f, i) => `
        <div class="file-list-item" id="upload-item-${i}">
            <span class="file-name">${escHtml(f.name)}</span>
            <span class="file-size">${(f.size / 1048576).toFixed(1)} MB</span>
            <span class="file-status" id="upload-status-${i}"></span>
            <button class="file-remove" onclick="removeFile(${i})">×</button>
        </div>
    `,
    )
    .join("");
}

function removeFile(i) {
  uploadFiles.splice(i, 1);
  renderFileList();
  document.getElementById("btnUpload").disabled = uploadFiles.length === 0;
}

// (proxy input removed — CF Workers version uploads via /api/s3proxy)

// ── MD5 (using SubtleCrypto isn't available for MD5, use simple implementation) ──
function md5(buffer) {
  // Simple MD5 implementation for ArrayBuffer → base64
  const bytes = new Uint8Array(buffer);
  // Using SparkMD5-like approach inline
  return sparkMD5ArrayBuffer(bytes);
}

// Minimal MD5 for ArrayBuffer (adapted from SparkMD5)
function sparkMD5ArrayBuffer(uint8) {
  function md5cycle(x, k) {
    let a = x[0],
      b = x[1],
      c = x[2],
      d = x[3];
    a = ff(a, b, c, d, k[0], 7, -680876936);
    d = ff(d, a, b, c, k[1], 12, -389564586);
    c = ff(c, d, a, b, k[2], 17, 606105819);
    b = ff(b, c, d, a, k[3], 22, -1044525330);
    a = ff(a, b, c, d, k[4], 7, -176418897);
    d = ff(d, a, b, c, k[5], 12, 1200080426);
    c = ff(c, d, a, b, k[6], 17, -1473231341);
    b = ff(b, c, d, a, k[7], 22, -45705983);
    a = ff(a, b, c, d, k[8], 7, 1770035416);
    d = ff(d, a, b, c, k[9], 12, -1958414417);
    c = ff(c, d, a, b, k[10], 17, -42063);
    b = ff(b, c, d, a, k[11], 22, -1990404162);
    a = ff(a, b, c, d, k[12], 7, 1804603682);
    d = ff(d, a, b, c, k[13], 12, -40341101);
    c = ff(c, d, a, b, k[14], 17, -1502002290);
    b = ff(b, c, d, a, k[15], 22, 1236535329);
    a = gg(a, b, c, d, k[1], 5, -165796510);
    d = gg(d, a, b, c, k[6], 9, -1069501632);
    c = gg(c, d, a, b, k[11], 14, 643717713);
    b = gg(b, c, d, a, k[0], 20, -373897302);
    a = gg(a, b, c, d, k[5], 5, -701558691);
    d = gg(d, a, b, c, k[10], 9, 38016083);
    c = gg(c, d, a, b, k[15], 14, -660478335);
    b = gg(b, c, d, a, k[4], 20, -405537848);
    a = gg(a, b, c, d, k[9], 5, 568446438);
    d = gg(d, a, b, c, k[14], 9, -1019803690);
    c = gg(c, d, a, b, k[3], 14, -187363961);
    b = gg(b, c, d, a, k[8], 20, 1163531501);
    a = gg(a, b, c, d, k[13], 5, -1444681467);
    d = gg(d, a, b, c, k[2], 9, -51403784);
    c = gg(c, d, a, b, k[7], 14, 1735328473);
    b = gg(b, c, d, a, k[12], 20, -1926607734);
    a = hh(a, b, c, d, k[5], 4, -378558);
    d = hh(d, a, b, c, k[8], 11, -2022574463);
    c = hh(c, d, a, b, k[11], 16, 1839030562);
    b = hh(b, c, d, a, k[14], 23, -35309556);
    a = hh(a, b, c, d, k[1], 4, -1530992060);
    d = hh(d, a, b, c, k[4], 11, 1272893353);
    c = hh(c, d, a, b, k[7], 16, -155497632);
    b = hh(b, c, d, a, k[10], 23, -1094730640);
    a = hh(a, b, c, d, k[13], 4, 681279174);
    d = hh(d, a, b, c, k[0], 11, -358537222);
    c = hh(c, d, a, b, k[3], 16, -722521979);
    b = hh(b, c, d, a, k[6], 23, 76029189);
    a = hh(a, b, c, d, k[9], 4, -640364487);
    d = hh(d, a, b, c, k[12], 11, -421815835);
    c = hh(c, d, a, b, k[15], 16, 530742520);
    b = hh(b, c, d, a, k[2], 23, -995338651);
    a = ii(a, b, c, d, k[0], 6, -198630844);
    d = ii(d, a, b, c, k[7], 10, 1126891415);
    c = ii(c, d, a, b, k[14], 15, -1416354905);
    b = ii(b, c, d, a, k[5], 21, -57434055);
    a = ii(a, b, c, d, k[12], 6, 1700485571);
    d = ii(d, a, b, c, k[3], 10, -1894986606);
    c = ii(c, d, a, b, k[10], 15, -1051523);
    b = ii(b, c, d, a, k[1], 21, -2054922799);
    a = ii(a, b, c, d, k[8], 6, 1873313359);
    d = ii(d, a, b, c, k[15], 10, -30611744);
    c = ii(c, d, a, b, k[6], 15, -1560198380);
    b = ii(b, c, d, a, k[13], 21, 1309151649);
    a = ii(a, b, c, d, k[4], 6, -145523070);
    d = ii(d, a, b, c, k[11], 10, -1120210379);
    c = ii(c, d, a, b, k[2], 15, 718787259);
    b = ii(b, c, d, a, k[9], 21, -343485551);
    x[0] = add32(a, x[0]);
    x[1] = add32(b, x[1]);
    x[2] = add32(c, x[2]);
    x[3] = add32(d, x[3]);
  }
  function cmn(q, a, b, x, s, t) {
    a = add32(add32(a, q), add32(x, t));
    return add32((a << s) | (a >>> (32 - s)), b);
  }
  function ff(a, b, c, d, x, s, t) {
    return cmn((b & c) | (~b & d), a, b, x, s, t);
  }
  function gg(a, b, c, d, x, s, t) {
    return cmn((b & d) | (c & ~d), a, b, x, s, t);
  }
  function hh(a, b, c, d, x, s, t) {
    return cmn(b ^ c ^ d, a, b, x, s, t);
  }
  function ii(a, b, c, d, x, s, t) {
    return cmn(c ^ (b | ~d), a, b, x, s, t);
  }
  function add32(a, b) {
    return (a + b) & 0xffffffff;
  }

  const n = uint8.length;
  let state = [1732584193, -271733879, -1732584194, 271733878];
  let i;
  for (i = 64; i <= n; i += 64) {
    const words = new Int32Array(uint8.buffer, uint8.byteOffset + i - 64, 16);
    md5cycle(state, words);
  }
  const tail = new Uint8Array(64);
  const remaining = n - (i - 64);
  for (let j = 0; j < remaining; j++) tail[j] = uint8[i - 64 + j];
  tail[remaining] = 0x80;
  if (remaining > 55) {
    md5cycle(state, new Int32Array(tail.buffer, 0, 16));
    tail.fill(0);
  }
  const bits = new DataView(tail.buffer);
  bits.setUint32(56, (n * 8) >>> 0, true);
  bits.setUint32(60, Math.floor(n / 0x20000000) & 0xffffffff, true);
  md5cycle(state, new Int32Array(tail.buffer, 0, 16));

  const result = new Uint8Array(16);
  for (let j = 0; j < 4; j++) {
    result[j * 4] = state[j] & 0xff;
    result[j * 4 + 1] = (state[j] >> 8) & 0xff;
    result[j * 4 + 2] = (state[j] >> 16) & 0xff;
    result[j * 4 + 3] = (state[j] >> 24) & 0xff;
  }
  return btoa(String.fromCharCode(...result));
}

// ── Rsync Signature (BLAKE2 format) ──
async function computeRsyncSignature(fileData) {
  const blockSize = 2048;
  const strongSumLen = 32;
  const headerSize = 12;
  const numBlocks = Math.ceil(fileData.length / blockSize);
  const sigSize = headerSize + numBlocks * (4 + strongSumLen);
  const sig = new Uint8Array(sigSize);
  const view = new DataView(sig.buffer);

  // Header: magic(BLAKE2), block_size, strong_sum_len
  view.setUint32(0, 0x72730137);
  view.setUint32(4, blockSize);
  view.setUint32(8, strongSumLen);

  let offset = headerSize;
  for (let i = 0; i < fileData.length; i += blockSize) {
    const block = fileData.subarray(
      i,
      Math.min(i + blockSize, fileData.length),
    );

    // Weak checksum (adler32-like, matching Python implementation)
    let s1 = 0,
      s2 = 0;
    for (let j = 0; j < block.length; j++) {
      s1 = (s1 + block[j] + 31) % 65536;
      s2 = (s2 + s1) % 65536;
    }
    const weak = ((s2 & 0xffff) << 16) | (s1 & 0xffff);
    view.setUint32(offset, weak);
    offset += 4;

    // Strong checksum (BLAKE2b-256) — use SubtleCrypto SHA-256 as fallback
    // Note: SubtleCrypto doesn't have BLAKE2, so we match the Python BLAKE2 output
    // For VRChat compatibility, we need actual BLAKE2b
    const hash = await blake2b256(block);
    sig.set(hash, offset);
    offset += strongSumLen;
  }
  return sig.subarray(0, offset);
}

// Minimal BLAKE2b-256 implementation
async function blake2b256(data) {
  // BLAKE2b constants
  const IV = new BigUint64Array([
    0x6a09e667f3bcc908n,
    0xbb67ae8584caa73bn,
    0x3c6ef372fe94f82bn,
    0xa54ff53a5f1d36f1n,
    0x510e527fade682d1n,
    0x9b05688c2b3e6c1fn,
    0x1f83d9abfb41bd6bn,
    0x5be0cd19137e2179n,
  ]);
  const SIGMA = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
    [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
    [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
    [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
    [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
    [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
    [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
    [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
    [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
  ];

  const outLen = 32;
  let h = new BigUint64Array(IV);
  h[0] ^= BigInt(0x01010000 ^ outLen);

  const blockSize = 128;
  let t = 0n;
  const pad = new Uint8Array(blockSize);

  function G(v, a, b, c, d, x, y) {
    v[a] = v[a] + v[b] + x;
    v[d] = rotr64(v[d] ^ v[a], 32n);
    v[c] = v[c] + v[d];
    v[b] = rotr64(v[b] ^ v[c], 24n);
    v[a] = v[a] + v[b] + y;
    v[d] = rotr64(v[d] ^ v[a], 16n);
    v[c] = v[c] + v[d];
    v[b] = rotr64(v[b] ^ v[c], 63n);
  }
  function rotr64(x, n) {
    return ((x >> n) | (x << (64n - n))) & 0xffffffffffffffffn;
  }

  function compress(block, t, last) {
    const m = new BigUint64Array(16);
    const dv = new DataView(block.buffer, block.byteOffset, blockSize);
    for (let i = 0; i < 16; i++) m[i] = dv.getBigUint64(i * 8, true);

    const v = new BigUint64Array(16);
    for (let i = 0; i < 8; i++) {
      v[i] = h[i];
      v[i + 8] = IV[i];
    }
    v[12] ^= t & 0xffffffffffffffffn;
    v[13] ^= (t >> 64n) & 0xffffffffffffffffn;
    if (last) v[14] ^= 0xffffffffffffffffn;

    for (let round = 0; round < 12; round++) {
      const s = SIGMA[round % 10];
      G(v, 0, 4, 8, 12, m[s[0]], m[s[1]]);
      G(v, 1, 5, 9, 13, m[s[2]], m[s[3]]);
      G(v, 2, 6, 10, 14, m[s[4]], m[s[5]]);
      G(v, 3, 7, 11, 15, m[s[6]], m[s[7]]);
      G(v, 0, 5, 10, 15, m[s[8]], m[s[9]]);
      G(v, 1, 6, 11, 12, m[s[10]], m[s[11]]);
      G(v, 2, 7, 8, 13, m[s[12]], m[s[13]]);
      G(v, 3, 4, 9, 14, m[s[14]], m[s[15]]);
    }
    for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
  }

  let pos = 0;
  while (pos + blockSize <= data.length) {
    if (pos + blockSize < data.length) {
      t += BigInt(blockSize);
      compress(data.subarray(pos, pos + blockSize), t, false);
      pos += blockSize;
    } else {
      // Exact multiple: this is the final full block
      t += BigInt(blockSize);
      compress(data.subarray(pos, pos + blockSize), t, true);
      pos += blockSize;
      // Return early — no partial block needed
      const out = new Uint8Array(outLen);
      const outView = new DataView(out.buffer);
      for (let i = 0; i < 4; i++) outView.setBigUint64(i * 8, h[i], true);
      return out;
    }
  }

  // Final block
  pad.fill(0);
  const remaining = data.length - pos;
  for (let i = 0; i < remaining; i++) pad[i] = data[pos + i];
  t += BigInt(remaining);
  compress(pad, t, true);

  const out = new Uint8Array(outLen);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) outView.setBigUint64(i * 8, h[i], true);
  return out;
}

// ── Upload Logic ──
function setUploadStatus(msg, type = "") {
  const el = document.getElementById("upload-status");
  el.textContent = msg;
  el.className = "upload-status" + (type ? " " + type : "");
}

function setProgress(pct, text) {
  const container = document.getElementById("upload-progress");
  const fill = document.getElementById("upload-progress-fill");
  const txt = document.getElementById("upload-progress-text");
  container.classList.toggle("active", pct >= 0);
  fill.style.width = pct + "%";
  if (text) txt.textContent = text;
}

// ── Resize image to 1200x900 (4:3) using Canvas ──
async function resizeImageTo4x3(file) {
  const TARGET_W = 1200,
    TARGET_H = 900;
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objUrl);
      const canvas = document.createElement("canvas");
      canvas.width = TARGET_W;
      canvas.height = TARGET_H;
      const ctx = canvas.getContext("2d");

      // Fill black background, then draw image centered/cropped to 4:3
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, TARGET_W, TARGET_H);

      // Calculate crop: cover the 4:3 area
      const srcRatio = img.width / img.height;
      const dstRatio = TARGET_W / TARGET_H;
      let sx = 0,
        sy = 0,
        sw = img.width,
        sh = img.height;
      if (srcRatio > dstRatio) {
        // Source is wider — crop sides
        sw = img.height * dstRatio;
        sx = (img.width - sw) / 2;
      } else {
        // Source is taller — crop top/bottom
        sh = img.width / dstRatio;
        sy = (img.height - sh) / 2;
      }

      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, TARGET_W, TARGET_H);

      canvas.toBlob((blob) => {
        if (!blob) return reject(new Error("Canvas toBlob failed"));
        blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)));
      }, "image/png");
    };
    img.onerror = () => {
      URL.revokeObjectURL(objUrl);
      reject(new Error("Failed to load image"));
    };
    img.src = objUrl;
  });
}

// ── Upload Image to VRChat File API ──
// Resizes to 1200x900 (4:3), uploads via File API, returns VRChat file URL
async function uploadImageToVRChat(file, namePrefix) {
  logMsg("Resizing image to 1200x900 (4:3)...", "info");
  const fileData = await resizeImageTo4x3(file);
  logMsg(`Image resized: ${fileData.length} bytes`, "info");

  if (fileData.length > 10 * 1024 * 1024)
    throw new Error("Image too large after resize (max 10MB).");
  const fileMd5 = md5(fileData);

  // 1. Create file record
  const rFile = await apiCall("/api/vrc/file", {
    method: "POST",
    json: {
      name: namePrefix + " Image",
      mimeType: "image/png",
      extension: "png",
      tags: [],
    },
  });
  if (!rFile.ok)
    throw new Error("Failed to create image file: " + (await rFile.text()));
  const imgFileId = (await rFile.json()).id;

  // 2. Create version
  const rVer = await apiCall(`/api/vrc/file/${imgFileId}`, {
    method: "POST",
    json: {
      signatureMd5: "",
      signatureSizeInBytes: 0,
      fileMd5,
      fileSizeInBytes: fileData.length,
    },
  });
  if (!rVer.ok)
    throw new Error("Failed to create image version: " + (await rVer.text()));
  const imgVersionId = (await rVer.json()).versions?.slice(-1)[0]?.version ?? 1;

  // 3. Start file upload (Simple Mode)
  const rPartStart = await apiCall(
    `/api/vrc/file/${imgFileId}/${imgVersionId}/file/start?partNumber=1`,
    { method: "PUT" },
  );
  if (!rPartStart.ok)
    throw new Error("Image start failed: " + (await rPartStart.text()));
  const partUrl = (await rPartStart.json()).url;

  // 4. Upload to S3 via proxy
  const rPartPut = await fetch(`${API_BASE}/api/s3proxy`, {
    method: "PUT",
    body: fileData,
    headers: {
      "X-S3-Url": partUrl,
      "X-VRC-Auth": vrcAuth,
      "X-S3-content-md5": fileMd5,
    },
  });
  if (!rPartPut.ok)
    throw new Error("Image S3 upload failed: " + (await rPartPut.text()));

  // 5. Finish upload (Simple mode: no etags)
  const rFinish = await apiCall(
    `/api/vrc/file/${imgFileId}/${imgVersionId}/file/finish`,
    {
      method: "PUT",
      json: { nextPartNumber: "0", maxParts: "0" },
    },
  );
  if (!rFinish.ok)
    throw new Error("Image finalize failed: " + (await rFinish.text()));

  // 6. Poll for completion (images are usually fast)
  for (let attempt = 0; attempt < 15; attempt++) {
    await new Promise((r) => setTimeout(r, 2000));
    const rStatus = await apiCall(`/api/vrc/file/${imgFileId}`);
    if (rStatus.ok) {
      const ver = ((await rStatus.json()).versions || []).find(
        (v) => v.version === parseInt(imgVersionId),
      );
      if (ver && ver.status === "complete") {
        const url = `https://api.vrchat.cloud/api/1/file/${imgFileId}/${imgVersionId}/file`;
        logMsg(`Image uploaded: ${url}`, "success");
        return url;
      }
    }
  }
  throw new Error("Image processing timed out.");
}

// ── Patch Blueprint ID in .vrca AssetBundle ──
// VRChat embeds the avatar's Blueprint ID (avtr_xxx) inside the .vrca file via VRCPipelineManager.
// Security check fails if the embedded ID doesn't belong to the uploading user.
// This function finds and replaces all avtr_ UUIDs in the binary data.
function patchBlueprintId(vrcaBytes, newAvatarId) {
  // avtr_ + UUID = 41 bytes: "avtr_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  const AVTR_PREFIX = [0x61, 0x76, 0x74, 0x72, 0x5f]; // "avtr_"
  const AVTR_LEN = 41; // avtr_ (5) + UUID (36)
  const newIdBytes = new TextEncoder().encode(newAvatarId);
  if (newIdBytes.length !== AVTR_LEN) {
    logMsg(
      `Warning: new avatar ID length ${newIdBytes.length} != expected ${AVTR_LEN}`,
      "error",
    );
  }

  let patchCount = 0;
  const data = new Uint8Array(vrcaBytes); // work on a copy

  for (let i = 0; i < data.length - AVTR_LEN; i++) {
    // Check for "avtr_" prefix
    if (
      data[i] === 0x61 &&
      data[i + 1] === 0x76 &&
      data[i + 2] === 0x74 &&
      data[i + 3] === 0x72 &&
      data[i + 4] === 0x5f
    ) {
      // Verify this looks like a UUID: avtr_ + 8-4-4-4-12 hex pattern
      const candidate = new TextDecoder().decode(
        data.subarray(i, i + AVTR_LEN),
      );
      if (
        /^avtr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          candidate,
        )
      ) {
        const oldId = candidate;
        // Replace with new ID
        for (let j = 0; j < newIdBytes.length; j++) {
          data[i + j] = newIdBytes[j];
        }
        patchCount++;
        logMsg(`Patched BlueprintId: ${oldId} → ${newAvatarId}`, "info");
      }
    }
  }

  logMsg(
    `Patched ${patchCount} BlueprintId occurrence(s)`,
    patchCount > 0 ? "success" : "error",
  );
  return data;
}

async function startUpload() {
  if (uploadFiles.length === 0) return;
  const btn = document.getElementById("btnUpload");
  btn.disabled = true;
  const isNew = document.getElementById("modeNew").checked;

  setUploadStatus(t("uploading"));
  setProgress(0, "");

  for (let idx = 0; idx < uploadFiles.length; idx++) {
    const file = uploadFiles[idx];
    const itemEl = document.getElementById("upload-item-" + idx);
    const statusEl = document.getElementById("upload-status-" + idx);
    if (itemEl) itemEl.classList.add("uploading");
    if (statusEl) statusEl.innerHTML = '<i class="fa-solid fa-hourglass-half"></i> ';

    try {
      setUploadStatus(`Processing ${file.name}...`);
      let fileData = new Uint8Array(await file.arrayBuffer());

      // 1. Use raw file data directly (no gzip — VRChat security scanner needs raw AssetBundle)
      // NOTE: rawData and sigBytes/sigMd5 may be reassigned in update mode after patching
      let rawData = fileData;
      const fileMd5 = md5(rawData);
      logMsg(
        `File: ${rawData.length} bytes, MD5: ${fileMd5.substring(0, 16)}...`,
        "info",
      );

      // 2. Compute rsync signature (based on raw data)
      setProgress(10, "Computing signature...");
      let sigBytes = await computeRsyncSignature(rawData);
      let sigMd5 = md5(sigBytes);

      // 3. Create file & version via Worker proxy
      setProgress(15, "Creating file version...");
      let fileId, versionId;

      if (isNew) {
        let name =
          uploadFiles.length === 1
            ? document.getElementById("avatarName").value.trim()
            : "";
        if (!name) name = file.name.replace(/\.vrca$/i, "");

        // Create file record
        const rFile = await apiCall("/api/vrc/file", {
          method: "POST",
          json: {
            name,
            mimeType: "application/x-avatar",
            extension: "vrca",
            tags: [],
          },
        });
        if (!rFile.ok)
          throw new Error("Failed to create file: " + (await rFile.text()));
        const fileData2 = await rFile.json();
        fileId = fileData2.id;

        // Create version
        const rVer = await apiCall(`/api/vrc/file/${fileId}`, {
          method: "POST",
          json: {
            signatureMd5: sigMd5,
            signatureSizeInBytes: sigBytes.length,
            fileMd5: fileMd5,
            fileSizeInBytes: rawData.length,
          },
        });
        if (!rVer.ok)
          throw new Error("Failed to create version: " + (await rVer.text()));
        const verData = await rVer.json();
        versionId = verData.versions[verData.versions.length - 1].version;
      } else {
        const selAvatarId = document.getElementById("avatarSelect").value;
        if (!selAvatarId) throw new Error("No avatar selected");

        // Patch BlueprintId in .vrca to match the target avatar
        fileData = patchBlueprintId(fileData, selAvatarId);
        // Recalculate MD5 and signature after patching
        const patchedMd5 = md5(fileData);
        const patchedSig = await computeRsyncSignature(fileData);
        const patchedSigMd5 = md5(patchedSig);

        // Point rawData to the patched bytes so the upload loop sends patched data
        rawData = fileData;

        // Get avatar info to find file ID
        const rAv = await apiCall(`/api/vrc/avatars/${selAvatarId}`);
        if (!rAv.ok) throw new Error(`获取模型信息失败 (HTTP ${rAv.status})，可能无权修改此模型`);
        const avData = await rAv.json();
        if (!avData || !avData.unityPackages) throw new Error(`模型信息格式异常，无法读取 unityPackages`);
        for (const pkg of avData.unityPackages || []) {
          if (["standalonewindows", "pc"].includes(pkg.platform)) {
            const m = (pkg.assetUrl || "").match(/file\/(file_[a-f0-9-]+)\//);
            if (m) {
              fileId = m[1];
              break;
            }
          }
        }
        if (!fileId) throw new Error("Could not find file ID");

        const rVer = await apiCall(`/api/vrc/file/${fileId}`, {
          method: "POST",
          json: {
            signatureMd5: patchedSigMd5,
            signatureSizeInBytes: patchedSig.length,
            fileMd5: patchedMd5,
            fileSizeInBytes: fileData.length,
          },
        });
        if (!rVer.ok)
          throw new Error("Failed to create version: " + (await rVer.text()));
        const verData = await rVer.json();
        versionId = verData.versions[verData.versions.length - 1].version;

        // Store patched sig info so signature upload below uses correct values
        sigBytes = patchedSig;
        sigMd5 = patchedSigMd5;
      }

      // 4. Upload signature via Worker proxy (avoids S3 CORS)
      setProgress(20, "Uploading signature...");
      const rSigStart = await apiCall(
        `/api/vrc/file/${fileId}/${versionId}/signature/start`,
        { method: "PUT" },
      );
      if (!rSigStart.ok)
        throw new Error(
          "Failed to start sig upload: " + (await rSigStart.text()),
        );
      const sigUrl = (await rSigStart.json()).url;

      // Proxy S3 PUT through Worker to bypass CORS
      const rSigPut = await fetch(`${API_BASE}/api/s3proxy`, {
        method: "PUT",
        body: sigBytes,
        headers: {
          "X-S3-Url": sigUrl,
          "X-S3-content-md5": sigMd5,
          "X-S3-content-type": "application/x-rsync-signature",
          "X-VRC-Auth": vrcAuth,
        },
      });
      if (!rSigPut.ok) {
        const errText = await rSigPut.text();
        throw new Error(
          "Signature S3 upload failed: " + errText.substring(0, 200),
        );
      }

      // Finish signature
      const rSigFinish = await apiCall(
        `/api/vrc/file/${fileId}/${versionId}/signature/finish`,
        {
          method: "PUT",
          json: { nextPartNumber: "0", maxParts: "0" },
        },
      );
      if (!rSigFinish.ok) {
        // Retry with empty etags
        const retry = await apiCall(
          `/api/vrc/file/${fileId}/${versionId}/signature/finish`,
          {
            method: "PUT",
            json: { etags: [], nextPartNumber: "0", maxParts: "0" },
          },
        );
        if (!retry.ok)
          throw new Error(
            "Failed to finalize signature: " + (await retry.text()),
          );
      }

      // 5. Upload file (multipart, 10MB chunks) — DIRECT TO S3!
      setProgress(25, "Uploading file...");
      const CHUNK_SIZE = 10 * 1024 * 1024;
      const totalParts = Math.ceil(rawData.length / CHUNK_SIZE);
      const etags = [];

      for (let partNum = 1; partNum <= totalParts; partNum++) {
        const pOffset = (partNum - 1) * CHUNK_SIZE;
        const chunk = rawData.subarray(
          pOffset,
          Math.min(pOffset + CHUNK_SIZE, rawData.length),
        );

        const rPartStart = await apiCall(
          `/api/vrc/file/${fileId}/${versionId}/file/start?partNumber=${partNum}`,
          { method: "PUT" },
        );
        if (!rPartStart.ok)
          throw new Error(
            `Part ${partNum} start failed: ` + (await rPartStart.text()),
          );
        const partUrl = (await rPartStart.json()).url;

        // Proxy S3 PUT through Worker (no direct S3 CORS needed)
        const pctBefore = 25 + ((partNum - 1) / totalParts) * 70;
        const pctAfter = 25 + (partNum / totalParts) * 70;
        const uploadedBefore = pOffset / 1048576;
        const totalMB = rawData.length / 1048576;
        setProgress(
          pctBefore,
          `Part ${partNum}/${totalParts}: ${uploadedBefore.toFixed(1)}/${totalMB.toFixed(1)} MB`,
        );

        // Calculate Content-MD5 for this chunk (S3 requires it per X-Amz-SignedHeaders)
        const chunkMd5 = md5(chunk);

        const rPartPut = await fetch(`${API_BASE}/api/s3proxy`, {
          method: "PUT",
          body: chunk,
          headers: {
            "X-S3-Url": partUrl,
            "X-VRC-Auth": vrcAuth,
            "X-S3-content-md5": chunkMd5,
          },
        });
        if (!rPartPut.ok) {
          const errText = await rPartPut.text();
          throw new Error(
            `S3 part ${partNum} failed: ` + errText.substring(0, 200),
          );
        }
        const partJson = await rPartPut.json();
        if (partJson.etag) etags.push(partJson.etag);

        setProgress(
          pctAfter,
          `Part ${partNum}/${totalParts}: ${((pOffset + chunk.length) / 1048576).toFixed(1)}/${totalMB.toFixed(1)} MB`,
        );
      }

      // 6. Finish file upload
      // CRITICAL: Only include etags for multipart uploads (totalParts > 1).
      // For simple uploads (1 part), VRChat uses S3 PutObject (not multipart).
      // Sending etags triggers CompleteMultipartUpload which fails with 500 since
      // there's no multipart session (uploadId is empty, category is "simple").
      setProgress(95, "Finalizing...");
      const finishBody = { nextPartNumber: "0", maxParts: "0" };
      if (totalParts > 1) finishBody.etags = etags;
      const rFileFinish = await apiCall(
        `/api/vrc/file/${fileId}/${versionId}/file/finish`,
        {
          method: "PUT",
          json: finishBody,
        },
      );
      if (!rFileFinish.ok)
        throw new Error(
          "Failed to finalize file: " + (await rFileFinish.text()),
        );

      // 7. Wait for file status to become 'complete' before creating avatar
      // NOTE: GET /file/{fileId}/{versionId} returns 302 redirect (download URL), NOT status!
      // Must use GET /file/{fileId} which returns all versions with their status.
      setProgress(97, "Waiting for file to be processed...");
      let fileReady = false;
      const maxAttempts = 60; // 60 × 5s = 5 minutes max
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise((r) => setTimeout(r, 5000));
        const rStatus = await apiCall(`/api/vrc/file/${fileId}`);
        if (rStatus.ok) {
          const fileObj = await rStatus.json();
          // Find our version in the versions array
          const ver = (fileObj.versions || []).find(
            (v) => v.version === parseInt(versionId),
          );
          const status = ver ? ver.status : "unknown";
          const elapsed = (attempt + 1) * 5;
          logMsg(
            `Attempt ${attempt + 1}/${maxAttempts} (${elapsed}s) — status: ${status}`,
            "info",
          );
          if (status === "complete") {
            fileReady = true;
            break;
          }
          if (status === "error") {
            throw new Error(`File processing failed with status: error`);
          }
        } else {
          logMsg(
            `Attempt ${attempt + 1}/${maxAttempts} — poll failed (${rStatus.status})`,
            "info",
          );
        }
      }
      if (!fileReady)
        throw new Error(
          "File not ready after 5 minutes. It may still be processing — wait and try Update mode.",
        );

      // 7b. Update mode: explicitly point the avatar at the new file version.
      // VRChat *usually* auto-promotes the latest version, but some edge cases
      // leave the avatar on the old version — this PUT guarantees the new
      // version is live. Harmless if VRChat already promoted it. (F11)
      if (!isNew && selAvatarId && fileId && versionId) {
        setProgress(97, "Updating avatar to new version...");
        const rUpd = await apiCall(`/api/vrc/avatars/${selAvatarId}`, {
          method: "PUT",
          json: {
            assetUrl: `https://api.vrchat.cloud/api/1/file/${fileId}/${versionId}/file`,
          },
        });
        if (!rUpd.ok) {
          logMsg(`Warning: avatar record update returned HTTP ${rUpd.status} — the new version uploaded but may need manual activation.`, "error");
        } else {
          logMsg("Avatar record updated to new version.", "success");
        }
      }

      // 8. Create avatar
      if (isNew && fileId) {
        setProgress(98, "Creating avatar record...");
        let name =
          uploadFiles.length === 1
            ? document.getElementById("avatarName").value.trim()
            : "";
        if (!name) name = file.name.replace(/\.vrca$/i, "");

        // Upload thumbnail image if selected
        let finalImageUrl = "";
        const imgInput = document.getElementById("avatarImage");
        if (imgInput && imgInput.files.length > 0) {
          try {
            finalImageUrl = await uploadImageToVRChat(
              imgInput.files[0],
              name || "Avatar",
            );
          } catch (err) {
            logMsg("Failed to upload thumbnail: " + err.message, "error");
          }
        }
        if (!finalImageUrl) {
          for (const av of avatars) {
            if (av.imageUrl) {
              finalImageUrl = av.imageUrl;
              break;
            }
            if (av.thumbnailImageUrl) {
              finalImageUrl = av.thumbnailImageUrl;
              break;
            }
          }
        }
        if (!finalImageUrl)
          finalImageUrl = `https://api.vrchat.cloud/api/1/file/${fileId}/${versionId}/file`;

        const rAvatar = await apiCall("/api/vrc/avatars", {
          method: "POST",
          json: {
            name,
            assetUrl: `https://api.vrchat.cloud/api/1/file/${fileId}/${versionId}/file`,
            imageUrl: finalImageUrl,
            releaseStatus: "private",
            unityPackageUrl: "",
            unityVersion: "2022.3.22f1",
            platform: "standalonewindows",
            description: "Uploaded via VRCW",
            tags: [],
          },
        });
        if (!rAvatar.ok)
          throw new Error("Failed to create avatar: " + (await rAvatar.text()));
        logMsg(`Avatar created: ${(await rAvatar.json()).id}`, "success");
      }

      setProgress(100, "Done!");
      if (statusEl) statusEl.textContent = "✓";
      if (itemEl) {
        itemEl.classList.remove("uploading");
        itemEl.classList.add("done");
      }
      setUploadStatus(t("uploadOk"), "success");
    } catch (e) {
      if (isAbortError(e)) { setUploadStatus(t("uploadCancelled") || "已取消", "info"); return; }
      if (statusEl) statusEl.textContent = "✗";
      if (itemEl) {
        itemEl.classList.remove("uploading");
        itemEl.classList.add("error");
      }
      setUploadStatus(t("uploadFail") + e.message, "error");
    }
  }
  btn.disabled = false;
}

// ── avtrDB Public Avatar Search ──
// ── Custom Glass Select Managers ──
VRCW.registerModule('upload', {
  addFiles,
  renderFileList,
  removeFile,
  startUpload,
});
renderAppVersionInfo();


// Original Avtrdb Logic
