// 3D Volume Renderer using Three.js raycasting
(function() {
  let renderer, scene, camera, mesh;
  let volumeTexture, colormapTexture;
  let isInitialized = false;
  let animFrameId = null;

  const container = document.getElementById('volume3d-container');
  const canvas3d = document.getElementById('volume3d-canvas');
  const thresholdSlider = document.getElementById('vol-threshold');
  const opacitySlider = document.getElementById('vol-opacity');
  const stepsSlider = document.getElementById('vol-steps');

  // Toggle 2D/3D views
  document.getElementById('btn-2d').addEventListener('click', () => {
    document.getElementById('btn-2d').classList.add('active');
    document.getElementById('btn-3d').classList.remove('active');
    document.querySelector('.view-row').style.display = 'flex';
    container.classList.add('hidden');
    stopRender();
  });

  document.getElementById('btn-3d').addEventListener('click', () => {
    document.getElementById('btn-3d').classList.add('active');
    document.getElementById('btn-2d').classList.remove('active');
    document.querySelector('.view-row').style.display = 'none';
    container.classList.remove('hidden');
    if (!isInitialized && volume) {
      initVolume3D();
    } else if (isInitialized) {
      resize();
      startRender();
    }
  });

  // Vertex shader (GLSL3)
  // Transform ray origin and direction into the volume's local (object) space
  // so the raycaster works correctly when the mesh is rotated
  const vertexShader = `
    out vec3 vOrigin;
    out vec3 vDirection;

    uniform mat4 volumeInverseModel;

    void main() {
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      // Transform camera position into object space
      vOrigin = (volumeInverseModel * vec4(cameraPosition, 1.0)).xyz;
      // Direction in object space
      vDirection = position - vOrigin;
      gl_Position = projectionMatrix * mvPosition;
    }
  `;

  // Fragment shader - raycasting through 3D texture (GLSL3)
  const fragmentShader = `
    precision highp float;
    precision highp sampler3D;

    in vec3 vOrigin;
    in vec3 vDirection;

    out vec4 fragColor;

    uniform sampler3D volumeTex;
    uniform sampler2D colormapTex;
    uniform float threshold;
    uniform float opacityScale;
    uniform int numSteps;
    uniform vec3 volumeSize;
    uniform vec3 clipMin;
    uniform vec3 clipMax;

    vec2 intersectBox(vec3 orig, vec3 dir) {
      vec3 boxMin = vec3(-0.5) * volumeSize;
      vec3 boxMax = vec3(0.5) * volumeSize;
      vec3 invDir = 1.0 / dir;
      vec3 t0 = (boxMin - orig) * invDir;
      vec3 t1 = (boxMax - orig) * invDir;
      vec3 tmin = min(t0, t1);
      vec3 tmax = max(t0, t1);
      float tNear = max(max(tmin.x, tmin.y), tmin.z);
      float tFar = min(min(tmax.x, tmax.y), tmax.z);
      return vec2(tNear, tFar);
    }

    void main() {
      vec3 rayDir = normalize(vDirection);
      vec2 t = intersectBox(vOrigin, rayDir);

      if (t.x > t.y) discard;
      t.x = max(t.x, 0.0);

      float stepSize = (t.y - t.x) / float(numSteps);
      vec4 accum = vec4(0.0);
      vec3 pos = vOrigin + rayDir * t.x;
      vec3 step = rayDir * stepSize;

      for (int i = 0; i < 512; i++) {
        if (i >= numSteps) break;

        vec3 texCoord = pos / volumeSize + 0.5;

        if (texCoord.x < clipMin.x || texCoord.x > clipMax.x ||
            texCoord.y < clipMin.y || texCoord.y > clipMax.y ||
            texCoord.z < clipMin.z || texCoord.z > clipMax.z) {
          pos += step;
          continue;
        }

        float intensity = texture(volumeTex, texCoord).r;

        if (intensity > threshold) {
          vec3 color = texture(colormapTex, vec2(intensity, 0.5)).rgb;
          float alpha = (intensity - threshold) / (1.0 - threshold + 0.001);
          alpha = clamp(alpha * alpha * opacityScale * stepSize * 10.0, 0.0, 1.0);

          accum.rgb += (1.0 - accum.a) * alpha * color;
          accum.a += (1.0 - accum.a) * alpha;

          if (accum.a > 0.95) break;
        }

        pos += step;
      }

      fragColor = vec4(accum.rgb, accum.a);
    }
  `;

  function buildColormapTexture() {
    const data = new Uint8Array(256 * 4);
    const lut = colormaps[currentColormap];
    for (let i = 0; i < 256; i++) {
      data[i * 4] = lut[i][0];
      data[i * 4 + 1] = lut[i][1];
      data[i * 4 + 2] = lut[i][2];
      data[i * 4 + 3] = 255;
    }

    if (colormapTexture) {
      colormapTexture.image.data = data;
      colormapTexture.needsUpdate = true;
    } else {
      colormapTexture = new THREE.DataTexture(data, 256, 1, THREE.RGBAFormat);
      colormapTexture.minFilter = THREE.LinearFilter;
      colormapTexture.magFilter = THREE.LinearFilter;
      colormapTexture.needsUpdate = true;
    }
    return colormapTexture;
  }

  function initVolume3D() {
    if (!volume || !volumeMeta.rows) return;

    const { rows, cols, numSlices, pixelSpacing, sliceThickness, windowCenter, windowWidth } = volumeMeta;

    // Create renderer, scene, camera only once
    if (!renderer) {
      renderer = new THREE.WebGLRenderer({ canvas: canvas3d, alpha: true, antialias: true });
      renderer.setPixelRatio(window.devicePixelRatio);
      scene = new THREE.Scene();
      scene.background = new THREE.Color(0x000000);
      camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
      camera.position.set(0, 0, 2.5);
      setupControls();
    }

    // Build 3D texture from volume data
    rebuildVolumeTexture();

    function rebuildVolumeTexture() {
      const wc = parseInt(document.getElementById('wc-slider').value);
      const ww = parseInt(document.getElementById('ww-slider').value);
      const lower = wc - ww / 2;

      const texData = new Uint8Array(cols * rows * numSlices);
      for (let z = 0; z < numSlices; z++) {
        for (let y = 0; y < rows; y++) {
          for (let x = 0; x < cols; x++) {
            const val = volume[z][y][x];
            const norm = Math.max(0, Math.min(255, ((val - lower) / ww) * 255));
            texData[z * rows * cols + y * cols + x] = norm;
          }
        }
      }

      if (volumeTexture) {
        volumeTexture.image.data = texData;
        volumeTexture.needsUpdate = true;
      } else {
        volumeTexture = new THREE.Data3DTexture(texData, cols, rows, numSlices);
        volumeTexture.format = THREE.RedFormat;
        volumeTexture.type = THREE.UnsignedByteType;
        volumeTexture.minFilter = THREE.LinearFilter;
        volumeTexture.magFilter = THREE.LinearFilter;
        volumeTexture.unpackAlignment = 1;
        volumeTexture.needsUpdate = true;
      }
    }

    // Listen for window/level changes to update 3D texture
    document.getElementById('wc-slider').addEventListener('input', rebuildVolumeTexture);
    document.getElementById('ww-slider').addEventListener('input', rebuildVolumeTexture);
    // Also catch preset button clicks
    document.querySelectorAll('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => setTimeout(rebuildVolumeTexture, 10));
    });

    buildColormapTexture();

    // Compute volume physical size ratio
    // X = cols * pixelSpacing, Y = rows * pixelSpacing, Z = numSlices * sliceThickness
    const sizeX = cols * pixelSpacing;
    const sizeY = rows * pixelSpacing;
    const sizeZ = numSlices * sliceThickness;
    const maxDim = Math.max(sizeX, sizeY, sizeZ);
    const volSize = new THREE.Vector3(sizeX / maxDim, sizeY / maxDim, sizeZ / maxDim);

    // Create box geometry matching volume proportions
    const geometry = new THREE.BoxGeometry(volSize.x, volSize.y, volSize.z);

    const material = new THREE.ShaderMaterial({
      uniforms: {
        volumeTex: { value: volumeTexture },
        colormapTex: { value: colormapTexture },
        threshold: { value: parseFloat(thresholdSlider.value) },
        opacityScale: { value: parseFloat(opacitySlider.value) },
        numSteps: { value: parseInt(stepsSlider.value) },
        volumeSize: { value: volSize },
        clipMin: { value: new THREE.Vector3(0, 0, 0) },
        clipMax: { value: new THREE.Vector3(1, 1, 1) },
        volumeInverseModel: { value: new THREE.Matrix4() },
      },
      vertexShader,
      fragmentShader,
      side: THREE.BackSide,
      transparent: true,
      glslVersion: THREE.GLSL3,
    });

    mesh = new THREE.Mesh(geometry, material);
    mesh.scale.y = -1; // Flip upside down — DICOM data loads inverted
    scene.add(mesh);

    // Faint bounding cube wireframe
    const wireGeo = new THREE.EdgesGeometry(geometry);
    const wireMat = new THREE.LineBasicMaterial({ color: 0x666666, transparent: true, opacity: 0.5, linewidth: 2 });
    const wireframe = new THREE.LineSegments(wireGeo, wireMat);
    mesh.add(wireframe); // child of mesh so it rotates with it

    isInitialized = true;
    resize();
    startRender();
  }

  function setupControls() {
    let isDragging = false;
    let isPanning = false;
    let prevX, prevY;

    canvas3d.addEventListener('mousedown', e => {
      if (e.button === 2) { isPanning = true; }
      else { isDragging = true; }
      prevX = e.clientX;
      prevY = e.clientY;
      e.preventDefault();
    });

    canvas3d.addEventListener('contextmenu', e => e.preventDefault());

    window.addEventListener('mousemove', e => {
      if (!isDragging && !isPanning) return;
      const dx = e.clientX - prevX;
      const dy = e.clientY - prevY;
      prevX = e.clientX;
      prevY = e.clientY;

      if (isPanning) {
        camera.position.x -= dx * 0.005;
        camera.position.y += dy * 0.005;
      } else {
        // Rotate mesh
        mesh.rotation.y += dx * 0.01;
        mesh.rotation.x += dy * 0.01;
      }
    });

    window.addEventListener('mouseup', () => {
      isDragging = false;
      isPanning = false;
    });

    canvas3d.addEventListener('wheel', e => {
      e.preventDefault();
      camera.position.z = Math.max(0.5, Math.min(10, camera.position.z + e.deltaY * 0.003));
    });
  }

  function resize() {
    if (!renderer) return;
    const w = container.clientWidth;
    const h = container.clientHeight - 40; // leave room for controls
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function startRender() {
    if (animFrameId) return;
    function loop() {
      animFrameId = requestAnimationFrame(loop);
      // Update inverse model matrix so raycasting works in object space
      if (mesh) {
        mesh.updateMatrixWorld();
        mesh.material.uniforms.volumeInverseModel.value.copy(mesh.matrixWorld).invert();
      }
      renderer.render(scene, camera);
    }
    loop();
  }

  function stopRender() {
    if (animFrameId) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }
  }

  // Slider events
  thresholdSlider.addEventListener('input', () => {
    document.getElementById('vol-threshold-val').textContent = thresholdSlider.value;
    if (mesh) mesh.material.uniforms.threshold.value = parseFloat(thresholdSlider.value);
  });

  opacitySlider.addEventListener('input', () => {
    document.getElementById('vol-opacity-val').textContent = opacitySlider.value;
    if (mesh) mesh.material.uniforms.opacityScale.value = parseFloat(opacitySlider.value);
  });

  stepsSlider.addEventListener('input', () => {
    document.getElementById('vol-steps-val').textContent = stepsSlider.value;
    if (mesh) mesh.material.uniforms.numSteps.value = parseInt(stepsSlider.value);
  });

  // Clipping slider events
  ['x-min', 'x-max', 'y-min', 'y-max', 'z-min', 'z-max'].forEach(id => {
    const el = document.getElementById('clip-' + id);
    el.addEventListener('input', () => {
      if (!mesh) return;
      const u = mesh.material.uniforms;
      u.clipMin.value.set(
        parseFloat(document.getElementById('clip-x-min').value),
        parseFloat(document.getElementById('clip-y-min').value),
        parseFloat(document.getElementById('clip-z-min').value)
      );
      u.clipMax.value.set(
        parseFloat(document.getElementById('clip-x-max').value),
        parseFloat(document.getElementById('clip-y-max').value),
        parseFloat(document.getElementById('clip-z-max').value)
      );
    });
  });

  // Update colormap when changed
  const origColormapHandler = document.getElementById('colormap-select').onchange;
  document.getElementById('colormap-select').addEventListener('change', () => {
    if (colormapTexture) {
      buildColormapTexture();
    }
  });

  // Re-init when volume changes (hook into loadVolume)
  const origLoadVolume = window.loadVolume;
  // Watch for volume changes by patching renderAll
  const origRenderAll = window.renderAll || renderAll;

  // Expose re-init for when new volume loads
  window._reinit3D = function() {
    if (isInitialized) {
      // Dispose old volume resources but keep renderer/scene/camera
      if (volumeTexture) { volumeTexture.dispose(); volumeTexture = null; }
      if (mesh) {
        scene.remove(mesh);
        mesh.geometry.dispose();
        mesh.material.dispose();
        mesh = null;
      }
      isInitialized = false;
    }
    if (!container.classList.contains('hidden') && volume) {
      initVolume3D();
      // Force a re-render
      if (renderer && scene && camera) {
        renderer.render(scene, camera);
      }
    }
  };

  // Patch the global loadVolume to reinit 3D after loading
  const _origSelectSeries = window.selectSeries;

  window.addEventListener('resize', resize);
})();
