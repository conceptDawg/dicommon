const express = require('express');
const path = require('path');
const fsp = require('fs').promises;
const fs = require('fs');
const dicomParser = require('dicom-parser');

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3080;
const DEBUG = !!process.env.DEBUG;

// DATA_ROOT precedence: env var > auto-detected DICOMDIR subdir > fallback
function resolveDataRoot() {
  if (process.env.DICOM_ROOT) return path.resolve(process.env.DICOM_ROOT);
  // Look for a directory containing DICOMDIR or a nested subdir with .dcm files
  try {
    const entries = fs.readdirSync(__dirname, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(__dirname, e.name);
      // Common pattern: __dirname/DIR/SUBDIR/series
      const sub = fs.readdirSync(dir, { withFileTypes: true }).find(s => s.isDirectory());
      if (sub) {
        const candidate = path.join(dir, sub.name);
        const hasSeries = fs.readdirSync(candidate, { withFileTypes: true })
          .some(c => c.isDirectory());
        if (hasSeries) return candidate;
      }
    }
  } catch (_) { /* fall through */ }
  return path.join(__dirname, '1000022B', '1000022C');
}

const DATA_ROOT = resolveDataRoot();
console.log('Starting MRI server. DATA_ROOT =', DATA_ROOT);

// Log-and-continue: never crash the server on a stray error.
process.on('uncaughtException', (err) => console.error('uncaughtException:', err));
process.on('unhandledRejection', (reason) => console.error('unhandledRejection:', reason));
process.on('SIGTERM', () => { console.log('SIGTERM'); process.exit(0); });
process.on('SIGINT',  () => { console.log('SIGINT');  process.exit(0); });

app.use(express.static(path.join(__dirname, 'public')));

if (DEBUG) {
  app.use((req, _res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
  });
}

// --- Path-traversal-safe resolver ---
const ROOT_PREFIX = DATA_ROOT + path.sep;
function safeJoin(...parts) {
  const resolved = path.resolve(DATA_ROOT, ...parts);
  if (resolved !== DATA_ROOT && !resolved.startsWith(ROOT_PREFIX)) return null;
  return resolved;
}

// --- In-memory series listing cache (data is read-only at runtime) ---
let seriesCache = null;

async function buildSeriesCache() {
  const entries = await fsp.readdir(DATA_ROOT, { withFileTypes: true });
  const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);

  const series = await Promise.all(dirs.map(async (dir) => {
    const dirPath = safeJoin(dir);
    if (!dirPath) return null;
    let files;
    try {
      files = (await fsp.readdir(dirPath)).filter(f => !f.startsWith('.')).sort();
    } catch (e) {
      return { id: dir, fileCount: 0, files: [], error: 'unreadable' };
    }

    let metadata = {};
    if (files.length > 0) {
      try {
        const buf = await fsp.readFile(path.join(dirPath, files[0]));
        const ds = dicomParser.parseDicom(new Uint8Array(buf));
        const m = extractMeta(ds);
        metadata = {
          patientName: ds.string('x00100010') || 'Unknown',
          patientId: ds.string('x00100020') || '',
          studyDescription: ds.string('x00081030') || '',
          seriesDescription: ds.string('x0008103e') || 'Series ' + dir,
          modality: ds.string('x00080060') || '',
          sliceThickness: ds.string('x00180050') || '',
          rows: m.rows,
          columns: m.cols,
          seriesNumber: ds.string('x00200011') || '',
          imageOrientationPatient: ds.string('x00200037') || '',
          displayable: m.displayable,
          browserJpeg: m.browserJpeg,
          transferSyntax: m.transferSyntax,
          samplesPerPixel: m.samplesPerPixel,
          photometric: m.photometric,
          encapsulated: m.encapsulated,
        };
      } catch (_) {
        metadata = { seriesDescription: 'Series ' + dir, displayable: false };
      }
    }
    return { id: dir, fileCount: files.length, files, ...metadata };
  }));

  return series.filter(Boolean);
}

app.get('/api/series', async (_req, res) => {
  try {
    if (!seriesCache) seriesCache = await buildSeriesCache();
    res.json(seriesCache);
  } catch (e) {
    console.error('GET /api/series failed:', e);
    res.status(500).json({ error: 'internal' });
  }
});

// Raw DICOM bytes
app.get('/api/dicom/:series/:file', async (req, res) => {
  const filePath = safeJoin(req.params.series, req.params.file);
  if (!filePath) return res.status(400).send('Bad path');
  try {
    await fsp.access(filePath);
  } catch { return res.status(404).send('Not found'); }
  res.set('Content-Type', 'application/dicom');
  res.sendFile(filePath);
});

// Sorted slice metadata for a series — uses cached file list, parses metadata in parallel
app.get('/api/series/:id/slices', async (req, res) => {
  const dirPath = safeJoin(req.params.id);
  if (!dirPath) return res.status(400).send('Bad path');
  try { await fsp.access(dirPath); } catch { return res.status(404).send('Not found'); }

  try {
    const files = (await fsp.readdir(dirPath)).filter(f => !f.startsWith('.'));
    const slices = await Promise.all(files.map(async (file) => {
      try {
        const buf = await fsp.readFile(path.join(dirPath, file));
        const ds = dicomParser.parseDicom(new Uint8Array(buf));
        return {
          file,
          instanceNumber: parseInt(ds.string('x00200013') || '0'),
          sliceLocation: parseFloat(ds.string('x00201041') || '0'),
          imagePosition: ds.string('x00200032') || '',
        };
      } catch (_) {
        return { file, instanceNumber: 0 };
      }
    }));
    slices.sort((a, b) => (a.instanceNumber || 0) - (b.instanceNumber || 0));
    res.json(slices);
  } catch (e) {
    console.error('slices error:', e);
    res.status(500).json({ error: 'internal' });
  }
});

// Parsed slice metadata as JSON, pixel data NOT included (use /pixels for binary).
app.get('/api/meta/:series/:file', async (req, res) => {
  const filePath = safeJoin(req.params.series, req.params.file);
  if (!filePath) return res.status(400).send('Bad path');
  try {
    const buf = await fsp.readFile(filePath);
    const ds = dicomParser.parseDicom(new Uint8Array(buf));
    res.json(extractMeta(ds));
  } catch (e) {
    if (DEBUG) console.error('meta error:', e);
    res.status(500).json({ error: 'parse failed' });
  }
});

// Binary pixel data + meta in a header.
// Body is the raw typed-array bytes (Int16 / Uint16 / Uint8 depending on bitsAllocated+pixelRep).
app.get('/api/pixels/:series/:file', async (req, res) => {
  const filePath = safeJoin(req.params.series, req.params.file);
  if (!filePath) return res.status(400).send('Bad path');
  try {
    const buf = await fsp.readFile(filePath);
    const ds = dicomParser.parseDicom(new Uint8Array(buf));
    const meta = extractMeta(ds);
    const pixelDataElement = ds.elements.x7fe00010;
    if (!pixelDataElement) {
      meta.pixelType = 'none';
      res.set('X-DICOM-Meta', JSON.stringify(meta));
      res.set('Content-Type', 'application/octet-stream');
      return res.end();
    }

    let view;
    if (meta.bitsAllocated === 16) {
      view = meta.pixelRepresentation === 1
        ? new Int16Array(buf.buffer, buf.byteOffset + pixelDataElement.dataOffset, pixelDataElement.length / 2)
        : new Uint16Array(buf.buffer, buf.byteOffset + pixelDataElement.dataOffset, pixelDataElement.length / 2);
      meta.pixelType = meta.pixelRepresentation === 1 ? 'int16' : 'uint16';
    } else {
      view = new Uint8Array(buf.buffer, buf.byteOffset + pixelDataElement.dataOffset, pixelDataElement.length);
      meta.pixelType = 'uint8';
    }

    res.set('X-DICOM-Meta', encodeURIComponent(JSON.stringify(meta)));
    res.set('Access-Control-Expose-Headers', 'X-DICOM-Meta');
    res.set('Content-Type', 'application/octet-stream');
    res.set('Cache-Control', 'public, max-age=3600');
    // Send only the view's bytes
    res.end(Buffer.from(view.buffer, view.byteOffset, view.byteLength));
  } catch (e) {
    if (DEBUG) console.error('pixels error:', e);
    res.status(500).send('parse failed');
  }
});

// Uncompressed grayscale transfer syntaxes we can read directly.
const NATIVE_TS = new Set([
  '1.2.840.10008.1.2',         // Implicit VR Little Endian
  '1.2.840.10008.1.2.1',       // Explicit VR Little Endian
  '1.2.840.10008.1.2.1.99',    // Deflated Explicit VR
  '1.2.840.10008.1.2.2',       // Explicit VR Big Endian (rare)
]);

// Encapsulated transfer syntaxes whose fragments are a valid JPEG bitstream
// the browser's built-in <img> can decode.
const BROWSER_JPEG_TS = new Set([
  '1.2.840.10008.1.2.4.50',    // JPEG Baseline (Process 1)
  '1.2.840.10008.1.2.4.51',    // JPEG Extended (Process 2 & 4)
]);

function extractMeta(ds) {
  const transferSyntax = ds.string('x00020010') || '';
  const samplesPerPixel = ds.uint16('x00280002') || 1;
  const photometric = ds.string('x00280004') || '';
  const px = ds.elements.x7fe00010;
  const encapsulated = !!(px && px.encapsulatedPixelData);
  const displayable = !encapsulated
    && samplesPerPixel === 1
    && (NATIVE_TS.has(transferSyntax) || transferSyntax === '')
    && /MONOCHROME/i.test(photometric || 'MONOCHROME2');
  const browserJpeg = encapsulated && BROWSER_JPEG_TS.has(transferSyntax);
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
    transferSyntax,
    samplesPerPixel,
    photometric,
    encapsulated,
    displayable,
    browserJpeg,
  };
}

// Stream a baseline-JPEG-encoded DICOM as image/jpeg by concatenating its fragments.
app.get('/api/jpeg/:series/:file', async (req, res) => {
  const filePath = safeJoin(req.params.series, req.params.file);
  if (!filePath) return res.status(400).send('Bad path');
  try {
    const buf = await fsp.readFile(filePath);
    const ds = dicomParser.parseDicom(new Uint8Array(buf));
    const transferSyntax = ds.string('x00020010') || '';
    if (!BROWSER_JPEG_TS.has(transferSyntax)) return res.status(415).send('Not browser-decodable JPEG');
    const px = ds.elements.x7fe00010;
    if (!px || !px.fragments || px.fragments.length === 0) return res.status(404).send('No pixel data');

    // Concatenate all fragments. For single-frame baseline JPEG this is the complete bitstream.
    let total = 0;
    for (const f of px.fragments) total += f.length;
    const out = Buffer.allocUnsafe(total);
    let off = 0;
    for (const f of px.fragments) {
      buf.copy(out, off, f.position, f.position + f.length);
      off += f.length;
    }
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=3600');
    res.end(out);
  } catch (e) {
    if (DEBUG) console.error('jpeg error:', e);
    res.status(500).send('parse failed');
  }
});

const server = app.listen(PORT, () => {
  console.log(`MRI Viewer running at http://localhost:${PORT}`);
});

server.on('error', (err) => console.error('Server error:', err));

if (DEBUG) {
  setInterval(() => {
    console.log(`[${new Date().toISOString()}] memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`);
  }, 30000);
}
