const captureStore = new Map();
const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_IDAT_CHUNK_SIZE = 1_048_576;
const PNG_STREAM_BATCH_BYTES = 1_048_576;
const TEXT_ENCODER = new TextEncoder();
const CRC_TABLE = buildCrcTable();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'resetCaptureSession') {
    captureStore.set(msg.captureSessionId, []);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.action === 'appendCaptureFrame') {
    if (!msg.captureSessionId || !msg.capture) {
      sendResponse({ error: 'invalid capture frame' });
      return false;
    }
    const sessionCaptures = captureStore.get(msg.captureSessionId) || [];
    sessionCaptures.push(msg.capture);
    captureStore.set(msg.captureSessionId, sessionCaptures);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.action === 'clearCaptureSession') {
    if (msg.captureSessionId) {
      captureStore.delete(msg.captureSessionId);
    }
    sendResponse({ ok: true });
    return false;
  }

  if (msg.action === 'stitchScreenshots') {
    try {
      const captures = resolveCaptures(msg);
      stitchAndDownload({ ...msg, captures }).then(sendResponse).catch(e => {
        sendResponse({ error: e.message });
      }).finally(() => {
        if (msg.captureSessionId) {
          captureStore.delete(msg.captureSessionId);
        }
      });
    } catch (e) {
      if (msg.captureSessionId) {
        captureStore.delete(msg.captureSessionId);
      }
      sendResponse({ error: e.message });
    }
    return true;
  }
});

const MAX_CANVAS_EDGE_PX = 8192;
const MAX_CANVAS_AREA_PX = 33_554_432; // 32 MP keeps us below common Chrome/GPU limits.

async function stitchAndDownload({ captures, totalH, viewW, dpr, cropLeft, cropRight, options, title }) {
  const reportProgress = (pct, text) => {
    chrome.runtime.sendMessage({ action: 'screenshotProgress', pct, text }).catch(() => {});
  };

  try {
    if (!captures?.length) {
      throw new Error('未获取到截图数据，请重试');
    }

    reportProgress(86, '加载图像...');

    reportProgress(90, '绘制画布...');

    const canvas = document.getElementById('canvas');
    if (!canvas) {
      throw new Error('未找到离屏画布');
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('无法创建画布上下文');
    }
    const date = new Date().toISOString().slice(0, 10);

    /* crop bounds in CSS pixels; fall back to full width */
    const cl = cropLeft || 0;
    const cr = cropRight || viewW;
    const cropW = Math.max(1, cr - cl);

    const longMode = options?.longMode !== false;
    const plan = createRenderPlan({
      cropW,
      totalH,
      requestedScale: dpr,
      longMode
    });
    const { scale, canvasW, maxCanvasHeightPx, tileHeightCss } = plan;

    if (!longMode) {
      if (totalH * scale > maxCanvasHeightPx) {
        throw new Error(`页面过长 (${totalH}px)，请开启「长图模式」后重试`);
      }

      const canvasH = Math.ceil(totalH * scale);
      canvas.width = canvasW;
      canvas.height = canvasH;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvasW, canvasH);

      for (let i = 0; i < captures.length; i++) {
        const cap = captures[i];
        const img = await loadImage(cap.dataUrl);
        const imgScaleX = img.width / viewW;
        const srcX = cl * imgScaleX;
        const srcW = cropW * imgScaleX;
        const remaining = totalH - cap.scrollY;
        const drawH = Math.min(cap.viewH, remaining);
        const srcDrawH = (drawH / cap.viewH) * img.height;
        ctx.drawImage(img, srcX, 0, srcW, srcDrawH, 0, cap.scrollY * scale, canvasW, drawH * scale);
        releaseImage(img);
        reportProgress(90 + Math.floor((i / captures.length) * 7), `绘制 ${i + 1}/${captures.length}...`);
      }

      if (options?.watermark && options?.watermarkText) {
        drawWatermark(ctx, options.watermarkText, canvasW, canvasH);
      }

      reportProgress(98, '生成文件...');
      await exportAndDownload(canvas, `${title}_${date}.png`);
      canvas.width = 1;
      canvas.height = 1;
      reportProgress(100, '完成！');
      await chrome.runtime.sendMessage({ action: 'screenshotComplete' }).catch(() => {});
      return { ok: true };
    }

    if (typeof CompressionStream !== 'function') {
      await exportSplitLongMode({
        canvas,
        ctx,
        captures,
        totalH,
        viewW,
        scale,
        cropLeft: cl,
        cropW,
        canvasW,
        tileHeightCss,
        options,
        title,
        date,
        reportProgress
      });
    } else {
      await exportStreamingLongPng({
        canvas,
        ctx,
        captures,
        totalH,
        viewW,
        scale,
        cropLeft: cl,
        cropW,
        canvasW,
        tileHeightCss,
        options,
        title,
        date,
        reportProgress
      });
    }

    canvas.width = 1;
    canvas.height = 1;
    reportProgress(100, '完成！');
    await chrome.runtime.sendMessage({ action: 'screenshotComplete' }).catch(() => {});
    return { ok: true };
  } catch (e) {
    throw e;
  }
}

function resolveCaptures({ captureSessionId, captures }) {
  if (Array.isArray(captures) && captures.length) {
    return captures;
  }
  if (!captureSessionId) {
    throw new Error('未找到待合成的截图数据，请重试');
  }
  const sessionCaptures = captureStore.get(captureSessionId);
  if (!sessionCaptures?.length) {
    throw new Error('离屏缓存中的截图数据已丢失，请重新截图');
  }
  return sessionCaptures;
}

function createRenderPlan({ cropW, totalH, requestedScale, longMode }) {
  let scale = Math.max(1, Number(requestedScale) || 1);
  const maxScaleByWidth = MAX_CANVAS_EDGE_PX / Math.max(1, cropW);
  scale = Math.min(scale, Math.max(1, maxScaleByWidth));

  let canvasW = Math.max(1, Math.ceil(cropW * scale));
  let maxCanvasHeightPx = Math.max(
    1,
    Math.min(MAX_CANVAS_EDGE_PX, Math.floor(MAX_CANVAS_AREA_PX / canvasW))
  );

  if (!longMode && totalH * scale > maxCanvasHeightPx) {
    const maxScaleByHeight = maxCanvasHeightPx / Math.max(1, totalH);
    scale = Math.min(scale, Math.max(1, maxScaleByHeight));
    canvasW = Math.max(1, Math.ceil(cropW * scale));
    maxCanvasHeightPx = Math.max(
      1,
      Math.min(MAX_CANVAS_EDGE_PX, Math.floor(MAX_CANVAS_AREA_PX / canvasW))
    );
  }

  const tileHeightCss = Math.max(1, Math.floor(maxCanvasHeightPx / scale));

  return {
    scale,
    canvasW,
    maxCanvasHeightPx,
    tileHeightCss
  };
}

async function exportSplitLongMode({
  canvas,
  ctx,
  captures,
  totalH,
  viewW,
  scale,
  cropLeft,
  cropW,
  canvasW,
  tileHeightCss,
  options,
  title,
  date,
  reportProgress
}) {
  const slicePlans = buildSlicePlans(totalH, tileHeightCss, scale);

  for (let s = 0; s < slicePlans.length; s++) {
    const slice = slicePlans[s];
    await renderSliceToCanvas({
      canvas,
      ctx,
      captures,
      viewW,
      cropLeft,
      cropW,
      canvasW,
      scale,
      slice,
      options
    });

    reportProgress(
      90 + Math.floor(((s + 0.5) / slicePlans.length) * 8),
      slicePlans.length > 1 ? `生成第 ${s + 1}/${slicePlans.length} 张...` : '生成文件...'
    );

    const suffix = slicePlans.length > 1 ? `_${s + 1}of${slicePlans.length}` : '';
    await exportAndDownload(canvas, `${title}${suffix}_${date}.png`);
  }
}

async function exportStreamingLongPng({
  canvas,
  ctx,
  captures,
  totalH,
  viewW,
  scale,
  cropLeft,
  cropW,
  canvasW,
  tileHeightCss,
  options,
  title,
  date,
  reportProgress
}) {
  const slicePlans = buildSlicePlans(totalH, tileHeightCss, scale);
  const finalHeight = slicePlans[slicePlans.length - 1]?.pixelEnd || Math.max(1, Math.round(totalH * scale));
  const compressionStream = new CompressionStream('deflate');
  const writer = compressionStream.writable.getWriter();
  const compressedPromise = new Response(compressionStream.readable).arrayBuffer();

  for (let s = 0; s < slicePlans.length; s++) {
    const slice = slicePlans[s];
    reportProgress(90 + Math.floor((s / slicePlans.length) * 4), `渲染第 ${s + 1}/${slicePlans.length} 段...`);

    await renderSliceToCanvas({
      canvas,
      ctx,
      captures,
      viewW,
      cropLeft,
      cropW,
      canvasW,
      scale,
      slice,
      options
    });

    reportProgress(94 + Math.floor(((s + 0.5) / slicePlans.length) * 3), `编码第 ${s + 1}/${slicePlans.length} 段...`);
    await writeCanvasToPngStream(writer, ctx, canvasW, canvas.height);
  }

  await writer.close();
  const compressedData = new Uint8Array(await compressedPromise);
  const pngBlob = buildPngBlob({
    width: canvasW,
    height: finalHeight,
    compressedData
  });

  reportProgress(98, '生成单张 PNG...');
  await downloadBlob(pngBlob, `${title}_${date}.png`);
}

function buildSlicePlans(totalH, tileHeightCss, scale) {
  const slices = [];

  for (let startY = 0; startY < totalH; startY += tileHeightCss) {
    const endY = Math.min(startY + tileHeightCss, totalH);
    slices.push({
      startY,
      endY,
      pixelStart: Math.round(startY * scale),
      pixelEnd: Math.round(endY * scale)
    });
  }

  return slices;
}

async function renderSliceToCanvas({
  canvas,
  ctx,
  captures,
  viewW,
  cropLeft,
  cropW,
  canvasW,
  scale,
  slice,
  options
}) {
  const slicePixelHeight = Math.max(1, slice.pixelEnd - slice.pixelStart);

  canvas.width = canvasW;
  canvas.height = slicePixelHeight;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvasW, canvas.height);

  for (let i = 0; i < captures.length; i++) {
    const cap = captures[i];
    const capStart = cap.scrollY;
    const capEnd = cap.scrollY + Math.min(cap.viewH, Math.max(0, cap.totalH - cap.scrollY));
    const overlapStart = Math.max(capStart, slice.startY);
    const overlapEnd = Math.min(capEnd, slice.endY);
    if (overlapStart >= overlapEnd) continue;

    const img = await loadImage(cap.dataUrl);
    const imgScaleX = img.width / viewW;
    const imgScaleY = img.height / cap.viewH;
    const srcX = cropLeft * imgScaleX;
    const srcW = cropW * imgScaleX;
    const srcY = (overlapStart - capStart) * imgScaleY;
    const srcH = (overlapEnd - overlapStart) * imgScaleY;
    const destY = Math.round(overlapStart * scale) - slice.pixelStart;
    const destEndY = Math.round(overlapEnd * scale) - slice.pixelStart;
    const destH = Math.max(1, destEndY - destY);

    ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, destY, canvasW, destH);
    releaseImage(img);
  }

  if (options?.watermark && options?.watermarkText) {
    drawWatermark(ctx, options.watermarkText, canvasW, canvas.height, slice.pixelStart);
  }
}

async function writeCanvasToPngStream(writer, ctx, width, height) {
  const stride = width * 4;
  const rowsPerBatch = Math.max(1, Math.floor(PNG_STREAM_BATCH_BYTES / Math.max(1, stride)));

  for (let y = 0; y < height; y += rowsPerBatch) {
    const batchH = Math.min(rowsPerBatch, height - y);
    const imageData = ctx.getImageData(0, y, width, batchH).data;
    const scanlines = new Uint8Array(batchH * (stride + 1));

    for (let row = 0; row < batchH; row++) {
      const srcStart = row * stride;
      const destStart = row * (stride + 1);
      scanlines[destStart] = 0;
      scanlines.set(imageData.subarray(srcStart, srcStart + stride), destStart + 1);
    }

    await writer.write(scanlines);
  }
}

function buildPngBlob({ width, height, compressedData }) {
  const parts = [
    PNG_SIGNATURE,
    createPngChunk('IHDR', createIHDRData(width, height))
  ];

  for (let offset = 0; offset < compressedData.length; offset += PNG_IDAT_CHUNK_SIZE) {
    parts.push(
      createPngChunk(
        'IDAT',
        compressedData.subarray(offset, offset + PNG_IDAT_CHUNK_SIZE)
      )
    );
  }

  parts.push(createPngChunk('IEND', new Uint8Array(0)));
  return new Blob(parts, { type: 'image/png' });
}

function createIHDRData(width, height) {
  const data = new Uint8Array(13);
  writeUint32(data, 0, width);
  writeUint32(data, 4, height);
  data[8] = 8;
  data[9] = 6;
  data[10] = 0;
  data[11] = 0;
  data[12] = 0;
  return data;
}

function createPngChunk(type, data) {
  const typeBytes = TEXT_ENCODER.encode(type);
  const chunk = new Uint8Array(12 + data.length);

  writeUint32(chunk, 0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  writeUint32(chunk, 8 + data.length, crc32(typeBytes, data));

  return chunk;
}

function writeUint32(target, offset, value) {
  const view = new DataView(target.buffer, target.byteOffset, target.byteLength);
  view.setUint32(offset, value >>> 0);
}

async function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => {
      if (b) resolve(b);
      else reject(new Error('图像生成失败，画布内容为空（可能超出设备内存限制）'));
    }, 'image/png', 1.0);
  });
}

async function exportAndDownload(canvas, filename) {
  const blob = await canvasToPngBlob(canvas);
  await downloadBlob(blob, filename);
}

async function downloadBlob(blob, filename) {
  const objectUrl = URL.createObjectURL(blob);

  try {
    let resp = await chrome.runtime.sendMessage({
      action: 'downloadScreenshot',
      url: objectUrl,
      filename
    });

    if (resp?.ok) return;

    const dataUrl = await blobToDataUrl(blob);
    resp = await chrome.runtime.sendMessage({
      action: 'downloadScreenshot',
      dataUrl,
      filename
    });

    if (resp?.error) {
      throw new Error(resp.error);
    }
    if (!resp?.ok) {
      throw new Error('下载失败');
    }
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
  }
}

async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('FileReader 转换失败'));
    reader.readAsDataURL(blob);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = src;
  });
}

function releaseImage(img) {
  try {
    img.src = '';
  } catch (_) {}
}

function crc32(typeBytes, data) {
  let crc = 0xffffffff;

  for (let i = 0; i < typeBytes.length; i++) {
    crc = CRC_TABLE[(crc ^ typeBytes[i]) & 0xff] ^ (crc >>> 8);
  }
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function buildCrcTable() {
  const table = new Uint32Array(256);

  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }

  return table;
}

function drawWatermark(ctx, text, w, h, offsetY = 0) {
  const spacing = 300;
  const cols = Math.ceil(w / spacing);
  const startY = -(((offsetY % spacing) + spacing) % spacing);

  ctx.save();
  ctx.globalAlpha = 0.08;
  ctx.fillStyle = '#888888';
  ctx.font = `bold ${Math.max(16, w / 40)}px -apple-system, sans-serif`;

  for (let y = startY; y <= h + spacing; y += spacing) {
    for (let c = 0; c <= cols; c++) {
      const x = c * spacing - spacing / 2;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-Math.PI / 6);
      ctx.fillText(text, 0, 0);
      ctx.restore();
    }
  }
  ctx.restore();
}
