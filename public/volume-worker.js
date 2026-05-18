// Web Worker for volume texture rebuild (off main thread).
// Receives a flat Float32Array buffer + dims; produces an upsampled, windowed Uint8 3D texture.
self.onmessage = function(e) {
  const { volumeBuf, cols, rows, numSlices, upsampledNumSlices, upsampleFactor, wc, ww } = e.data;
  const volume = new Float32Array(volumeBuf);
  const lower = wc - ww / 2;
  const planeSize = rows * cols;
  const texData = new Uint8Array(cols * rows * upsampledNumSlices);

  for (let uz = 0; uz < upsampledNumSlices; uz++) {
    const origPos = uz / upsampleFactor;
    const s0 = Math.floor(origPos);
    const s1 = Math.min(s0 + 1, numSlices - 1);
    const frac = origPos - s0;
    const oneMinusFrac = 1 - frac;
    const base0 = s0 * planeSize;
    const base1 = s1 * planeSize;
    const dstBase = uz * planeSize;
    for (let i = 0; i < planeSize; i++) {
      const val = volume[base0 + i] * oneMinusFrac + volume[base1 + i] * frac;
      let n = ((val - lower) / ww) * 255;
      if (n < 0) n = 0; else if (n > 255) n = 255;
      texData[dstBase + i] = n;
    }
  }

  self.postMessage({ texData }, [texData.buffer]);
};
