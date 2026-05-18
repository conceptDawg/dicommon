// Colormap lookup tables (256 entries of [r, g, b])
const colormaps = {};

function buildLUT(name, fn) {
  const lut = new Array(256);
  for (let i = 0; i < 256; i++) lut[i] = fn(i / 255);
  colormaps[name] = lut;
}

function lerp3(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function piecewise(stops, t) {
  if (t <= 0) return stops[0][1];
  if (t >= 1) return stops[stops.length - 1][1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) {
      const f = (t - stops[i][0]) / (stops[i + 1][0] - stops[i][0]);
      return lerp3(stops[i][1], stops[i + 1][1], f);
    }
  }
  return stops[stops.length - 1][1];
}

buildLUT('grayscale', t => [t * 255, t * 255, t * 255]);
buildLUT('hot', t => piecewise([[0,[0,0,0]],[0.375,[255,0,0]],[0.75,[255,255,0]],[1,[255,255,255]]], t));
buildLUT('cool', t => [t * 255, (1 - t) * 255, 255]);
buildLUT('bone', t => piecewise([[0,[0,0,0]],[0.375,[84,84,116]],[0.75,[168,200,200]],[1,[255,255,255]]], t));
buildLUT('jet', t => piecewise([[0,[0,0,128]],[0.125,[0,0,255]],[0.375,[0,255,255]],[0.5,[0,255,0]],[0.625,[255,255,0]],[0.875,[255,0,0]],[1,[128,0,0]]], t));
buildLUT('viridis', t => piecewise([[0,[68,1,84]],[0.25,[59,82,139]],[0.5,[33,145,140]],[0.75,[94,201,98]],[1,[253,231,37]]], t));
buildLUT('inferno', t => piecewise([[0,[0,0,4]],[0.25,[87,16,110]],[0.5,[188,55,84]],[0.75,[249,142,9]],[1,[252,255,164]]], t));
buildLUT('xray-neon', t => piecewise([
  [0,[0,0,0]],[0.1,[10,20,30]],[0.25,[0,60,70]],[0.4,[0,130,140]],[0.55,[0,190,200]],
  [0.7,[200,80,20]],[0.82,[230,50,10]],[0.9,[255,140,0]],[0.95,[255,220,60]],[1,[255,255,200]]
], t));
buildLUT('human', t => piecewise([
  [0,[0,0,0]],[0.08,[30,5,5]],[0.15,[80,20,20]],[0.25,[120,40,35]],[0.35,[150,55,50]],
  [0.45,[165,75,65]],[0.55,[175,110,85]],[0.65,[190,145,110]],[0.75,[210,180,145]],
  [0.85,[230,210,180]],[0.92,[240,230,210]],[1,[250,245,230]]
], t));

let currentColormap = 'xray-neon';

// ============================================================
// VOLUME — flat Float32Array storage
// ============================================================
// Indexing: volume[z * volStrideZ + y * volStrideY + x]
let volume = null;            // Float32Array
let volStrideZ = 0;           // = rows * cols
let volStrideY = 0;           // = cols
let seriesData = [];
let currentSeries = null;
let volumeMeta = {
  rows: 0, cols: 0, numSlices: 0,
  windowCenter: 400, windowWidth: 1500,
  pixelSpacing: 0.3125, sliceThickness: 4.0,
  interpSlicesZ: 0, zRatio: 1,
  _histMin: 0, _histMax: 1,
};

// Inline-friendly voxel accessor (V8 will inline; we also hoist strides in hot loops)
function voxAt(z, y, x) { return volume[z * volStrideZ + y * volStrideY + x]; }

// MIP state — slab is in MILLIMETRES
let mipEnabled = false;
let mipSlabMm = 10;

// ============================================================
// OVERLAY — second co-registered volume blended over the primary
// ============================================================
const overlay = {
  volume: null,         // Float32Array
  strideZ: 0,           // rows * cols
  strideY: 0,           // cols
  rows: 0, cols: 0, numSlices: 0,
  wc: 400, ww: 800,
  colormap: 'jet',
  opacity: 0.5,
  enabled: false,
  seriesId: null,
};

// Crosshair state
let crosshairsEnabled = false;

// 2D upsample state — when on, MPR canvases render at 2× pixel dims with bilinear sampling
let upsampleEnabled = false;
let sharpenAmount = 0.1;
function upFactor() { return upsampleEnabled ? 2 : 1; }

// Reusable per-axis intensity buffers (Uint8 in [0..255])
const _intBufs = { axial: null, sagittal: null, coronal: null, scratch: null };
function getIntBuf(key, len) {
  let b = _intBufs[key];
  if (!b || b.length !== len) { b = new Uint8Array(len); _intBufs[key] = b; }
  return b;
}

// 3×3 unsharp mask: out = src * (1 + 8a) - a * (sum of 8 neighbors), clamped to [0,255]
// Writes into dst (must be different from src) and returns dst.
function sharpen3x3(src, w, h, amount, dst) {
  dst.set(src); // edges copied through
  const k = 1 + 8 * amount;
  const W = w;
  for (let y = 1; y < h - 1; y++) {
    const yo = y * W;
    for (let x = 1; x < W - 1; x++) {
      const i = yo + x;
      const sum = src[i - W - 1] + src[i - W] + src[i - W + 1]
                + src[i - 1] + src[i + 1]
                + src[i + W - 1] + src[i + W] + src[i + W + 1];
      let v = src[i] * k - amount * sum;
      if (v < 0) v = 0; else if (v > 255) v = 255;
      dst[i] = v;
    }
  }
  return dst;
}

// Bilinear upscale of a Uint8 intensity grid (native -> outW x outH = native * up).
function bilinearUpscaleU8(src, sw, sh, up, dst) {
  const dw = sw * up, dh = sh * up;
  for (let y = 0; y < dh; y++) {
    const vy = y / up;
    let r0 = vy | 0; if (r0 > sh - 1) r0 = sh - 1;
    const r1 = r0 + 1 < sh ? r0 + 1 : r0;
    const fy = vy - r0; const omy = 1 - fy;
    const r0Off = r0 * sw, r1Off = r1 * sw;
    for (let x = 0; x < dw; x++) {
      const vx = x / up;
      let c0 = vx | 0; if (c0 > sw - 1) c0 = sw - 1;
      const c1 = c0 + 1 < sw ? c0 + 1 : c0;
      const fx = vx - c0; const omx = 1 - fx;
      dst[y * dw + x] =
        src[r0Off + c0] * omx * omy + src[r0Off + c1] * fx * omy +
        src[r1Off + c0] * omx * fy + src[r1Off + c1] * fx * fy;
    }
  }
  return dst;
}

// Apply LUT to an intensity grid, writing into the RGB channels of imgData.data.
// ============================================================
// OVERLAY SAMPLING — bilinear in the overlay volume, output at MPR resolution
// (assumes overlay shares rows/cols/numSlices with the base)
// ============================================================
function sampleOverlayAxial(zOrig, outW, outH, up, key) {
  const ints = getIntBuf(key, outW * outH);
  const { rows, cols, numSlices, strideZ, volume: vol } = overlay;
  const lower = overlay.wc - overlay.ww / 2, ww = overlay.ww;
  let s0 = Math.floor(zOrig); if (s0 < 0) s0 = 0; else if (s0 > numSlices - 1) s0 = numSlices - 1;
  const s1 = s0 + 1 < numSlices ? s0 + 1 : s0;
  const frac = zOrig - s0, omF = 1 - frac;
  const b0 = s0 * strideZ, b1 = s1 * strideZ;
  for (let oy = 0; oy < outH; oy++) {
    const vy = oy / up;
    let r0 = vy | 0; if (r0 > rows - 1) r0 = rows - 1;
    const r1 = r0 + 1 < rows ? r0 + 1 : r0;
    const fy = vy - r0, omy = 1 - fy;
    const r0Off = r0 * cols, r1Off = r1 * cols;
    for (let ox = 0; ox < outW; ox++) {
      const vx = ox / up;
      let c0 = vx | 0; if (c0 > cols - 1) c0 = cols - 1;
      const c1 = c0 + 1 < cols ? c0 + 1 : c0;
      const fx = vx - c0, omx = 1 - fx;
      const v00 = vol[b0 + r0Off + c0] * omF + vol[b1 + r0Off + c0] * frac;
      const v01 = vol[b0 + r0Off + c1] * omF + vol[b1 + r0Off + c1] * frac;
      const v10 = vol[b0 + r1Off + c0] * omF + vol[b1 + r1Off + c0] * frac;
      const v11 = vol[b0 + r1Off + c1] * omF + vol[b1 + r1Off + c1] * frac;
      const raw = (v00 * omx + v01 * fx) * omy + (v10 * omx + v11 * fx) * fy;
      let v = (raw - lower) / ww * 255;
      if (v < 0) v = 0; else if (v > 255) v = 255;
      ints[oy * outW + ox] = v;
    }
  }
  return ints;
}

function sampleOverlaySagittal(col, ratio, outW, outH, up, key) {
  const ints = getIntBuf(key, outW * outH);
  const { rows, cols, numSlices, strideZ, volume: vol } = overlay;
  const lower = overlay.wc - overlay.ww / 2, ww = overlay.ww;
  for (let oy = 0; oy < outH; oy++) {
    const vy = oy / up;
    let r0 = vy | 0; if (r0 > rows - 1) r0 = rows - 1;
    const r1 = r0 + 1 < rows ? r0 + 1 : r0;
    const fy = vy - r0, omy = 1 - fy;
    const idx0 = r0 * cols + col, idx1 = r1 * cols + col;
    for (let ox = 0; ox < outW; ox++) {
      const vsi = ox / up;
      const origPos = vsi / ratio;
      let s0 = origPos | 0; if (s0 > numSlices - 1) s0 = numSlices - 1;
      const s1 = s0 + 1 < numSlices ? s0 + 1 : s0;
      const frac = origPos - s0, omF = 1 - frac;
      const b0 = s0 * strideZ, b1 = s1 * strideZ;
      const v00 = vol[b0 + idx0] * omF + vol[b1 + idx0] * frac;
      const v01 = vol[b0 + idx1] * omF + vol[b1 + idx1] * frac;
      const raw = v00 * omy + v01 * fy;
      let v = (raw - lower) / ww * 255;
      if (v < 0) v = 0; else if (v > 255) v = 255;
      ints[oy * outW + ox] = v;
    }
  }
  return ints;
}

function sampleOverlayCoronal(row, ratio, outW, outH, up, key) {
  const ints = getIntBuf(key, outW * outH);
  const { cols, numSlices, strideZ, volume: vol } = overlay;
  const lower = overlay.wc - overlay.ww / 2, ww = overlay.ww;
  const rowOff = row * cols;
  for (let oy = 0; oy < outH; oy++) {
    const vsi = oy / up;
    const origPos = vsi / ratio;
    let s0 = origPos | 0; if (s0 > numSlices - 1) s0 = numSlices - 1;
    const s1 = s0 + 1 < numSlices ? s0 + 1 : s0;
    const frac = origPos - s0, omF = 1 - frac;
    const b0 = s0 * strideZ, b1 = s1 * strideZ;
    for (let ox = 0; ox < outW; ox++) {
      const vx = ox / up;
      let c0 = vx | 0; if (c0 > cols - 1) c0 = cols - 1;
      const c1 = c0 + 1 < cols ? c0 + 1 : c0;
      const fx = vx - c0, omx = 1 - fx;
      const i0 = rowOff + c0, i1 = rowOff + c1;
      const vc0 = vol[b0 + i0] * omF + vol[b1 + i0] * frac;
      const vc1 = vol[b0 + i1] * omF + vol[b1 + i1] * frac;
      const raw = vc0 * omx + vc1 * fx;
      let v = (raw - lower) / ww * 255;
      if (v < 0) v = 0; else if (v > 255) v = 255;
      ints[oy * outW + ox] = v;
    }
  }
  return ints;
}

// Alpha-blend overlay color onto base RGB in-place.
// Voxels at or below the overlay window's lower bound (v=0) stay fully transparent.
function compositeOverlayOnto(data, overlayInts, overlayLut, opacity) {
  for (let i = 0, p = 0, n = overlayInts.length; i < n; i++, p += 4) {
    const v = overlayInts[i];
    if (v === 0) continue;
    const rgb = overlayLut[v];
    const a = opacity, ia = 1 - a;
    data[p]     = data[p]     * ia + rgb[0] * a;
    data[p + 1] = data[p + 1] * ia + rgb[1] * a;
    data[p + 2] = data[p + 2] * ia + rgb[2] * a;
  }
}

function colormapToImgData(ints, lut, data) {
  for (let i = 0, p = 0, n = ints.length; i < n; i++, p += 4) {
    const rgb = lut[ints[i]];
    data[p] = rgb[0]; data[p + 1] = rgb[1]; data[p + 2] = rgb[2];
  }
}

// Histogram cache
let histogramData = null;
let clickedIntensity = null;

function syncIsoFromClick(rawIntensity) {
  if (rawIntensity === null) return;
  const wc = parseFloat(document.getElementById('wc-slider').value);
  const ww = parseFloat(document.getElementById('ww-slider').value);
  const isoVal = Math.max(0, Math.min(1, (rawIntensity - (wc - ww / 2)) / ww));
  const isoCtrl = document.getElementById('solid-iso-ctrl');
  if (isoCtrl) {
    isoCtrl.value = isoVal.toFixed(2);
    const valEl = document.getElementById('solid-iso-ctrl-val');
    if (valEl) valEl.textContent = isoVal.toFixed(2);
    isoCtrl.dispatchEvent(new Event('input'));
  }
}

const axialCanvas = document.getElementById('axial-canvas');
const sagittalCanvas = document.getElementById('sagittal-canvas');
const coronalCanvas = document.getElementById('coronal-canvas');
const axialSlider = document.getElementById('axial-slider');
const sagittalSlider = document.getElementById('sagittal-slider');
const coronalSlider = document.getElementById('coronal-slider');
const wcSlider = document.getElementById('wc-slider');
const wwSlider = document.getElementById('ww-slider');

// Cached ImageData per canvas — recreated only when size changes
const _imgDataCache = { axial: null, sagittal: null, coronal: null };
function getImageData(ctx, key, w, h) {
  const cur = _imgDataCache[key];
  if (cur && cur.width === w && cur.height === h) return cur;
  const d = ctx.createImageData(w, h);
  // Pre-fill alpha to 255 so we don't have to write it every pixel
  for (let i = 3; i < d.data.length; i += 4) d.data[i] = 255;
  _imgDataCache[key] = d;
  return d;
}

// ============================================================
// LOCAL FOLDER LOADER — parses DICOM files on the client
// ============================================================
const _localPixels  = new Map(); // `${seriesId}/${file}` -> { meta, pixels }  (lazy)
const _localJpegUrls = new Map(); // `${seriesId}/${file}` -> blob URL          (lazy)
const _localSlices  = new Map(); // seriesId -> sorted slice list
const _localFiles   = new Map(); // `${seriesId}/${file}` -> File ref           (always)

function evictOtherLocalCaches(activeSeriesId) {
  const prefix = activeSeriesId + '/';
  for (const k of Array.from(_localPixels.keys())) {
    if (!k.startsWith(prefix)) _localPixels.delete(k);
  }
  for (const k of Array.from(_localJpegUrls.keys())) {
    if (!k.startsWith(prefix)) { URL.revokeObjectURL(_localJpegUrls.get(k)); _localJpegUrls.delete(k); }
  }
}

async function parseHeaderOnly(file) {
  const HEAD = 262144; // 256 KB usually covers everything before x7fe00010
  const slice = await file.slice(0, Math.min(file.size, HEAD)).arrayBuffer();
  try {
    return dicomParser.parseDicom(new Uint8Array(slice), { untilTag: 'x7fe00010' });
  } catch (_) {
    const full = await file.arrayBuffer();
    return dicomParser.parseDicom(new Uint8Array(full), { untilTag: 'x7fe00010' });
  }
}

async function materializeLocalSlice(seriesId, name) {
  const key = `${seriesId}/${name}`;
  if (_localPixels.has(key)) return { type: 'pixels', entry: _localPixels.get(key) };
  if (_localJpegUrls.has(key)) return { type: 'jpeg', url: _localJpegUrls.get(key) };
  const fileRef = _localFiles.get(key);
  if (!fileRef) return null;
  const buf = await fileRef.arrayBuffer();
  const ds = dicomParser.parseDicom(new Uint8Array(buf));
  const meta = extractMetaClient(ds);
  const px = ds.elements.x7fe00010;
  if (!px) return null;
  if (meta.browserJpeg && px.fragments && px.fragments.length) {
    const u8 = new Uint8Array(buf);
    let total = 0; for (const fr of px.fragments) total += fr.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const fr of px.fragments) {
      out.set(u8.subarray(fr.position, fr.position + fr.length), off);
      off += fr.length;
    }
    const url = URL.createObjectURL(new Blob([out], { type: 'image/jpeg' }));
    _localJpegUrls.set(key, url);
    return { type: 'jpeg', url };
  }
  let view;
  if (meta.bitsAllocated === 16) {
    view = meta.pixelRepresentation === 1
      ? new Int16Array(buf, px.dataOffset, px.length / 2).slice()
      : new Uint16Array(buf, px.dataOffset, px.length / 2).slice();
    meta.pixelType = meta.pixelRepresentation === 1 ? 'int16' : 'uint16';
  } else {
    view = new Uint8Array(buf, px.dataOffset, px.length).slice();
    meta.pixelType = 'uint8';
  }
  const entry = { meta, pixels: view };
  _localPixels.set(key, entry);
  return { type: 'pixels', entry };
}

const NATIVE_TS_CLIENT = new Set([
  '1.2.840.10008.1.2', '1.2.840.10008.1.2.1',
  '1.2.840.10008.1.2.1.99', '1.2.840.10008.1.2.2',
]);
const BROWSER_JPEG_TS_CLIENT = new Set([
  '1.2.840.10008.1.2.4.50', '1.2.840.10008.1.2.4.51',
]);

const SEG_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.66.4';

function extractMetaClient(ds) {
  const transferSyntax = ds.string('x00020010') || '';
  const samplesPerPixel = ds.uint16('x00280002') || 1;
  const photometric = ds.string('x00280004') || '';
  const sopClass = ds.string('x00080016') || '';
  const isSeg = sopClass === SEG_SOP_CLASS;
  const px = ds.elements.x7fe00010;
  const encapsulated = !!(px && px.encapsulatedPixelData)
    || (transferSyntax !== '' && !NATIVE_TS_CLIENT.has(transferSyntax));
  const displayable = isSeg || (!encapsulated && samplesPerPixel === 1
    && (NATIVE_TS_CLIENT.has(transferSyntax) || transferSyntax === '')
    && /MONOCHROME/i.test(photometric || 'MONOCHROME2'));
  const browserJpeg = encapsulated && BROWSER_JPEG_TS_CLIENT.has(transferSyntax);
  return {
    rows: ds.uint16('x00280010'),
    cols: ds.uint16('x00280011'),
    bitsAllocated: ds.uint16('x00280100'),
    bitsStored: ds.uint16('x00280101'),
    pixelRepresentation: ds.uint16('x00280103'),
    rescaleIntercept: parseFloat(ds.string('x00281052') || '0'),
    rescaleSlope: parseFloat(ds.string('x00281053') || '1'),
    windowCenter: parseFloat(ds.string('x00281050') || '127'),
    windowWidth: parseFloat(ds.string('x00281051') || '256'),
    imagePosition: ds.string('x00200032') || '',
    imageOrientation: ds.string('x00200037') || '',
    sliceLocation: parseFloat(ds.string('x00201041') || '0'),
    instanceNumber: parseInt(ds.string('x00200013') || '0'),
    pixelSpacing: ds.string('x00280030') || '',
    sliceThickness: parseFloat(ds.string('x00180050') || '0'),
    transferSyntax, samplesPerPixel, photometric, encapsulated, displayable, browserJpeg,
    sopClass, isSeg,
  };
}

// Decode a DICOM SEG object into per-frame label masks.
// Returns { rows, cols, frames: Uint8Array[], segIds: number[] } where each frame
// is a planar Uint8 grid with voxel = referenced segment number (0 = bg).
function decodeSegFrames(ds, buf) {
  const rows = ds.uint16('x00280010');
  const cols = ds.uint16('x00280011');
  const numFrames = parseInt(ds.string('x00280008') || '1');
  const bitsAllocated = ds.uint16('x00280100') || 1;
  const px = ds.elements.x7fe00010;
  if (!px) return { rows, cols, frames: [], segIds: [] };
  const planeSize = rows * cols;
  const u8 = new Uint8Array(buf, px.dataOffset, px.length);

  // Per-frame segment ID from PerFrameFunctionalGroupsSequence
  const segIds = new Array(numFrames).fill(1);
  const perFrame = ds.elements.x52009230;
  if (perFrame && perFrame.items) {
    for (let i = 0; i < Math.min(perFrame.items.length, numFrames); i++) {
      const fd = perFrame.items[i].dataSet;
      const segSeq = fd.elements && fd.elements.x0062000a;
      if (segSeq && segSeq.items && segSeq.items[0]) {
        const segDs = segSeq.items[0].dataSet;
        const segNum = segDs.uint16('x0062000b');
        if (segNum != null) segIds[i] = segNum;
      }
    }
  }

  const frames = new Array(numFrames);
  if (bitsAllocated === 1) {
    // Mask frames are packed bit-by-bit, LSB first; frames are tightly packed
    // (frame boundaries can land mid-byte). Walk a global bit cursor.
    let bitCursor = 0;
    for (let f = 0; f < numFrames; f++) {
      const mask = new Uint8Array(planeSize);
      const id = segIds[f];
      for (let i = 0; i < planeSize; i++) {
        const byte = u8[bitCursor >> 3];
        const bit = (byte >> (bitCursor & 7)) & 1;
        if (bit) mask[i] = id;
        bitCursor++;
      }
      frames[f] = mask;
    }
  } else {
    // BitsAllocated = 8 (or 16, rare): non-zero = present
    const stride = bitsAllocated === 16 ? 2 : 1;
    for (let f = 0; f < numFrames; f++) {
      const mask = new Uint8Array(planeSize);
      const id = segIds[f];
      const off = f * planeSize * stride;
      for (let i = 0; i < planeSize; i++) {
        const present = stride === 2
          ? (u8[off + i * 2] | (u8[off + i * 2 + 1] << 8))
          : u8[off + i];
        if (present) mask[i] = id;
      }
      frames[f] = mask;
    }
  }
  return { rows, cols, frames, segIds };
}

async function handleLocalFolder(fileList) {
  if (typeof dicomParser === 'undefined') {
    alert('dicom-parser failed to load (offline?). Cannot decode locally.');
    return;
  }
  const status = document.getElementById('folder-status');
  const loading = document.getElementById('loading');
  const progress = document.getElementById('load-progress');
  loading.classList.remove('hidden');

  const files = Array.from(fileList).filter(f => !f.name.startsWith('.') && f.size > 132);
  progress.textContent = `Parsing ${files.length} files...`;
  status.textContent = `${files.length} files`;

  // Free any prior local state to avoid leaks across loads
  for (const u of _localJpegUrls.values()) URL.revokeObjectURL(u);
  _localPixels.clear(); _localJpegUrls.clear(); _localSlices.clear(); _localFiles.clear();

  const bySeries = new Map();
  let done = 0, idx = 0;
  const CONC = 8;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= files.length) return;
      const f = files[i];
      try {
        const ds = await parseHeaderOnly(f);
        const seriesUID = ds.string('x0020000e') || ('unknown-' + (f.webkitRelativePath || f.name).split('/').slice(0, -1).join('/'));
        let g = bySeries.get(seriesUID);
        if (!g) { g = { uid: seriesUID, entries: [], firstDs: ds }; bySeries.set(seriesUID, g); }
        g.entries.push({ name: f.name, file: f, ds });
      } catch (_) { /* not a DICOM file — skip */ }
      done++;
      if ((done & 31) === 0 || done === files.length)
        progress.textContent = `Scanned ${done}/${files.length}`;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, files.length) }, worker));

  const newSeries = [];
  for (const [uid, g] of bySeries) {
    const ds0 = g.firstDs;
    const m0 = extractMetaClient(ds0);
    const seriesId = 'local:' + uid;
    const sliceList = [];

    for (const fe of g.entries) {
      const key = `${seriesId}/${fe.name}`;
      _localFiles.set(key, fe.file);
      sliceList.push({
        file: fe.name,
        instanceNumber: parseInt(fe.ds.string('x00200013') || '0'),
        sliceLocation: parseFloat(fe.ds.string('x00201041') || '0'),
        imagePosition: fe.ds.string('x00200032') || '',
      });
    }
    sliceList.sort((a, b) => (a.instanceNumber || 0) - (b.instanceNumber || 0));

    // Detect 4D acquisitions: frames sharing the same ImagePositionPatient belong
    // to different timepoints (perfusion, DWI b-values, fMRI). Tag each slice with
    // its timepoint t and remember how many timepoints exist for this series.
    const positionMap = new Map();
    for (const sl of sliceList) {
      const ps = sl.imagePosition || '';
      const key = ps
        ? ps.split('\\').map(v => (parseFloat(v) || 0).toFixed(2)).join('|')
        : `__nopos_${sliceList.indexOf(sl)}`;
      let arr = positionMap.get(key);
      if (!arr) { arr = []; positionMap.set(key, arr); }
      sl.t = arr.length;
      sl.posKey = key;
      arr.push(sl);
    }
    let numTimepoints = 1;
    for (const arr of positionMap.values()) if (arr.length > numTimepoints) numTimepoints = arr.length;
    _localSlices.set(seriesId, sliceList);

    newSeries.push({
      id: seriesId,
      fileCount: g.entries.length,
      files: sliceList.map(s => s.file),
      patientName: ds0.string('x00100010') || 'Unknown',
      patientId: ds0.string('x00100020') || '',
      studyDescription: ds0.string('x00081030') || '',
      seriesDescription: ds0.string('x0008103e') || ('Series ' + (ds0.string('x00200011') || '')),
      modality: ds0.string('x00080060') || '',
      sliceThickness: ds0.string('x00180050') || '',
      rows: m0.rows, columns: m0.cols,
      seriesNumber: ds0.string('x00200011') || '',
      imageOrientationPatient: ds0.string('x00200037') || '',
      displayable: m0.displayable, browserJpeg: m0.browserJpeg,
      transferSyntax: m0.transferSyntax, samplesPerPixel: m0.samplesPerPixel,
      photometric: m0.photometric, encapsulated: m0.encapsulated,
      isSeg: m0.isSeg, sopClass: m0.sopClass,
      numTimepoints,
    });
  }

  seriesData = newSeries.sort((a, b) => (parseInt(a.seriesNumber) || 0) - (parseInt(b.seriesNumber) || 0));
  renderSeriesList();
  renderOverlayPicker();
  loading.classList.add('hidden');
  status.textContent = `${seriesData.length} series · ${files.length} files`;
  const disp = seriesData.filter(s => s.displayable !== false);
  if (disp.length) {
    const best = disp.reduce((a, b) => a.fileCount > b.fileCount ? a : b);
    selectSeries(best.id);
  }
}

// Currently selected timepoint for 4D series. Resets on series change.
let currentTimepoint = 0;

async function getSlicesFor(seriesId) {
  if (_localSlices.has(seriesId)) {
    const all = _localSlices.get(seriesId);
    const series = seriesData.find(s => s.id === seriesId);
    if (!series || !series.numTimepoints || series.numTimepoints <= 1) return all;
    // Filter to the active timepoint, preserving instance-number order
    return all.filter(s => s.t === currentTimepoint);
  }
  const r = await fetch(`/api/series/${seriesId}/slices`);
  return await r.json();
}

async function init() {
  document.getElementById('folder-btn').addEventListener('click', () => {
    document.getElementById('folder-input').click();
  });
  document.getElementById('folder-input').addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length) handleLocalFolder(e.target.files);
  });

  let serverSeries = [];
  try {
    const res = await fetch('/api/series');
    if (res.ok) serverSeries = await res.json();
  } catch (_) { /* offline / no server — that's fine, local mode still works */ }
  seriesData = serverSeries;
  renderSeriesList();
  // Auto-pick the largest *displayable* series
  const displayable = seriesData.filter(s => s.displayable !== false);
  if (displayable.length > 0) {
    const best = displayable.reduce((a, b) => a.fileCount > b.fileCount ? a : b);
    selectSeries(best.id);
  }
}

function renderOverlayPicker() {
  const sel = document.getElementById('overlay-select');
  if (!sel) return;
  const opts = ['<option value="">— none —</option>'];
  for (const s of seriesData) {
    if (currentSeries && s.id === currentSeries.id) continue; // can't overlay self
    if (s.displayable === false || s.browserJpeg || s.isSeg) continue; // skip non-volume series
    opts.push(`<option value="${s.id}">${(s.seriesDescription || s.id).slice(0, 40)}</option>`);
  }
  sel.innerHTML = opts.join('');
  sel.value = overlay.seriesId || '';
  document.getElementById('overlay-controls').style.display = overlay.enabled ? 'block' : 'none';
}

async function loadOverlay(seriesId) {
  if (!seriesId) { clearOverlay(); return; }
  if (!volume) { alert('Load a primary series first.'); return; }
  const meta = seriesData.find(s => s.id === seriesId);
  if (!meta) return;

  const loading = document.getElementById('loading');
  const progress = document.getElementById('load-progress');
  loading.classList.remove('hidden');
  progress.textContent = `Loading overlay ${meta.seriesDescription || seriesId}...`;

  const slicesMeta = await getSlicesFor(seriesId);
  const N = slicesMeta.length;
  if (N === 0) { loading.classList.add('hidden'); return; }

  const first = await fetchSlice(seriesId, slicesMeta[0].file);
  const rows = first.meta.rows, cols = first.meta.cols;
  if (rows !== volumeMeta.rows || cols !== volumeMeta.cols || N !== volumeMeta.numSlices) {
    loading.classList.add('hidden');
    alert(`Overlay geometry doesn't match base.\nBase: ${volumeMeta.rows}×${volumeMeta.cols}×${volumeMeta.numSlices}\nOverlay: ${rows}×${cols}×${N}\n\n(Resampling not yet supported — use a co-registered series.)`);
    document.getElementById('overlay-select').value = '';
    return;
  }
  const planeSize = rows * cols;
  const vol = new Float32Array(N * planeSize);

  function writeSlice(z, meta, pixels) {
    const slope = meta.rescaleSlope || 1;
    const intercept = meta.rescaleIntercept || 0;
    const base = z * planeSize;
    for (let i = 0; i < planeSize; i++) vol[base + i] = pixels[i] * slope + intercept;
  }
  writeSlice(0, first.meta, first.pixels);

  let done = 1, nextIdx = 1;
  const CONCURRENCY = 8;
  async function worker() {
    while (true) {
      const i = nextIdx++;
      if (i >= N) return;
      const { meta: m, pixels } = await fetchSlice(seriesId, slicesMeta[i].file);
      writeSlice(i, m, pixels);
      done++;
      if ((done & 7) === 0 || done === N) progress.textContent = `Overlay ${done}/${N}`;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, N - 1) }, worker));

  // Auto-init W/L from data range
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < vol.length; i += 64) {
    const v = vol[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!isFinite(lo) || !isFinite(hi) || hi <= lo) { lo = 0; hi = 1; }
  overlay.wc = Math.round((lo + hi) / 2);
  overlay.ww = Math.max(1, Math.round(hi - lo));

  overlay.volume = vol;
  overlay.strideZ = planeSize;
  overlay.strideY = cols;
  overlay.rows = rows; overlay.cols = cols; overlay.numSlices = N;
  overlay.enabled = true;
  overlay.seriesId = seriesId;

  // Sync UI
  document.getElementById('overlay-controls').style.display = 'block';
  const wcEl = document.getElementById('overlay-wc'); wcEl.value = overlay.wc;
  document.getElementById('overlay-wc-val').textContent = overlay.wc;
  const wwEl = document.getElementById('overlay-ww'); wwEl.value = overlay.ww;
  document.getElementById('overlay-ww-val').textContent = overlay.ww;
  document.getElementById('overlay-colormap').value = overlay.colormap;

  loading.classList.add('hidden');
  renderAll();
}

function clearOverlay() {
  overlay.volume = null;
  overlay.enabled = false;
  overlay.seriesId = null;
  document.getElementById('overlay-controls').style.display = 'none';
  document.getElementById('overlay-select').value = '';
  renderAll();
}

function renderSeriesList() {
  const el = document.getElementById('series-list');
  el.innerHTML = seriesData.map(s => {
    const bad = s.displayable === false;
    const badge = bad ? ' <span class="series-badge" title="Not a viewable grayscale volume">⚠</span>' : '';
    return `<div class="series-item${bad ? ' unsupported' : ''}" data-id="${s.id}" onclick="selectSeries('${s.id}')">
      ${s.seriesDescription || s.id}${badge}
      <div class="count">${s.fileCount} slices · ${s.modality || '?'}</div>
    </div>`;
  }).join('');
}

async function selectSeries(id) {
  document.querySelectorAll('.series-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === id);
  });
  // Switching the primary invalidates any overlay (different anatomy / geometry)
  if (overlay.enabled && currentSeries && currentSeries.id !== id) clearOverlay();
  currentSeries = seriesData.find(s => s.id === id);
  if (id && id.startsWith('local:')) evictOtherLocalCaches(id);

  // Reset and show/hide the timepoint slider based on this series
  currentTimepoint = 0;
  const tpCtrl = document.getElementById('timepoint-control');
  const tpSlider = document.getElementById('timepoint-slider');
  const tpVal = document.getElementById('timepoint-val');
  const nt = currentSeries && currentSeries.numTimepoints || 1;
  if (nt > 1) {
    tpCtrl.style.display = '';
    tpSlider.max = nt - 1;
    tpSlider.value = 0;
    tpVal.textContent = `1/${nt}`;
  } else {
    tpCtrl.style.display = 'none';
  }
  showMetadata(currentSeries);
  if (currentSeries && currentSeries.isSeg) {
    await loadSegVolume(currentSeries);
    return;
  }
  if (currentSeries && currentSeries.browserJpeg) {
    await loadJpegStack(currentSeries);
    return;
  }
  if (currentSeries && currentSeries.displayable === false) {
    showUnsupported(currentSeries);
    return;
  }
  await loadVolume(id);
}

// --- Browser-decodable JPEG stack ---
// For DICOM series whose pixel data is encapsulated baseline JPEG we just
// hand each file to <img> and let the browser do the work. The axial slider
// scrubs between images; sagittal/coronal/3D are inert for this case.
let jpegStack = null; // { images: HTMLImageElement[] }

async function loadJpegStack(s) {
  const loading = document.getElementById('loading');
  const progress = document.getElementById('load-progress');
  loading.classList.remove('hidden');
  progress.textContent = `Loading ${s.fileCount} JPEG image(s)...`;

  // Drop volume state so the rest of the app knows not to touch it
  volume = null;
  if (window._reinit3D) {
    // Hide 3D content; _reinit3D handles teardown if volume is null
    window._reinit3D();
  }

  const images = await Promise.all(s.files.map(async (file) => {
    let src = _localJpegUrls.get(`${s.id}/${file}`);
    if (!src && _localFiles.has(`${s.id}/${file}`)) {
      const r = await materializeLocalSlice(s.id, file);
      if (r && r.type === 'jpeg') src = r.url;
    }
    if (!src) src = `/api/jpeg/${s.id}/${encodeURIComponent(file)}`;
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }));
  jpegStack = { images };
  loading.classList.add('hidden');

  // Repurpose the axial slider to scrub through the JPEG stack
  axialSlider.max = Math.max(0, images.length - 1);
  axialSlider.value = 0;
  sagittalSlider.max = 0; sagittalSlider.value = 0;
  coronalSlider.max = 0; coronalSlider.value = 0;
  renderJpegStack();
}

function renderJpegStack() {
  if (!jpegStack) return;
  const idx = Math.max(0, Math.min(jpegStack.images.length - 1, parseInt(axialSlider.value) || 0));
  const img = jpegStack.images[idx];

  // Draw to axial canvas at the image's natural resolution
  axialCanvas.width = img.naturalWidth;
  axialCanvas.height = img.naturalHeight;
  const ctx = axialCanvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  document.getElementById('axial-info').textContent = `${idx + 1}/${jpegStack.images.length}`;

  // Clear sagittal/coronal — they have no meaning for a JPEG stack
  for (const [c, label] of [[sagittalCanvas, 'sagittal-info'], [coronalCanvas, 'coronal-info']]) {
    c.width = 400; c.height = 100;
    const cx = c.getContext('2d');
    cx.fillStyle = '#0b0d12'; cx.fillRect(0, 0, c.width, c.height);
    cx.fillStyle = '#5a6470'; cx.font = '12px sans-serif';
    cx.fillText('— not applicable for JPEG series —', 24, 56);
    document.getElementById(label).textContent = '';
  }
}

function showUnsupported(s) {
  const loading = document.getElementById('loading');
  loading.classList.add('hidden');
  // Blank the three MPR canvases and write a note on the axial one.
  for (const canv of [axialCanvas, sagittalCanvas, coronalCanvas]) {
    canv.width = 600; canv.height = 220;
    const ctx = canv.getContext('2d');
    ctx.fillStyle = '#0b0d12'; ctx.fillRect(0, 0, canv.width, canv.height);
  }
  const ctx = axialCanvas.getContext('2d');
  ctx.fillStyle = '#e94560';
  ctx.font = 'bold 18px sans-serif';
  ctx.fillText('Series not viewable as a volume', 24, 48);
  ctx.fillStyle = '#9aa6b2';
  ctx.font = '13px sans-serif';
  const reason = s.encapsulated
    ? `Compressed transfer syntax (${s.transferSyntax || 'unknown'}) — JPEG/JPEG-2000 decoding is not yet supported.`
    : s.samplesPerPixel > 1
      ? `${s.samplesPerPixel}-sample color image (photometric ${s.photometric || 'unknown'}) — not a grayscale volume.`
      : 'This series is not a viewable grayscale volume.';
  wrapText(ctx, reason, 24, 78, 552, 18);
  ctx.fillStyle = '#7cc4ff';
  ctx.fillText(`${s.fileCount} slice(s) · ${s.modality || ''}`, 24, 180);
}

function wrapText(ctx, text, x, y, maxW, lineH) {
  const words = text.split(' ');
  let line = '';
  for (const w of words) {
    const test = line + w + ' ';
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, x, y);
      line = w + ' ';
      y += lineH;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, x, y);
}

function showMetadata(s) {
  if (!s) return;
  const info = document.getElementById('patient-info');
  info.textContent = `${s.patientName || 'Unknown'} · ${s.studyDescription || ''} · ${s.modality || ''}`;
  const md = document.getElementById('metadata-content');
  md.innerHTML = [
    ['Series', s.seriesDescription],
    ['Series #', s.seriesNumber],
    ['Modality', s.modality],
    ['Dimensions', `${s.rows}×${s.columns}`],
    ['Slice Thickness', s.sliceThickness ? s.sliceThickness + ' mm' : ''],
    ['Slices', s.fileCount],
    ['Patient ID', s.patientId],
  ].filter(([,v]) => v).map(([l,v]) => `<div><span class="label">${l}:</span> ${v}</div>`).join('');
}

// --- Binary slice fetch ---
async function fetchSlice(seriesId, file) {
  const localKey = `${seriesId}/${file}`;
  if (_localPixels.has(localKey)) return _localPixels.get(localKey);
  if (_localFiles.has(localKey)) {
    const r = await materializeLocalSlice(seriesId, file);
    return r && r.entry ? r.entry : { meta: { pixelType: 'none' }, pixels: new Uint8Array(0) };
  }
  const r = await fetch(`/api/pixels/${seriesId}/${encodeURIComponent(file)}`);
  if (!r.ok) throw new Error(`fetch ${file}: ${r.status}`);
  const metaHeader = r.headers.get('X-DICOM-Meta');
  const meta = JSON.parse(decodeURIComponent(metaHeader));
  const buf = await r.arrayBuffer();
  let view;
  if (meta.pixelType === 'int16') view = new Int16Array(buf);
  else if (meta.pixelType === 'uint16') view = new Uint16Array(buf);
  else if (meta.pixelType === 'uint8') view = new Uint8Array(buf);
  else view = new Uint8Array(0);
  return { meta, pixels: view };
}

async function loadSegVolume(s) {
  jpegStack = null;
  const loading = document.getElementById('loading');
  const progress = document.getElementById('load-progress');
  loading.classList.remove('hidden');
  progress.textContent = 'Decoding SEG…';

  const file = s.files[0];
  const localKey = `${s.id}/${file}`;
  let buf;
  if (_localFiles.has(localKey)) {
    buf = await _localFiles.get(localKey).arrayBuffer();
  } else {
    const r = await fetch(`/api/dicom/${s.id}/${encodeURIComponent(file)}`);
    if (!r.ok) { loading.classList.add('hidden'); return; }
    buf = await r.arrayBuffer();
  }
  const ds = dicomParser.parseDicom(new Uint8Array(buf));
  const dec = decodeSegFrames(ds, buf);
  if (!dec.frames.length) {
    loading.classList.add('hidden');
    showUnsupported({ ...s, encapsulated: false, samplesPerPixel: 1, photometric: 'SEG (empty)' });
    return;
  }

  const N = dec.frames.length;
  const planeSize = dec.rows * dec.cols;
  const maxSeg = Math.max(1, ...dec.segIds);
  // Spread label IDs across [10..245] so the colormap gives distinct colors and bg=0 stays dark
  const lo = 10, hi = 245;
  const scale = maxSeg > 1 ? (hi - lo) / (maxSeg - 1) : 0;

  volume = new Float32Array(N * planeSize);
  volStrideZ = planeSize;
  volStrideY = dec.cols;
  for (let z = 0; z < N; z++) {
    const base = z * planeSize;
    const m = dec.frames[z];
    for (let i = 0; i < planeSize; i++) {
      const id = m[i];
      volume[base + i] = id === 0 ? 0 : (lo + (id - 1) * scale);
    }
  }

  volumeMeta.rows = dec.rows;
  volumeMeta.cols = dec.cols;
  volumeMeta.numSlices = N;
  volumeMeta.pixelSpacing = 1;
  volumeMeta.sliceThickness = 1;
  volumeMeta.zRatio = 1;
  volumeMeta.interpSlicesZ = N;
  volumeMeta.windowCenter = 128;
  volumeMeta.windowWidth = 256;

  axialSlider.max = N - 1; axialSlider.value = Math.floor(N / 2);
  sagittalSlider.max = dec.cols - 1; sagittalSlider.value = Math.floor(dec.cols / 2);
  coronalSlider.max = dec.rows - 1; coronalSlider.value = Math.floor(dec.rows / 2);
  wcSlider.value = 128; wwSlider.value = 256;
  document.getElementById('wc-val').textContent = '128';
  document.getElementById('ww-val').textContent = '256';

  // Discrete labels look best on jet-style palettes
  currentColormap = 'jet';
  document.getElementById('colormap-select').value = 'jet';

  computeHistogram();
  renderHistogram();
  loading.classList.add('hidden');
  renderAll();
  renderBookmarkList();
  if (window._reinit3D) window._reinit3D();
  console.log(`[SEG] ${N} frame(s), ${maxSeg} segment(s):`, Array.from(new Set(dec.segIds)).sort((a, b) => a - b));
}

async function loadVolume(seriesId) {
  jpegStack = null; // leaving JPEG mode if we were in it
  const loading = document.getElementById('loading');
  const progress = document.getElementById('load-progress');
  loading.classList.remove('hidden');
  progress.textContent = 'Reading slice list...';

  const slicesMeta = await getSlicesFor(seriesId);
  const N = slicesMeta.length;
  if (N === 0) { loading.classList.add('hidden'); return; }

  // First slice serially — establishes dimensions
  const first = await fetchSlice(seriesId, slicesMeta[0].file);
  const rows = first.meta.rows, cols = first.meta.cols;
  const planeSize = rows * cols;
  volume = new Float32Array(N * planeSize);
  volStrideZ = planeSize;
  volStrideY = cols;
  volumeMeta.rows = rows;
  volumeMeta.cols = cols;
  volumeMeta.numSlices = N;
  volumeMeta.windowCenter = first.meta.windowCenter || 400;
  volumeMeta.windowWidth = first.meta.windowWidth || 1500;
  if (first.meta.pixelSpacing) {
    const parts = String(first.meta.pixelSpacing).split('\\');
    if (parts.length >= 2) volumeMeta.pixelSpacing = parseFloat(parts[0]);
  }
  if (first.meta.sliceThickness) volumeMeta.sliceThickness = first.meta.sliceThickness;

  // Helper: copy slice pixels into flat volume with rescale
  function writeSlice(z, meta, pixels) {
    const slope = meta.rescaleSlope || 1;
    const intercept = meta.rescaleIntercept || 0;
    const base = z * planeSize;
    for (let i = 0; i < planeSize; i++) volume[base + i] = pixels[i] * slope + intercept;
  }
  writeSlice(0, first.meta, first.pixels);

  // Parallel fetch of remaining slices with bounded concurrency
  let done = 1;
  let nextIdx = 1;
  const CONCURRENCY = 8;
  async function worker() {
    while (true) {
      const i = nextIdx++;
      if (i >= N) return;
      const { meta, pixels } = await fetchSlice(seriesId, slicesMeta[i].file);
      writeSlice(i, meta, pixels);
      done++;
      if ((done & 7) === 0 || done === N) progress.textContent = `${done} / ${N}`;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, N - 1) }, worker));

  // Derived metadata
  const ratio = volumeMeta.sliceThickness / volumeMeta.pixelSpacing;
  volumeMeta.zRatio = ratio;
  volumeMeta.interpSlicesZ = Math.round((N - 1) * ratio) + 1;
  axialSlider.max = volumeMeta.interpSlicesZ - 1;
  axialSlider.value = Math.floor(volumeMeta.interpSlicesZ / 2);
  sagittalSlider.max = cols - 1;
  sagittalSlider.value = Math.floor(cols / 2);
  coronalSlider.max = rows - 1;
  coronalSlider.value = Math.floor(rows / 2);

  wcSlider.value = volumeMeta.windowCenter;
  wwSlider.value = volumeMeta.windowWidth;
  document.getElementById('wc-val').textContent = Math.round(volumeMeta.windowCenter);
  document.getElementById('ww-val').textContent = Math.round(volumeMeta.windowWidth);

  computeHistogram();
  renderHistogram();
  loading.classList.add('hidden');
  renderAll();
  renderBookmarkList();
  renderOverlayPicker();
  if (window._reinit3D) window._reinit3D();
}

function applyColormap(imgData, p, grayVal) {
  const idx = Math.round(Math.max(0, Math.min(255, grayVal)));
  const rgb = colormaps[currentColormap][idx];
  imgData.data[p] = rgb[0];
  imgData.data[p + 1] = rgb[1];
  imgData.data[p + 2] = rgb[2];
  // alpha pre-filled to 255
}

function applyWindow(value, wc, ww) {
  const lower = wc - ww / 2;
  if (value <= lower) return 0;
  const upper = wc + ww / 2;
  if (value >= upper) return 255;
  return ((value - lower) / ww) * 255;
}

// --- MIP slab per-axis (mm → voxels) ---
function halfSlabVoxels(axis) {
  if (!mipEnabled) return 0;
  const spacing = (axis === 'axial')
    ? volumeMeta.sliceThickness
    : volumeMeta.pixelSpacing;
  return Math.max(0, Math.floor((mipSlabMm / spacing) / 2));
}

// MIP along the slab axis; only called when mipEnabled
function mipValue(centerSlice, r, c, halfSlab, axis) {
  let maxVal = -Infinity;
  if (axis === 'axial') {
    const lo = Math.max(0, centerSlice - halfSlab);
    const hi = Math.min(volumeMeta.numSlices - 1, centerSlice + halfSlab);
    const rowBase = r * volStrideY + c;
    for (let z = lo; z <= hi; z++) {
      const v = volume[z * volStrideZ + rowBase];
      if (v > maxVal) maxVal = v;
    }
  } else if (axis === 'sagittal') {
    const lo = Math.max(0, c - halfSlab);
    const hi = Math.min(volumeMeta.cols - 1, c + halfSlab);
    const base = centerSlice * volStrideZ + r * volStrideY;
    for (let cc = lo; cc <= hi; cc++) {
      const v = volume[base + cc];
      if (v > maxVal) maxVal = v;
    }
  } else { // coronal
    const lo = Math.max(0, r - halfSlab);
    const hi = Math.min(volumeMeta.rows - 1, r + halfSlab);
    const zBase = centerSlice * volStrideZ + c;
    for (let rr = lo; rr <= hi; rr++) {
      const v = volume[zBase + rr * volStrideY];
      if (v > maxVal) maxVal = v;
    }
  }
  return maxVal;
}

function renderAxial() {
  if (!volume) return;
  const interpIdx = parseInt(axialSlider.value);
  const { rows, cols, numSlices, zRatio } = volumeMeta;
  const wc = parseFloat(wcSlider.value);
  const ww = parseFloat(wwSlider.value);
  const halfSlab = halfSlabVoxels('axial');

  const origPos = interpIdx / zRatio;
  const s0 = Math.floor(origPos);
  const s1 = Math.min(s0 + 1, numSlices - 1);
  const frac = origPos - s0;
  const oneMinusFrac = 1 - frac;

  const up = upFactor();
  const outW = cols * up, outH = rows * up;
  const lut = colormaps[currentColormap];
  const lower = wc - ww / 2;

  const ints = getIntBuf('axial', outW * outH);

  if (mipEnabled) {
    // Compute windowed intensities at native, then bilinear-upscale (if up>1)
    const native = up === 1 ? ints : getIntBuf('axialMip', cols * rows);
    const centerSlice = Math.round(origPos);
    for (let r = 0; r < rows; r++) {
      const yOff = r * cols;
      for (let c = 0; c < cols; c++) {
        const raw = mipValue(centerSlice, r, c, halfSlab, 'axial');
        let v = (raw - lower) / ww * 255;
        if (v < 0) v = 0; else if (v > 255) v = 255;
        native[yOff + c] = v;
      }
    }
    if (up > 1) bilinearUpscaleU8(native, cols, rows, up, ints);
  } else {
    const base0 = s0 * volStrideZ;
    const base1 = s1 * volStrideZ;
    if (up === 1) {
      for (let r = 0; r < rows; r++) {
        const rowOff = r * cols;
        for (let c = 0; c < cols; c++) {
          const raw = volume[base0 + rowOff + c] * oneMinusFrac + volume[base1 + rowOff + c] * frac;
          let v = (raw - lower) / ww * 255;
          if (v < 0) v = 0; else if (v > 255) v = 255;
          ints[rowOff + c] = v;
        }
      }
    } else {
      // True voxel-bilinear: interpolate raw intensities → window → store
      for (let oy = 0; oy < outH; oy++) {
        const vy = oy / up;
        let r0 = vy | 0; if (r0 > rows - 1) r0 = rows - 1;
        const r1 = r0 + 1 < rows ? r0 + 1 : r0;
        const fy = vy - r0; const omy = 1 - fy;
        const r0Off = r0 * cols, r1Off = r1 * cols;
        for (let ox = 0; ox < outW; ox++) {
          const vx = ox / up;
          let c0 = vx | 0; if (c0 > cols - 1) c0 = cols - 1;
          const c1 = c0 + 1 < cols ? c0 + 1 : c0;
          const fx = vx - c0; const omx = 1 - fx;
          const v00 = volume[base0 + r0Off + c0] * oneMinusFrac + volume[base1 + r0Off + c0] * frac;
          const v01 = volume[base0 + r0Off + c1] * oneMinusFrac + volume[base1 + r0Off + c1] * frac;
          const v10 = volume[base0 + r1Off + c0] * oneMinusFrac + volume[base1 + r1Off + c0] * frac;
          const v11 = volume[base0 + r1Off + c1] * oneMinusFrac + volume[base1 + r1Off + c1] * frac;
          const raw = (v00 * omx + v01 * fx) * omy + (v10 * omx + v11 * fx) * fy;
          let v = (raw - lower) / ww * 255;
          if (v < 0) v = 0; else if (v > 255) v = 255;
          ints[oy * outW + ox] = v;
        }
      }
    }
  }

  let finalInts = ints;
  if (up > 1 && sharpenAmount > 0) {
    finalInts = sharpen3x3(ints, outW, outH, sharpenAmount, getIntBuf('axialSharp', outW * outH));
  }

  axialCanvas.width = outW; axialCanvas.height = outH;
  const ctx = axialCanvas.getContext('2d');
  const imgData = getImageData(ctx, 'axial', outW, outH);
  colormapToImgData(finalInts, lut, imgData.data);
  if (overlay.enabled && overlay.volume) {
    const ovInts = sampleOverlayAxial(origPos, outW, outH, up, 'overlayAxial');
    compositeOverlayOnto(imgData.data, ovInts, colormaps[overlay.colormap], overlay.opacity);
  }
  ctx.putImageData(imgData, 0, 0);
  document.getElementById('axial-info').textContent =
    `${Math.round(origPos) + 1}/${numSlices} (${interpIdx + 1}/${volumeMeta.interpSlicesZ})`;
  drawCrosshairs();
}

function renderSagittal() {
  if (!volume) return;
  const col = parseInt(sagittalSlider.value);
  const { rows, cols, numSlices, pixelSpacing, sliceThickness } = volumeMeta;
  const wc = parseFloat(wcSlider.value);
  const ww = parseFloat(wwSlider.value);
  const halfSlab = halfSlabVoxels('sagittal');

  const ratio = sliceThickness / pixelSpacing;
  const interpSlices = Math.round((numSlices - 1) * ratio) + 1;

  const up = upFactor();
  const outW = interpSlices * up, outH = rows * up;
  const lut = colormaps[currentColormap];
  const lower = wc - ww / 2;
  const ints = getIntBuf('sagittal', outW * outH);

  if (mipEnabled) {
    const native = up === 1 ? ints : getIntBuf('sagittalMip', interpSlices * rows);
    for (let si = 0; si < interpSlices; si++) {
      const origPos = si / ratio;
      const s0 = Math.floor(origPos);
      const s1 = Math.min(s0 + 1, numSlices - 1);
      const frac = origPos - s0;
      const oneMinusFrac = 1 - frac;
      const base0 = s0 * volStrideZ, base1 = s1 * volStrideZ;
      const lo = Math.max(0, col - halfSlab), hi = Math.min(cols - 1, col + halfSlab);
      for (let r = 0; r < rows; r++) {
        const rOff = r * cols;
        let maxVal = -Infinity;
        for (let cc = lo; cc <= hi; cc++) {
          const v0 = volume[base0 + rOff + cc] * oneMinusFrac + volume[base1 + rOff + cc] * frac;
          if (v0 > maxVal) maxVal = v0;
        }
        let v = (maxVal - lower) / ww * 255;
        if (v < 0) v = 0; else if (v > 255) v = 255;
        native[r * interpSlices + si] = v;
      }
    }
    if (up > 1) bilinearUpscaleU8(native, interpSlices, rows, up, ints);
  } else if (up === 1) {
    for (let si = 0; si < interpSlices; si++) {
      const origPos = si / ratio;
      const s0 = Math.floor(origPos);
      const s1 = Math.min(s0 + 1, numSlices - 1);
      const frac = origPos - s0;
      const oneMinusFrac = 1 - frac;
      const base0 = s0 * volStrideZ, base1 = s1 * volStrideZ;
      for (let r = 0; r < rows; r++) {
        const idx = r * cols + col;
        const val = volume[base0 + idx] * oneMinusFrac + volume[base1 + idx] * frac;
        let v = (val - lower) / ww * 255;
        if (v < 0) v = 0; else if (v > 255) v = 255;
        ints[r * interpSlices + si] = v;
      }
    }
  } else {
    // True voxel-bilinear at up>1: si fractional, r fractional, col fixed
    for (let oy = 0; oy < outH; oy++) {
      const vy = oy / up;
      let r0 = vy | 0; if (r0 > rows - 1) r0 = rows - 1;
      const r1 = r0 + 1 < rows ? r0 + 1 : r0;
      const fy = vy - r0; const omy = 1 - fy;
      const idx0 = r0 * cols + col, idx1 = r1 * cols + col;
      for (let ox = 0; ox < outW; ox++) {
        const vsi = ox / up;
        const origPos = vsi / ratio;
        let s0 = origPos | 0; if (s0 > numSlices - 1) s0 = numSlices - 1;
        const s1 = s0 + 1 < numSlices ? s0 + 1 : s0;
        const frac = origPos - s0; const omF = 1 - frac;
        const base0 = s0 * volStrideZ, base1 = s1 * volStrideZ;
        const v00 = volume[base0 + idx0] * omF + volume[base1 + idx0] * frac;
        const v01 = volume[base0 + idx1] * omF + volume[base1 + idx1] * frac;
        const raw = v00 * omy + v01 * fy;
        let v = (raw - lower) / ww * 255;
        if (v < 0) v = 0; else if (v > 255) v = 255;
        ints[oy * outW + ox] = v;
      }
    }
  }

  let finalInts = ints;
  if (up > 1 && sharpenAmount > 0) {
    finalInts = sharpen3x3(ints, outW, outH, sharpenAmount, getIntBuf('sagittalSharp', outW * outH));
  }

  sagittalCanvas.width = outW; sagittalCanvas.height = outH;
  const ctx = sagittalCanvas.getContext('2d');
  const imgData = getImageData(ctx, 'sagittal', outW, outH);
  colormapToImgData(finalInts, lut, imgData.data);
  if (overlay.enabled && overlay.volume) {
    const ovInts = sampleOverlaySagittal(col, ratio, outW, outH, up, 'overlaySagittal');
    compositeOverlayOnto(imgData.data, ovInts, colormaps[overlay.colormap], overlay.opacity);
  }
  ctx.putImageData(imgData, 0, 0);
  document.getElementById('sagittal-info').textContent = `${col + 1}/${cols}`;
  drawCrosshairs();
}

function renderCoronal() {
  if (!volume) return;
  const row = parseInt(coronalSlider.value);
  const { rows, cols, numSlices, pixelSpacing, sliceThickness } = volumeMeta;
  const wc = parseFloat(wcSlider.value);
  const ww = parseFloat(wwSlider.value);
  const halfSlab = halfSlabVoxels('coronal');

  const ratio = sliceThickness / pixelSpacing;
  const interpSlices = Math.round((numSlices - 1) * ratio) + 1;

  const up = upFactor();
  const outW = cols * up, outH = interpSlices * up;
  const lut = colormaps[currentColormap];
  const lower = wc - ww / 2;
  const ints = getIntBuf('coronal', outW * outH);

  if (mipEnabled) {
    const native = up === 1 ? ints : getIntBuf('coronalMip', cols * interpSlices);
    for (let si = 0; si < interpSlices; si++) {
      const origPos = si / ratio;
      const s0 = Math.floor(origPos);
      const s1 = Math.min(s0 + 1, numSlices - 1);
      const frac = origPos - s0;
      const oneMinusFrac = 1 - frac;
      const base0 = s0 * volStrideZ, base1 = s1 * volStrideZ;
      const lo = Math.max(0, row - halfSlab), hi = Math.min(rows - 1, row + halfSlab);
      for (let c = 0; c < cols; c++) {
        let maxVal = -Infinity;
        for (let rr = lo; rr <= hi; rr++) {
          const idx = rr * cols + c;
          const v0 = volume[base0 + idx] * oneMinusFrac + volume[base1 + idx] * frac;
          if (v0 > maxVal) maxVal = v0;
        }
        let v = (maxVal - lower) / ww * 255;
        if (v < 0) v = 0; else if (v > 255) v = 255;
        native[si * cols + c] = v;
      }
    }
    if (up > 1) bilinearUpscaleU8(native, cols, interpSlices, up, ints);
  } else if (up === 1) {
    for (let si = 0; si < interpSlices; si++) {
      const origPos = si / ratio;
      const s0 = Math.floor(origPos);
      const s1 = Math.min(s0 + 1, numSlices - 1);
      const frac = origPos - s0;
      const oneMinusFrac = 1 - frac;
      const base0 = s0 * volStrideZ, base1 = s1 * volStrideZ;
      const rowOff = row * cols;
      for (let c = 0; c < cols; c++) {
        const val = volume[base0 + rowOff + c] * oneMinusFrac + volume[base1 + rowOff + c] * frac;
        let v = (val - lower) / ww * 255;
        if (v < 0) v = 0; else if (v > 255) v = 255;
        ints[si * cols + c] = v;
      }
    }
  } else {
    // True voxel-bilinear at up>1: si fractional, c fractional, row fixed
    const rowOff = row * cols;
    for (let oy = 0; oy < outH; oy++) {
      const vsi = oy / up;
      const origPos = vsi / ratio;
      let s0 = origPos | 0; if (s0 > numSlices - 1) s0 = numSlices - 1;
      const s1 = s0 + 1 < numSlices ? s0 + 1 : s0;
      const frac = origPos - s0; const omF = 1 - frac;
      const base0 = s0 * volStrideZ, base1 = s1 * volStrideZ;
      for (let ox = 0; ox < outW; ox++) {
        const vx = ox / up;
        let c0 = vx | 0; if (c0 > cols - 1) c0 = cols - 1;
        const c1 = c0 + 1 < cols ? c0 + 1 : c0;
        const fx = vx - c0; const omx = 1 - fx;
        const i0 = rowOff + c0, i1 = rowOff + c1;
        const vc0 = volume[base0 + i0] * omF + volume[base1 + i0] * frac;
        const vc1 = volume[base0 + i1] * omF + volume[base1 + i1] * frac;
        const raw = vc0 * omx + vc1 * fx;
        let v = (raw - lower) / ww * 255;
        if (v < 0) v = 0; else if (v > 255) v = 255;
        ints[oy * outW + ox] = v;
      }
    }
  }

  let finalInts = ints;
  if (up > 1 && sharpenAmount > 0) {
    finalInts = sharpen3x3(ints, outW, outH, sharpenAmount, getIntBuf('coronalSharp', outW * outH));
  }

  coronalCanvas.width = outW; coronalCanvas.height = outH;
  const ctx = coronalCanvas.getContext('2d');
  const imgData = getImageData(ctx, 'coronal', outW, outH);
  colormapToImgData(finalInts, lut, imgData.data);
  if (overlay.enabled && overlay.volume) {
    const ovInts = sampleOverlayCoronal(row, ratio, outW, outH, up, 'overlayCoronal');
    compositeOverlayOnto(imgData.data, ovInts, colormaps[overlay.colormap], overlay.opacity);
  }
  ctx.putImageData(imgData, 0, 0);
  document.getElementById('coronal-info').textContent = `${row + 1}/${rows}`;
  drawCrosshairs();
}

function renderAll() {
  if (jpegStack) { renderJpegStack(); return; }
  renderAxial();
  renderSagittal();
  renderCoronal();
  if (window._updateSlicePlanePositions) window._updateSlicePlanePositions();
  if (window._invalidate3D) window._invalidate3D();
}

// ==================== CROSSHAIRS ====================

function drawCrosshairs() {
  if (!crosshairsEnabled || !volume) return;
  const sagCol = parseInt(sagittalSlider.value);
  const corRow = parseInt(coronalSlider.value);
  const axSlice = parseInt(axialSlider.value);
  const { rows, cols, numSlices, sliceThickness, pixelSpacing } = volumeMeta;
  const ratio = sliceThickness / pixelSpacing;
  const interpSlices = Math.round((numSlices - 1) * ratio) + 1;
  const up = upFactor();

  {
    const ctx = axialCanvas.getContext('2d');
    ctx.save(); ctx.scale(up, up);
    ctx.strokeStyle = 'rgba(0,200,255,0.7)'; ctx.lineWidth = 1 / up;
    ctx.beginPath(); ctx.moveTo(sagCol + 0.5, 0); ctx.lineTo(sagCol + 0.5, rows); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,100,0,0.7)';
    ctx.beginPath(); ctx.moveTo(0, corRow + 0.5); ctx.lineTo(cols, corRow + 0.5); ctx.stroke();
    ctx.restore();
  }
  {
    const ctx = sagittalCanvas.getContext('2d');
    ctx.save(); ctx.scale(up, up);
    ctx.strokeStyle = 'rgba(255,255,0,0.7)'; ctx.lineWidth = 1 / up;
    ctx.beginPath(); ctx.moveTo(axSlice + 0.5, 0); ctx.lineTo(axSlice + 0.5, rows); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,100,0,0.7)';
    ctx.beginPath(); ctx.moveTo(0, corRow + 0.5); ctx.lineTo(interpSlices, corRow + 0.5); ctx.stroke();
    ctx.restore();
  }
  {
    const ctx = coronalCanvas.getContext('2d');
    ctx.save(); ctx.scale(up, up);
    ctx.strokeStyle = 'rgba(0,200,255,0.7)'; ctx.lineWidth = 1 / up;
    ctx.beginPath(); ctx.moveTo(sagCol + 0.5, 0); ctx.lineTo(sagCol + 0.5, interpSlices); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,0,0.7)';
    ctx.beginPath(); ctx.moveTo(0, axSlice + 0.5); ctx.lineTo(cols, axSlice + 0.5); ctx.stroke();
    ctx.restore();
  }
}

function canvasClickToVoxel(canvas, e) {
  const rect = canvas.getBoundingClientRect();
  const up = upFactor();
  const cx = ((e.clientX - rect.left) / rect.width * canvas.width) / up;
  const cy = ((e.clientY - rect.top) / rect.height * canvas.height) / up;
  return { cx, cy };
}

function safeInterpAxial(z, row, col) {
  const origPos = z / (volumeMeta.zRatio || 1);
  const s0 = Math.max(0, Math.min(volumeMeta.numSlices - 1, Math.floor(origPos)));
  const s1 = Math.min(s0 + 1, volumeMeta.numSlices - 1);
  const frac = origPos - Math.floor(origPos);
  const off = row * volStrideY + col;
  return volume[s0 * volStrideZ + off] * (1 - frac) + volume[s1 * volStrideZ + off] * frac;
}

axialCanvas.addEventListener('click', (e) => {
  if (!volume) return;
  const { cx, cy } = canvasClickToVoxel(axialCanvas, e);
  const col = Math.round(Math.max(0, Math.min(volumeMeta.cols - 1, cx)));
  const row = Math.round(Math.max(0, Math.min(volumeMeta.rows - 1, cy)));
  sagittalSlider.value = col;
  coronalSlider.value = row;
  const interpIdx = parseInt(axialSlider.value);
  const origPos = interpIdx / (volumeMeta.zRatio || 1);
  if (mipEnabled) {
    clickedIntensity = mipValue(Math.round(origPos), row, col, halfSlabVoxels('axial'), 'axial');
  } else {
    clickedIntensity = safeInterpAxial(interpIdx, row, col);
  }
  syncIsoFromClick(clickedIntensity);
  renderAll();
  renderHistogram();
});

sagittalCanvas.addEventListener('click', (e) => {
  if (!volume) return;
  const { cx, cy } = canvasClickToVoxel(sagittalCanvas, e);
  const z = Math.round(Math.max(0, Math.min(parseInt(axialSlider.max), cx)));
  const row = Math.round(Math.max(0, Math.min(volumeMeta.rows - 1, cy)));
  axialSlider.value = z;
  coronalSlider.value = row;
  const col = parseInt(sagittalSlider.value);
  const origPos = z / (volumeMeta.zRatio || 1);
  if (mipEnabled) {
    clickedIntensity = mipValue(Math.round(origPos), row, col, halfSlabVoxels('sagittal'), 'sagittal');
  } else {
    clickedIntensity = safeInterpAxial(z, row, col);
  }
  syncIsoFromClick(clickedIntensity);
  renderAll();
  renderHistogram();
});

coronalCanvas.addEventListener('click', (e) => {
  if (!volume) return;
  const { cx, cy } = canvasClickToVoxel(coronalCanvas, e);
  const col = Math.round(Math.max(0, Math.min(volumeMeta.cols - 1, cx)));
  const z = Math.round(Math.max(0, Math.min(parseInt(axialSlider.max), cy)));
  sagittalSlider.value = col;
  axialSlider.value = z;
  const row = parseInt(coronalSlider.value);
  const origPos = z / (volumeMeta.zRatio || 1);
  if (mipEnabled) {
    clickedIntensity = mipValue(Math.round(origPos), row, col, halfSlabVoxels('coronal'), 'coronal');
  } else {
    clickedIntensity = safeInterpAxial(z, row, col);
  }
  syncIsoFromClick(clickedIntensity);
  renderAll();
  renderHistogram();
});

document.getElementById('upsample-checkbox').addEventListener('change', (e) => {
  upsampleEnabled = e.target.checked;
  renderAll();
});

document.getElementById('sharpen-slider').addEventListener('input', (e) => {
  sharpenAmount = parseFloat(e.target.value);
  document.getElementById('sharpen-val').textContent = sharpenAmount.toFixed(3);
  renderAll();
});

document.getElementById('crosshair-checkbox').addEventListener('change', (e) => {
  crosshairsEnabled = e.target.checked;
  renderAll();
  const sp = document.getElementById('show-slice-planes');
  if (sp && sp.checked !== e.target.checked) {
    sp.checked = e.target.checked;
    sp.dispatchEvent(new Event('change'));
  }
});

// ==================== HISTOGRAM ====================

function computeHistogram() {
  if (!volume) return;
  const bins = new Float64Array(256);
  const { rows, cols, numSlices } = volumeMeta;

  // Full pass for min/max (typed array, fast)
  let minVal = Infinity, maxVal = -Infinity;
  for (let i = 0, n = volume.length; i < n; i++) {
    const v = volume[i];
    if (v < minVal) minVal = v;
    if (v > maxVal) maxVal = v;
  }
  volumeMeta._histMin = minVal;
  volumeMeta._histMax = maxVal;
  const range = maxVal - minVal || 1;

  // Strided binning for speed (every 2nd voxel each axis = 1/8 sample)
  const scale = 255 / range;
  for (let z = 0; z < numSlices; z += 2) {
    const zBase = z * volStrideZ;
    for (let r = 0; r < rows; r += 2) {
      const rOff = zBase + r * cols;
      for (let c = 0; c < cols; c += 2) {
        let bin = ((volume[rOff + c] - minVal) * scale + 0.5) | 0;
        if (bin < 0) bin = 0; else if (bin > 255) bin = 255;
        bins[bin]++;
      }
    }
  }
  histogramData = bins;
}

function getHistogramRange() {
  const wc = parseFloat(wcSlider.value);
  const ww = parseFloat(wwSlider.value);
  const hMin = Math.min(volumeMeta._histMin || 0, wc - ww / 2);
  const hMax = Math.max(volumeMeta._histMax || 1, wc + ww / 2);
  return { hMin, hMax };
}

function renderHistogram() {
  const canvas = document.getElementById('histogram-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width, h = rect.height;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, w, h);

  if (!histogramData) return;
  const { hMin, hMax } = getHistogramRange();
  const range = hMax - hMin || 1;

  let maxCount = 0;
  for (let i = 1; i < 256; i++) if (histogramData[i] > maxCount) maxCount = histogramData[i];
  if (maxCount === 0) return;

  const wc = parseFloat(wcSlider.value);
  const ww = parseFloat(wwSlider.value);
  const lo = ((wc - ww / 2 - hMin) / range) * w;
  const hi = ((wc + ww / 2 - hMin) / range) * w;
  ctx.fillStyle = 'rgba(233, 69, 96, 0.25)';
  ctx.fillRect(Math.max(0, lo), 0, Math.min(w, hi) - Math.max(0, lo), h);

  const barW = w / 256;
  const logMax = Math.log(maxCount + 1);
  const winLo = wc - ww / 2;
  const winHi = wc + ww / 2;
  const lut = colormaps[currentColormap];
  for (let i = 0; i < 256; i++) {
    const barH = (Math.log(histogramData[i] + 1) / logMax) * h * 0.9;
    const rawIntensity = hMin + (i / 255) * range;
    const windowed = Math.max(0, Math.min(255, ((rawIntensity - winLo) / (winHi - winLo)) * 255));
    const ci = Math.round(windowed);
    const rgb = lut[Math.min(255, Math.max(0, ci))];
    ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
    ctx.fillRect(i * barW, h - barH, Math.max(barW - 0.5, 1), barH);
  }

  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  if (lo >= 0 && lo <= w) { ctx.beginPath(); ctx.moveTo(lo, 0); ctx.lineTo(lo, h); ctx.stroke(); }
  if (hi >= 0 && hi <= w) { ctx.beginPath(); ctx.moveTo(hi, 0); ctx.lineTo(hi, h); ctx.stroke(); }
  ctx.fillStyle = '#fff';
  if (lo >= 0 && lo <= w) { ctx.beginPath(); ctx.moveTo(lo - 5, 0); ctx.lineTo(lo + 5, 0); ctx.lineTo(lo, 8); ctx.fill(); }
  if (hi >= 0 && hi <= w) { ctx.beginPath(); ctx.moveTo(hi - 5, 0); ctx.lineTo(hi + 5, 0); ctx.lineTo(hi, 8); ctx.fill(); }

  if (clickedIntensity !== null) {
    const ix = ((clickedIntensity - hMin) / range) * w;
    if (ix >= 0 && ix <= w) {
      ctx.strokeStyle = 'rgba(0, 200, 255, 0.7)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(ix, 0); ctx.lineTo(ix, h); ctx.stroke();
      ctx.beginPath();
      ctx.arc(ix, h - 6, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#00c8ff'; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = '#00c8ff';
      ctx.font = '9px sans-serif';
      ctx.textAlign = ix < w / 2 ? 'left' : 'right';
      ctx.fillText(Math.round(clickedIntensity), ix + (ix < w / 2 ? 6 : -6), h - 2);
    }
  }
}

// Interactive histogram drag
(function() {
  const hCanvas = document.getElementById('histogram-canvas');
  if (!hCanvas) return;
  let dragMode = null;
  let dragStartX = 0, dragStartWC = 0, dragStartWW = 0;

  function getCSSWidth() { return hCanvas.getBoundingClientRect().width; }

  function xToIntensity(x) {
    const { hMin, hMax } = getHistogramRange();
    return hMin + (x / getCSSWidth()) * (hMax - hMin);
  }

  function getEdgePositions() {
    const { hMin, hMax } = getHistogramRange();
    const range = hMax - hMin || 1;
    const cw = getCSSWidth();
    const wc = parseFloat(wcSlider.value);
    const ww = parseFloat(wwSlider.value);
    const lo = ((wc - ww / 2 - hMin) / range) * cw;
    const hi = ((wc + ww / 2 - hMin) / range) * cw;
    return { lo, hi };
  }

  hCanvas.addEventListener('mousedown', (e) => {
    const rect = hCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const { lo, hi } = getEdgePositions();
    const tolerance = 8;
    if (Math.abs(x - lo) < tolerance) dragMode = 'lo';
    else if (Math.abs(x - hi) < tolerance) dragMode = 'hi';
    else if (x > lo && x < hi) dragMode = 'center';
    else return;
    dragStartX = x;
    dragStartWC = parseFloat(wcSlider.value);
    dragStartWW = parseFloat(wwSlider.value);
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragMode) {
      const rect = hCanvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const { lo, hi } = getEdgePositions();
      if (Math.abs(x - lo) < 8 || Math.abs(x - hi) < 8) hCanvas.style.cursor = 'ew-resize';
      else if (x > lo && x < hi) hCanvas.style.cursor = 'grab';
      else hCanvas.style.cursor = 'default';
      return;
    }
    const rect = hCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const deltaIntensity = xToIntensity(x) - xToIntensity(dragStartX);
    const { hMin, hMax } = getHistogramRange();

    if (dragMode === 'lo') {
      const newLo = Math.max(hMin, (dragStartWC - dragStartWW / 2) + deltaIntensity);
      const hi = dragStartWC + dragStartWW / 2;
      const newWW = Math.max(10, hi - newLo);
      wcSlider.value = Math.round(newLo + newWW / 2);
      wwSlider.value = Math.round(newWW);
    } else if (dragMode === 'hi') {
      const lo = dragStartWC - dragStartWW / 2;
      const newHi = Math.min(hMax, (dragStartWC + dragStartWW / 2) + deltaIntensity);
      const newWW = Math.max(10, newHi - lo);
      wcSlider.value = Math.round(lo + newWW / 2);
      wwSlider.value = Math.round(newWW);
    } else if (dragMode === 'center') {
      wcSlider.value = Math.round(dragStartWC + deltaIntensity);
    }
    document.getElementById('wc-val').textContent = wcSlider.value;
    document.getElementById('ww-val').textContent = wwSlider.value;
    wcSlider.dispatchEvent(new Event('input'));
    renderAll();
    renderHistogram();
  });

  window.addEventListener('mouseup', () => { dragMode = null; });
})();

// ==================== MIP ====================

document.getElementById('mip-checkbox').addEventListener('change', (e) => {
  mipEnabled = e.target.checked;
  document.getElementById('mip-slab').disabled = !mipEnabled;
  renderAll();
});

document.getElementById('mip-slab').addEventListener('input', (e) => {
  mipSlabMm = parseInt(e.target.value);
  document.getElementById('mip-slab-val').textContent = mipSlabMm;
  renderAll();
});

// ==================== EVENT LISTENERS ====================

axialSlider.addEventListener('input', renderAll);
sagittalSlider.addEventListener('input', renderAll);
coronalSlider.addEventListener('input', renderAll);

wcSlider.addEventListener('input', () => {
  document.getElementById('wc-val').textContent = wcSlider.value;
  renderAll();
  renderHistogram();
});
wwSlider.addEventListener('input', () => {
  document.getElementById('ww-val').textContent = wwSlider.value;
  renderAll();
  renderHistogram();
});

document.getElementById('colormap-select').addEventListener('change', (e) => {
  currentColormap = e.target.value;
  renderAll();
  renderHistogram();
});

document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    wcSlider.value = btn.dataset.wc;
    wwSlider.value = btn.dataset.ww;
    document.getElementById('wc-val').textContent = btn.dataset.wc;
    document.getElementById('ww-val').textContent = btn.dataset.ww;
    wcSlider.dispatchEvent(new Event('input'));
  });
});

axialCanvas.addEventListener('wheel', e => { e.preventDefault(); axialSlider.value = Math.max(0, Math.min(axialSlider.max, parseInt(axialSlider.value) + (e.deltaY > 0 ? 1 : -1))); renderAll(); });
sagittalCanvas.addEventListener('wheel', e => { e.preventDefault(); sagittalSlider.value = Math.max(0, Math.min(sagittalSlider.max, parseInt(sagittalSlider.value) + (e.deltaY > 0 ? 1 : -1))); renderAll(); });
coronalCanvas.addEventListener('wheel', e => { e.preventDefault(); coronalSlider.value = Math.max(0, Math.min(coronalSlider.max, parseInt(coronalSlider.value) + (e.deltaY > 0 ? 1 : -1))); renderAll(); });

// --- Screenshot Export ---
document.getElementById('export-png').addEventListener('click', () => {
  const multiplier = parseInt(document.getElementById('export-res').value);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const seriesName = (currentSeries && (currentSeries.seriesDescription || currentSeries.id)) || 'unknown';
  const safeName = seriesName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const panelCanvasMap = {
    'axial-panel': 'axial-canvas',
    'sagittal-panel': 'sagittal-canvas',
    'coronal-panel': 'coronal-canvas',
  };
  if (activePanel === 'volume3d-panel') {
    const dataUrl = window._export3DScreenshot && window._export3DScreenshot(multiplier);
    if (!dataUrl) return alert('3D view not initialized');
    downloadDataUrl(dataUrl, `dicommon-${safeName}-3d-${timestamp}.png`);
  } else {
    const canvasId = panelCanvasMap[activePanel];
    if (!canvasId) return;
    const srcCanvas = document.getElementById(canvasId);
    const w = srcCanvas.width * multiplier;
    const h = srcCanvas.height * multiplier;
    const offscreen = document.createElement('canvas');
    offscreen.width = w;
    offscreen.height = h;
    const ctx = offscreen.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(srcCanvas, 0, 0, w, h);
    const viewName = activePanel.replace('-panel', '');
    downloadDataUrl(offscreen.toDataURL('image/png'), `dicommon-${safeName}-${viewName}-${timestamp}.png`);
  }
});

function downloadDataUrl(dataUrl, filename) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ==================== BOOKMARKS ====================

const BOOKMARK_KEY = 'dicommon-bookmarks';

function getBookmarks() {
  try { return JSON.parse(localStorage.getItem(BOOKMARK_KEY)) || {}; } catch { return {}; }
}
function saveBookmarks(all) { localStorage.setItem(BOOKMARK_KEY, JSON.stringify(all)); }
function getSeriesBookmarks() {
  if (!currentSeries) return [];
  const all = getBookmarks();
  return all[currentSeries.id] || [];
}
function setSeriesBookmarks(list) {
  if (!currentSeries) return;
  const all = getBookmarks();
  all[currentSeries.id] = list;
  saveBookmarks(all);
}

function captureViewState(name) {
  const ep2 = document.querySelector('#quad-view .expanded-panel');
  const is3D = ep2 && ep2.id === 'volume3d-panel';
  const state = {
    name, ts: Date.now(),
    seriesId: currentSeries ? currentSeries.id : null,
    mode: is3D ? '3d' : '2d',
    axial: parseInt(axialSlider.value),
    sagittal: parseInt(sagittalSlider.value),
    coronal: parseInt(coronalSlider.value),
    wc: parseFloat(wcSlider.value),
    ww: parseFloat(wwSlider.value),
    colormap: currentColormap,
    mipEnabled,
    mipSlabMm,
    crosshairsEnabled,
  };
  if (window._get3DState) state.vol3d = window._get3DState();
  return state;
}

function restoreViewState(state) {
  axialSlider.value = state.axial;
  sagittalSlider.value = state.sagittal;
  coronalSlider.value = state.coronal;
  wcSlider.value = state.wc;
  wwSlider.value = state.ww;
  document.getElementById('wc-val').textContent = Math.round(state.wc);
  document.getElementById('ww-val').textContent = Math.round(state.ww);
  currentColormap = state.colormap;
  document.getElementById('colormap-select').value = state.colormap;
  mipEnabled = state.mipEnabled;
  document.getElementById('mip-checkbox').checked = mipEnabled;
  document.getElementById('mip-slab').disabled = !mipEnabled;
  // Backwards-compat: older bookmarks stored mipSlab in voxels
  mipSlabMm = state.mipSlabMm != null ? state.mipSlabMm : (state.mipSlab != null ? state.mipSlab * (volumeMeta.sliceThickness || 1) : 10);
  document.getElementById('mip-slab').value = mipSlabMm;
  document.getElementById('mip-slab-val').textContent = mipSlabMm;
  crosshairsEnabled = state.crosshairsEnabled;
  document.getElementById('crosshair-checkbox').checked = crosshairsEnabled;
  if (window._set3DState) setTimeout(() => window._set3DState(state.vol3d || null), 100);
  wcSlider.dispatchEvent(new Event('input'));
  if (window._rebuild3DColormap) window._rebuild3DColormap();
  renderAll();
  renderHistogram();
}

function renderBookmarkList() {
  const list = getSeriesBookmarks();
  const el = document.getElementById('bookmark-list');
  el.innerHTML = list.map((bk, i) =>
    `<div class="bookmark-chip" data-idx="${i}">
      <span class="bk-name" title="${bk.name}">${bk.mode === '3d' ? '🧊' : '🔲'} ${bk.name}</span>
      <button class="bk-delete" data-idx="${i}" title="Delete">×</button>
    </div>`
  ).join('');
  el.querySelectorAll('.bookmark-chip').forEach(chip => {
    chip.addEventListener('click', (e) => {
      if (e.target.classList.contains('bk-delete')) return;
      const idx = parseInt(chip.dataset.idx);
      restoreViewState(list[idx]);
    });
  });
  el.querySelectorAll('.bk-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx);
      list.splice(idx, 1);
      setSeriesBookmarks(list);
      renderBookmarkList();
    });
  });
}

document.getElementById('save-bookmark-btn').addEventListener('click', () => {
  if (!currentSeries || !volume) return;
  const modal = document.getElementById('bookmark-modal');
  const input = document.getElementById('bookmark-name-input');
  modal.classList.add('visible');
  input.value = '';
  input.focus();
});
document.getElementById('bookmark-cancel').addEventListener('click', () => {
  document.getElementById('bookmark-modal').classList.remove('visible');
});
document.getElementById('bookmark-save').addEventListener('click', () => {
  const input = document.getElementById('bookmark-name-input');
  const name = input.value.trim() || `View ${getSeriesBookmarks().length + 1}`;
  const state = captureViewState(name);
  const list = getSeriesBookmarks();
  list.push(state);
  setSeriesBookmarks(list);
  renderBookmarkList();
  document.getElementById('bookmark-modal').classList.remove('visible');
});
document.getElementById('bookmark-name-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('bookmark-save').click();
  if (e.key === 'Escape') document.getElementById('bookmark-cancel').click();
});

// --- Layout Selector ---
document.querySelectorAll('.layout-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.layout-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const quadView = document.getElementById('quad-view');
    const layout = btn.dataset.layout;
    quadView.classList.remove('layout-3plus1', 'layout-ax3d', 'expanded');
    quadView.style.gridTemplateColumns = '';
    quadView.style.gridTemplateRows = '';
    document.querySelectorAll('#quad-view .view-panel').forEach(p => p.classList.remove('expanded-panel'));
    if (layout === '3plus1') quadView.classList.add('layout-3plus1');
    else if (layout === 'ax3d') quadView.classList.add('layout-ax3d');
    if (window._resize3D) setTimeout(window._resize3D, 50);
  });
});

// --- Draggable View Dividers ---
(function() {
  const quadView = document.getElementById('quad-view');
  const divV = document.getElementById('view-divider');
  const divH = document.getElementById('view-divider-h');
  const divV2 = document.getElementById('view-divider-v2');
  let activeDivider = null;
  let splitV = 50, splitH = 66, splitV2 = 33;

  function startDrag(el, type, e) {
    activeDivider = el;
    el.classList.add('dragging');
    document.body.style.cursor = type === 'col' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  }
  divV.addEventListener('mousedown', (e) => startDrag(divV, 'col', e));
  divH.addEventListener('mousedown', (e) => startDrag(divH, 'row', e));
  divV2.addEventListener('mousedown', (e) => startDrag(divV2, 'col', e));

  window.addEventListener('mousemove', (e) => {
    if (!activeDivider) return;
    const rect = quadView.getBoundingClientRect();
    const is3plus1 = quadView.classList.contains('layout-3plus1');
    const isAx3d = quadView.classList.contains('layout-ax3d');
    if (isAx3d && activeDivider === divV) {
      const pct = Math.max(15, Math.min(85, ((e.clientX - rect.left) / rect.width) * 100));
      quadView.style.gridTemplateColumns = `${pct}% 4px 1fr`;
      if (window._resize3D) window._resize3D();
    }
    if (is3plus1) {
      if (activeDivider === divV) {
        splitV = Math.max(20, Math.min(80, ((e.clientX - rect.left) / rect.width) * 100));
        apply3plus1Grid();
      } else if (activeDivider === divH) {
        splitH = Math.max(20, Math.min(85, ((e.clientY - rect.top) / rect.height) * 100));
        apply3plus1Grid();
      } else if (activeDivider === divV2) {
        const leftPx = (splitV / 100) * rect.width;
        const relX = e.clientX - rect.left;
        splitV2 = Math.max(15, Math.min(85, (relX / leftPx) * 100));
        apply3plus1Grid();
      }
      if (window._resize3D) window._resize3D();
    }
  });
  function apply3plus1Grid() {
    const leftFr = splitV;
    const rightFr = 100 - splitV;
    const sagPct = splitV2;
    const corPct = 100 - splitV2;
    quadView.style.gridTemplateColumns = `${sagPct * leftFr / 100}fr 4px ${corPct * leftFr / 100}fr 4px ${rightFr}fr`;
    quadView.style.gridTemplateRows = `${splitH}fr 4px ${100 - splitH}fr`;
  }
  window.addEventListener('mouseup', () => {
    if (!activeDivider) return;
    activeDivider.classList.remove('dragging');
    activeDivider = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
})();

// --- Collapsible Metadata ---
document.getElementById('metadata-toggle').addEventListener('click', function() {
  const content = document.getElementById('metadata-content');
  this.classList.toggle('collapsed');
  content.style.display = this.classList.contains('collapsed') ? 'none' : 'block';
});

// --- Active Panel Selection ---
let activePanel = 'axial-panel';
document.querySelectorAll('#quad-view .view-panel').forEach(panel => {
  panel.addEventListener('mousedown', () => {
    document.querySelectorAll('#quad-view .view-panel').forEach(p => p.classList.remove('active-panel'));
    panel.classList.add('active-panel');
    activePanel = panel.id;
  });
});
document.getElementById('axial-panel').classList.add('active-panel');

// --- Quad View Expand/Collapse ---
document.querySelectorAll('.expand-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const quadView = document.getElementById('quad-view');
    const panelId = btn.dataset.panel;
    const panel = document.getElementById(panelId);
    const crosshair3dToggle = document.querySelector('.crosshair-3d-toggle');
    if (quadView.classList.contains('expanded')) {
      quadView.classList.remove('expanded');
      document.querySelectorAll('#quad-view .view-panel').forEach(p => p.classList.remove('expanded-panel'));
      document.querySelectorAll('.expand-btn').forEach(b => b.textContent = '⛶');
      if (crosshair3dToggle) crosshair3dToggle.style.display = 'none';
      if (window._resize3D) setTimeout(window._resize3D, 50);
    } else {
      quadView.classList.add('expanded');
      panel.classList.add('expanded-panel');
      btn.textContent = '⛶';
      if (crosshair3dToggle) crosshair3dToggle.style.display = (panelId === 'volume3d-panel') ? '' : 'none';
      if (window._resize3D) setTimeout(window._resize3D, 50);
    }
  });
});

// ==================== OVERLAY CONTROLS ====================
// ==================== TIMEPOINT (4D) ====================
let _timepointReloadTimer = null;
document.getElementById('timepoint-slider').addEventListener('input', (e) => {
  const t = parseInt(e.target.value);
  const nt = (currentSeries && currentSeries.numTimepoints) || 1;
  document.getElementById('timepoint-val').textContent = `${t + 1}/${nt}`;
  currentTimepoint = t;
  // Debounce: rebuild volume only after the scrub settles
  if (_timepointReloadTimer) clearTimeout(_timepointReloadTimer);
  _timepointReloadTimer = setTimeout(() => {
    if (currentSeries) loadVolume(currentSeries.id);
  }, 120);
});

document.getElementById('overlay-select').addEventListener('change', (e) => {
  loadOverlay(e.target.value || null);
});
document.getElementById('overlay-clear').addEventListener('click', clearOverlay);
document.getElementById('overlay-opacity').addEventListener('input', (e) => {
  overlay.opacity = parseFloat(e.target.value);
  document.getElementById('overlay-opacity-val').textContent = overlay.opacity.toFixed(2);
  renderAll();
});
document.getElementById('overlay-colormap').addEventListener('change', (e) => {
  overlay.colormap = e.target.value;
  renderAll();
});
document.getElementById('overlay-wc').addEventListener('input', (e) => {
  overlay.wc = parseFloat(e.target.value);
  document.getElementById('overlay-wc-val').textContent = Math.round(overlay.wc);
  renderAll();
});
document.getElementById('overlay-ww').addEventListener('input', (e) => {
  overlay.ww = parseFloat(e.target.value);
  document.getElementById('overlay-ww-val').textContent = Math.round(overlay.ww);
  renderAll();
});

// Expose for volume3d.js
window._volume = () => volume;
window._volStrides = () => ({ z: volStrideZ, y: volStrideY });

init();
