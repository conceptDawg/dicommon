const express = require('express');
const path = require('path');
const fs = require('fs');
const dicomParser = require('dicom-parser');

const app = express();
const PORT = 3080;
const DATA_ROOT = path.join(__dirname, '1000022B', '1000022C');

app.use(express.static(path.join(__dirname, 'public')));

// API: list series with metadata
app.get('/api/series', (req, res) => {
  const series = [];
  const seriesDirs = fs.readdirSync(DATA_ROOT).filter(d =>
    fs.statSync(path.join(DATA_ROOT, d)).isDirectory()
  );

  for (const dir of seriesDirs) {
    const dirPath = path.join(DATA_ROOT, dir);
    const files = fs.readdirSync(dirPath).filter(f => !f.startsWith('.'));

    // Read first file for metadata
    let metadata = {};
    if (files.length > 0) {
      try {
        const buf = fs.readFileSync(path.join(dirPath, files[0]));
        const ds = dicomParser.parseDicom(new Uint8Array(buf));
        metadata = {
          patientName: ds.string('x00100010') || 'Unknown',
          patientId: ds.string('x00100020') || '',
          studyDescription: ds.string('x00081030') || '',
          seriesDescription: ds.string('x0008103e') || 'Series ' + dir,
          modality: ds.string('x00080060') || '',
          sliceThickness: ds.string('x00180050') || '',
          rows: ds.uint16('x00280010'),
          columns: ds.uint16('x00280011'),
          seriesNumber: ds.string('x00200011') || '',
          imageOrientationPatient: ds.string('x00200037') || '',
        };
      } catch (e) {
        metadata = { seriesDescription: 'Series ' + dir, error: e.message };
      }
    }

    series.push({
      id: dir,
      fileCount: files.length,
      files: files.sort(),
      ...metadata,
    });
  }

  res.json(series);
});

// API: serve a DICOM file as raw bytes
app.get('/api/dicom/:series/:file', (req, res) => {
  const filePath = path.join(DATA_ROOT, req.params.series, req.params.file);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.set('Content-Type', 'application/dicom');
  res.set('Access-Control-Allow-Origin', '*');
  res.sendFile(filePath);
});

// API: get parsed pixel data + metadata for a single DICOM file
app.get('/api/parsed/:series/:file', (req, res) => {
  const filePath = path.join(DATA_ROOT, req.params.series, req.params.file);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');

  try {
    const buf = fs.readFileSync(filePath);
    const ds = dicomParser.parseDicom(new Uint8Array(buf));

    const rows = ds.uint16('x00280010');
    const cols = ds.uint16('x00280011');
    const bitsAllocated = ds.uint16('x00280100');
    const bitsStored = ds.uint16('x00280101');
    const pixelRepresentation = ds.uint16('x00280103');
    const rescaleIntercept = parseFloat(ds.string('x00281052') || '0');
    const rescaleSlope = parseFloat(ds.string('x00281053') || '1');
    const windowCenter = parseFloat(ds.string('x00281050') || '127');
    const windowWidth = parseFloat(ds.string('x00281051') || '256');
    const imagePosition = ds.string('x00200032') || '';
    const imageOrientation = ds.string('x00200037') || '';
    const sliceLocation = parseFloat(ds.string('x00201041') || '0');
    const instanceNumber = parseInt(ds.string('x00200013') || '0');
    const pixelSpacing = ds.string('x00280030') || '';
    const sliceThickness = parseFloat(ds.string('x00180050') || '0');

    const pixelDataElement = ds.elements.x7fe00010;
    let pixelData = null;
    if (pixelDataElement) {
      if (bitsAllocated === 16) {
        if (pixelRepresentation === 1) {
          pixelData = new Int16Array(buf.buffer, buf.byteOffset + pixelDataElement.dataOffset, pixelDataElement.length / 2);
        } else {
          pixelData = new Uint16Array(buf.buffer, buf.byteOffset + pixelDataElement.dataOffset, pixelDataElement.length / 2);
        }
      } else {
        pixelData = new Uint8Array(buf.buffer, buf.byteOffset + pixelDataElement.dataOffset, pixelDataElement.length);
      }
    }

    // Convert to regular array for JSON
    const pixels = pixelData ? Array.from(pixelData) : [];

    res.json({
      rows, cols, bitsAllocated, bitsStored, pixelRepresentation,
      rescaleIntercept, rescaleSlope, windowCenter, windowWidth,
      imagePosition, imageOrientation, sliceLocation, instanceNumber,
      pixelSpacing, sliceThickness, pixels,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: get all slice metadata for a series (for sorting/positioning)
app.get('/api/series/:id/slices', (req, res) => {
  const dirPath = path.join(DATA_ROOT, req.params.id);
  if (!fs.existsSync(dirPath)) return res.status(404).send('Not found');

  const files = fs.readdirSync(dirPath).filter(f => !f.startsWith('.'));
  const slices = [];

  for (const file of files) {
    try {
      const buf = fs.readFileSync(path.join(dirPath, file));
      const ds = dicomParser.parseDicom(new Uint8Array(buf));
      slices.push({
        file,
        instanceNumber: parseInt(ds.string('x00200013') || '0'),
        sliceLocation: parseFloat(ds.string('x00201041') || '0'),
        imagePosition: ds.string('x00200032') || '',
      });
    } catch (e) {
      slices.push({ file, error: e.message });
    }
  }

  slices.sort((a, b) => (a.instanceNumber || 0) - (b.instanceNumber || 0));
  res.json(slices);
});

app.listen(PORT, () => {
  console.log(`MRI Viewer running at http://localhost:${PORT}`);
});
