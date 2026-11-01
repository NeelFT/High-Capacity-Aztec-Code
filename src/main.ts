import { createAztecLayout, drawAztecFrame, MAX_FILE_BYTES, prepareAztecTransfer, readU16, readU32 } from './aztec';
import type { PreparedAztecTransfer } from './aztec';
import type { DecoderTrace } from './image-decoder';
import type { WorkerRequest, WorkerResponse } from './worker-protocol';
import type { WorkerDiagnostics } from './worker-protocol';

const fileInput = document.getElementById('fileInput') as HTMLInputElement;
const sendButton = document.getElementById('sendButton') as HTMLButtonElement;
const fileName = document.getElementById('sendFileName') as HTMLElement;
const sendStatus = document.getElementById('sendStatus') as HTMLElement;
const frameCount = document.getElementById('frameCount') as HTMLElement;
const canvas = document.getElementById('tx') as HTMLCanvasElement;
const camera = document.getElementById('camera') as HTMLVideoElement;
const cameraPreview = document.getElementById('cameraPreview') as HTMLElement;
const diagnosticOverlay = document.getElementById('diagnosticOverlay') as HTMLCanvasElement;
const previewStatus = document.getElementById('previewStatus') as HTMLElement;
const cameraCanvas = document.getElementById('scanCanvas') as HTMLCanvasElement;
const startButton = document.getElementById('startButton') as HTMLButtonElement;
const receiveStatus = document.getElementById('receiveStatus') as HTMLElement;
const receiveProgress = document.getElementById('receiveProgress') as HTMLElement;
const receiveFileName = document.getElementById('receiveFileName') as HTMLElement;
const transferComplete = document.getElementById('transferComplete') as HTMLElement;
const sendPanel = document.getElementById('sendPanel') as HTMLElement;
const receivePanel = document.getElementById('receivePanel') as HTMLElement;
const sendTab = document.getElementById('sendTab') as HTMLButtonElement;
const receiveTab = document.getElementById('receiveTab') as HTMLButtonElement;
const targetMatrixInput = document.getElementById('targetMatrixSize') as HTMLSelectElement;
const transmitTelemetry = document.getElementById('transmitTelemetry') as HTMLElement;
const zoomSlider = document.getElementById('zoomSlider') as HTMLInputElement;
const zoomHelp = document.getElementById('zoomHelp') as HTMLElement;
const decoderTestButton = document.getElementById('decoderTestButton') as HTMLButtonElement;
const savedFrameInput = document.getElementById('savedFrameInput') as HTMLInputElement;
const decoderTestStatus = document.getElementById('decoderTestStatus') as HTMLElement;
const diagnosticElements = {
  camera: document.getElementById('diagCamera') as HTMLElement,
  frames: document.getElementById('diagFrames') as HTMLElement,
  processing: document.getElementById('diagProcessing') as HTMLElement,
  candidates: document.getElementById('diagCandidates') as HTMLElement,
  geometry: document.getElementById('diagGeometry') as HTMLElement,
  orientation: document.getElementById('diagOrientation') as HTMLElement,
  grid: document.getElementById('diagGrid') as HTMLElement,
  colour: document.getElementById('diagColour') as HTMLElement,
  header: document.getElementById('diagHeader') as HTMLElement,
  crc: document.getElementById('diagCrc') as HTMLElement,
  packets: document.getElementById('diagPackets') as HTMLElement,
  reconstruction: document.getElementById('diagReconstruction') as HTMLElement,
  verification: document.getElementById('diagVerification') as HTMLElement,
  lastDetection: document.getElementById('diagLastDetection') as HTMLElement,
  lastPacket: document.getElementById('diagLastPacket') as HTMLElement,
  rejected: document.getElementById('diagRejected') as HTMLElement,
  latestError: document.getElementById('diagLatestError') as HTMLElement,
};

let transfer: PreparedAztecTransfer | null = null;
let prepareGeneration = 0;
let sending = false;
let stream: MediaStream | null = null;
let worker: Worker | null = null;
let scanTimer = 0;
let frameInFlight = false;
let frameSentAt = 0;
let receivedPacketsCount = 0;
let isTransferComplete = false;
let activeZoomTrack: MediaStreamTrack | null = null;
let receiverGeneration = 0;
let senderGeneration = 0;
let cameraFramesReceived = 0;
let lastRenderTimestamp = 0;
let renderFps = 0;
let latestTrace: Omit<DecoderTrace, 'packet'> | null = null;
let latestDiagnostics: WorkerDiagnostics | null = null;

type ZoomCapabilities = MediaTrackCapabilities & { zoom?: { min: number; max: number; step?: number } };
type ZoomConstraints = MediaTrackConstraints & { advanced?: Array<MediaTrackConstraintSet & { zoom?: number }> };

function stopSender(): void {
  if (sending) {
    sending = false;
    senderGeneration += 1;
  }
  if (!fileInput.disabled) return;
  fileInput.disabled = false;
  sendButton.textContent = 'Send';
}

function setMode(mode: 'send' | 'receive'): void {
  const receiving = mode === 'receive';
  sendPanel.hidden = receiving;
  receivePanel.hidden = !receiving;
  sendTab.classList.toggle('active', !receiving);
  receiveTab.classList.toggle('active', receiving);
  sendTab.setAttribute('aria-selected', String(!receiving));
  receiveTab.setAttribute('aria-selected', String(receiving));
  targetMatrixInput.disabled = receiving || sending;
  if (receiving) {
    stopSender();
  } else {
    stopReceiver();
  }
}

function setCameraZoomAvailability(): void {
  const track = stream?.getVideoTracks()[0] ?? null;
  activeZoomTrack = track;
  const zoom = (track?.getCapabilities() as ZoomCapabilities | undefined)?.zoom;
  if (!zoom) {
    zoomSlider.disabled = true;
    zoomHelp.textContent = 'Zoom is not supported by this camera; move the devices closer or farther apart.';
    return;
  }
  zoomSlider.min = String(zoom.min);
  zoomSlider.max = String(zoom.max);
  zoomSlider.step = String(zoom.step ?? 0.1);
  zoomSlider.value = String(zoom.min);
  zoomSlider.disabled = false;
  zoomHelp.textContent = `Camera zoom available (${zoom.min}×–${zoom.max}×).`;
}

async function applyCameraZoom(): Promise<void> {
  if (!activeZoomTrack) return;
  try {
    const constraints: ZoomConstraints = { advanced: [{ zoom: Number(zoomSlider.value) }] };
    await activeZoomTrack.applyConstraints(constraints);
  } catch (error) {
    zoomSlider.disabled = true;
    zoomHelp.textContent = error instanceof Error ? `Camera zoom unavailable: ${error.message}` : 'Camera zoom could not be applied.';
  }
}

function statusForTrace(trace: Omit<DecoderTrace, 'packet'>, counts = latestDiagnostics): string {
  if (counts?.verification === 'VERIFIED') return 'COMPLETE';
  if (trace.status === 'packet-decoded') return counts?.uniqueBlocks
    ? 'RECONSTRUCTING'
    : 'PACKET ACCEPTED';
  if (trace.status === 'candidate-not-found') return latestDiagnostics?.frames ? 'DETECTING' : 'WAITING';
  if (trace.status === 'geometry-failed') return 'GEOMETRY FAILED';
  if (trace.status === 'orientation-failed') return 'CANDIDATE FOUND — ORIENTATION FAILED';
  if (trace.status === 'grid-sampling-failed') return 'GRID SAMPLING FAILED';
  if (trace.status === 'colour-recognition-failed') return 'COLOUR RECOGNITION FAILED';
  if (trace.status === 'crc-failed') return 'CRC FAILED';
  return 'INVALID PACKET';
}

function updateDiagnostics(trace: Omit<DecoderTrace, 'packet'>, counts: WorkerDiagnostics): void {
  latestTrace = trace;
  latestDiagnostics = counts;
  const status = statusForTrace(trace);
  diagnosticElements.camera.textContent = stream?.active ? 'CONNECTED' : 'DISCONNECTED';
  diagnosticElements.frames.textContent = `${cameraFramesReceived} received`;
  diagnosticElements.processing.textContent = `${counts.frames} processed (${trace.imageWidth}×${trace.imageHeight})`;
  diagnosticElements.candidates.textContent = `${counts.candidatesDetected} total; ${trace.candidateCount} this frame`;
  diagnosticElements.geometry.textContent = trace.geometryCandidates
    ? `ACCEPTED (${trace.geometryCandidates} this frame; ${counts.validGeometry} total)`
    : trace.candidateCount ? `FAILED — ${trace.reason}` : 'WAITING';
  diagnosticElements.orientation.textContent = trace.orientationFound
    ? `FOUND (${counts.orientationsFound} frames)`
    : trace.candidateCount ? 'NOT FOUND' : 'WAITING';
  diagnosticElements.grid.textContent = trace.gridSampled
    ? `SAMPLED (${counts.gridsSampled} frames)`
    : trace.orientationFound ? 'FAILED' : 'WAITING';
  diagnosticElements.colour.textContent = trace.gridSampled
    ? `${trace.recognizedModules}/${trace.totalModules} modules; confidence margin ${trace.colourConfidence?.toFixed(1) ?? '—'} ΔE`
    : trace.orientationFound ? 'FAILED' : 'WAITING';
  diagnosticElements.header.textContent = trace.headerValid === null ? 'WAITING' : trace.headerValid ? 'VALID' : 'INVALID';
  diagnosticElements.crc.textContent = trace.crcValid === null ? 'WAITING' : trace.crcValid ? `PASSED (${counts.crcPasses})` : 'FAILED';
  diagnosticElements.packets.textContent = `${counts.packets} accepted`;
  diagnosticElements.reconstruction.textContent = `${counts.uniqueBlocks} unique blocks`;
  diagnosticElements.verification.textContent = counts.verification;
  diagnosticElements.lastDetection.textContent = counts.lastDetectionTimestamp
    ? new Date(counts.lastDetectionTimestamp).toLocaleTimeString()
    : 'Never';
  diagnosticElements.lastPacket.textContent = counts.lastPacketId === null ? '—' : String(counts.lastPacketId);
  diagnosticElements.rejected.textContent = `${counts.rejectedCandidates} / ${counts.rejectedPackets}`;
  diagnosticElements.latestError.textContent = `Most recent error: ${counts.latestError ?? 'none'}`;
  previewStatus.textContent = `${status} · ${trace.reason}`;
  receiveStatus.textContent = status;
  drawDiagnosticOverlay(trace);
}

function drawDiagnosticOverlay(trace: Omit<DecoderTrace, 'packet'>): void {
  const context = diagnosticOverlay.getContext('2d');
  if (!context) return;
  const bounds = cameraPreview.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(bounds.width * dpr));
  const height = Math.max(1, Math.round(bounds.height * dpr));
  if (diagnosticOverlay.width !== width || diagnosticOverlay.height !== height) {
    diagnosticOverlay.width = width;
    diagnosticOverlay.height = height;
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, bounds.width, bounds.height);
  const videoBounds = camera.getBoundingClientRect();
  if (!camera.videoWidth || !camera.videoHeight || videoBounds.width === 0 || videoBounds.height === 0) {
    if (trace.status === 'candidate-not-found') {
      context.strokeStyle = '#ffcc00';
      context.setLineDash([8, 5]);
      context.strokeRect(bounds.width * 0.15, bounds.height * 0.15, bounds.width * 0.7, bounds.height * 0.7);
      context.setLineDash([]);
    }
    return;
  }
  const scale = Math.min(videoBounds.width / camera.videoWidth, videoBounds.height / camera.videoHeight);
  const contentWidth = camera.videoWidth * scale;
  const contentHeight = camera.videoHeight * scale;
  const contentLeft = videoBounds.left - bounds.left + (videoBounds.width - contentWidth) / 2;
  const contentTop = videoBounds.top - bounds.top + (videoBounds.height - contentHeight) / 2;
  const cropX = (camera.videoWidth - trace.imageWidth) / 2;
  const cropY = (camera.videoHeight - trace.imageHeight) / 2;
  const mapPoint = (point: { x: number; y: number }) => ({
    x: contentLeft + (cropX + point.x) * scale,
    y: contentTop + (cropY + point.y) * scale,
  });
  if (!trace.corners) {
    if (trace.status === 'candidate-not-found') {
      const side = Math.min(contentWidth, contentHeight) * 0.7;
      context.strokeStyle = '#ffcc00';
      context.setLineDash([8, 5]);
      context.strokeRect(contentLeft + (contentWidth - side) / 2, contentTop + (contentHeight - side) / 2, side, side);
      context.setLineDash([]);
    }
    return;
  }
  const colour = trace.status === 'packet-decoded' ? '#00ff88'
    : trace.geometryCandidates === 0 ? '#ff4d4d'
      : trace.orientationFound ? '#ffae00' : '#ffe600';
  context.strokeStyle = colour;
  context.lineWidth = 2;
  context.setLineDash(trace.geometryCandidates ? [] : [8, 5]);
  context.beginPath();
  trace.corners.forEach((corner, index) => {
    const point = mapPoint(corner);
    if (index === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  });
  context.closePath();
  context.stroke();
  context.setLineDash([]);
  for (const [from, to] of trace.gridLines) {
    const start = mapPoint(from);
    const end = mapPoint(to);
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    context.strokeStyle = `${colour}88`;
    context.lineWidth = 0.7;
    context.stroke();
  }
  for (const corner of trace.corners) {
    const point = mapPoint(corner);
    context.beginPath();
    context.arc(point.x, point.y, 4, 0, Math.PI * 2);
    context.fillStyle = colour;
    context.fill();
  }
}

function updateTransmitTelemetry(
  packet: Uint8Array,
  currentFrame: number,
  totalFrames: number,
  render: ReturnType<typeof drawAztecFrame>,
  state: 'RUNNING' | 'STOPPED',
): void {
  const frameId = packet.length >= 4 ? readU32(new DataView(packet.buffer, packet.byteOffset, packet.byteLength), 0) : 0;
  const degree = packet[20] ?? 0;
  const firstBlockId = degree > 0 && packet.length >= 23
    ? readU16(new DataView(packet.buffer, packet.byteOffset, packet.byteLength), 21)
    : '—';
  const now = performance.now();
  if (lastRenderTimestamp > 0) {
    const instantaneous = 1000 / Math.max(1, now - lastRenderTimestamp);
    renderFps = renderFps === 0 ? instantaneous : renderFps * 0.75 + instantaneous * 0.25;
  }
  lastRenderTimestamp = now;
  transmitTelemetry.textContent = `Frame ${currentFrame}/${totalFrames} | Packet ${frameId} / block ${firstBlockId} | ${renderFps.toFixed(1)} FPS | ${state} | Canvas ${render.width}×${render.height} | Matrix ${render.changedModules}/${render.totalModules} changed`;
}

function scan(): void {
  if (!stream || !worker) return;
  if (camera.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || camera.videoWidth === 0 || camera.videoHeight === 0 || frameInFlight) {
    scanTimer = requestAnimationFrame(scan);
    return;
  }
  if (cameraCanvas.width !== camera.videoWidth || cameraCanvas.height !== camera.videoHeight) {
    cameraCanvas.width = camera.videoWidth;
    cameraCanvas.height = camera.videoHeight;
  }
  const context = cameraCanvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    receiveStatus.textContent = 'Camera capture is unavailable in this browser.';
    stopReceiver();
    return;
  }
  context.drawImage(camera, 0, 0);
  const sourceSize = Math.min(cameraCanvas.width, cameraCanvas.height);
  const cropX = Math.floor((cameraCanvas.width - sourceSize) / 2);
  const cropY = Math.floor((cameraCanvas.height - sourceSize) / 2);
  try {
    const image = context.getImageData(cropX, cropY, sourceSize, sourceSize);
    cameraFramesReceived += 1;
    diagnosticElements.frames.textContent = `${cameraFramesReceived} received`;
    frameInFlight = true;
    frameSentAt = performance.now();
    const request: WorkerRequest = { type: 'frame', pixels: image };
    worker.postMessage(request, [image.data.buffer]);
  } catch (error) {
    receiveStatus.textContent = error instanceof Error ? `Camera frame capture failed: ${error.message}` : 'Camera frame capture failed.';
    stopReceiver();
    return;
  }
  scanTimer = requestAnimationFrame(scan);
}

function stopReceiver(): void {
  receiverGeneration += 1;
  if (scanTimer) cancelAnimationFrame(scanTimer);
  scanTimer = 0;
  worker?.postMessage({ type: 'stop' } satisfies WorkerRequest);
  worker?.terminate();
  worker = null;
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  camera.srcObject = null;
  activeZoomTrack = null;
  zoomSlider.disabled = true;
  frameInFlight = false;
  startButton.textContent = 'Start camera';
  targetMatrixInput.disabled = false;
  diagnosticElements.camera.textContent = 'DISCONNECTED';
  previewStatus.textContent = 'WAITING — camera off';
  const overlayContext = diagnosticOverlay.getContext('2d');
  overlayContext?.clearRect(0, 0, diagnosticOverlay.width, diagnosticOverlay.height);
}

function resetReceiveState(): void {
  receivedPacketsCount = 0;
  isTransferComplete = false;
  frameInFlight = false;
  cameraFramesReceived = 0;
  latestTrace = null;
  latestDiagnostics = null;
  transferComplete.hidden = true;
  receiveProgress.textContent = '';
  receiveFileName.textContent = '';
  diagnosticElements.camera.textContent = 'CONNECTED';
  diagnosticElements.frames.textContent = '0 received';
  diagnosticElements.processing.textContent = '0 processed';
  diagnosticElements.candidates.textContent = '0 candidates';
  diagnosticElements.geometry.textContent = 'WAITING';
  diagnosticElements.orientation.textContent = 'WAITING';
  diagnosticElements.grid.textContent = 'WAITING';
  diagnosticElements.colour.textContent = 'WAITING';
  diagnosticElements.header.textContent = 'WAITING';
  diagnosticElements.crc.textContent = 'WAITING';
  diagnosticElements.packets.textContent = '0 accepted';
  diagnosticElements.reconstruction.textContent = '0 blocks';
  diagnosticElements.verification.textContent = 'WAITING';
  diagnosticElements.lastDetection.textContent = 'Never';
  diagnosticElements.lastPacket.textContent = '—';
  diagnosticElements.rejected.textContent = '0 / 0';
  diagnosticElements.latestError.textContent = 'Most recent error: none';
}

function downloadCompletedFile(message: Extract<WorkerResponse, { type: 'complete' }>): void {
  if (!message.verified || !/^[\da-f]{64}$/i.test(message.expectedHash)) {
    receiveStatus.textContent = 'Transfer integrity failure: the receiver did not verify the reconstructed file.';
    stopReceiver();
    return;
  }
  isTransferComplete = true;
  const blob = new Blob([new Uint8Array(message.bytes)], { type: message.mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = message.name || 'received-file';
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  receiveFileName.textContent = `${message.name || 'received-file'} (${message.bytes.byteLength.toLocaleString()} bytes, ${message.mime || 'application/octet-stream'})`;
  transferComplete.hidden = false;
  receiveStatus.textContent = 'Transfer complete; SHA-256 verified and file downloaded.';
  receiveProgress.textContent = `${message.unique} unique packets; ${message.solved} source blocks recovered`;
  stopReceiver();
}

function handleWorkerMessage(message: WorkerResponse): void {
  if (message.type === 'packet') {
    receivedPacketsCount = message.decodedCount;
    if (message.name) receiveFileName.textContent = message.name;
    receiveProgress.textContent = `Accepted ${message.decodedCount} unique packets; recovered ${message.solved} of ${message.blockCount} source blocks`;
    return;
  }
  if (message.type === 'diagnostic') {
    updateDiagnostics(message.trace, message.counts);
    return;
  }
  if (message.type === 'frameDone') {
    frameInFlight = false;
    if (message.counts.frames > 0) {
      const elapsed = frameSentAt > 0 ? performance.now() - frameSentAt : 0;
      const fps = elapsed > 0 ? (1000 / elapsed).toFixed(1) : '0.0';
      if (latestTrace) {
        diagnosticElements.processing.textContent = `${message.counts.frames} processed (${latestTrace.imageWidth}×${latestTrace.imageHeight}) · ${fps} FPS`;
      }
    }
    return;
  }
  if (message.type === 'complete') {
    downloadCompletedFile(message);
    return;
  }
  receiveStatus.textContent = message.message;
  stopReceiver();
}

async function prepareSelectedFile(file: File, matrixSize: number): Promise<void> {
  const generation = ++prepareGeneration;
  transfer = null;
  sendButton.disabled = true;
  frameCount.textContent = '';
  fileName.textContent = file.name;
  sendStatus.textContent = `Preparing ${matrixSize}×${matrixSize} transfer...`;
  try {
    if (file.size > MAX_FILE_BYTES) throw new Error(`Files larger than ${MAX_FILE_BYTES / (1024 * 1024)} MiB are not supported.`);
    const prepared = await prepareAztecTransfer(file, matrixSize, (current, total) => {
      if (generation === prepareGeneration) sendStatus.textContent = `Preparing source block ${current} of ${total}...`;
    });
    if (generation !== prepareGeneration) return;
    transfer = prepared;
    const layout = createAztecLayout(prepared.targetMatrixSize);
    frameCount.textContent = `${prepared.frameCount} frames; ${prepared.blockCount} source blocks; ${layout.dataCoordinates.length} data modules; ${layout.alignmentCoordinates.size} structural markers`;
    sendStatus.textContent = 'Ready - press Send to stream continuously';
    sendButton.disabled = false;
  } catch (error) {
    if (generation !== prepareGeneration) return;
    sendStatus.textContent = error instanceof Error ? error.message : 'Could not prepare file.';
  }
}

fileInput.onchange = () => {
  const file = fileInput.files?.[0];
  if (file) void prepareSelectedFile(file, Number(targetMatrixInput.value));
};

targetMatrixInput.onchange = () => {
  const file = fileInput.files?.[0];
  if (file) {
    void prepareSelectedFile(file, Number(targetMatrixInput.value));
    return;
  }
  prepareGeneration += 1;
  transfer = null;
  sendButton.disabled = true;
  frameCount.textContent = '';
  sendStatus.textContent = 'Choose a file';
};

sendButton.onclick = async () => {
  if (sending) {
    stopSender();
    transmitTelemetry.textContent = transmitTelemetry.textContent.replace('RUNNING', 'STOPPED');
    return;
  }
  if (!transfer) return;
  const selectedMatrixSize = Number(targetMatrixInput.value);
  if (transfer.targetMatrixSize !== selectedMatrixSize) {
    const file = fileInput.files?.[0];
    if (file) void prepareSelectedFile(file, selectedMatrixSize);
    return;
  }
  const activeTransfer = transfer;
  const generation = ++senderGeneration;
  sending = true;
  renderFps = 0;
  lastRenderTimestamp = 0;
  fileInput.disabled = true;
  targetMatrixInput.disabled = true;
  sendButton.textContent = 'Stop';
  let index = 0;
  try {
    while (sending && generation === senderGeneration) {
      const packet = activeTransfer.packets[index];
      const render = drawAztecFrame(packet, canvas, activeTransfer.targetMatrixSize);
      updateTransmitTelemetry(packet, index + 1, activeTransfer.frameCount, render, 'RUNNING');
      sendStatus.textContent = `Displaying frame ${index + 1} of ${activeTransfer.frameCount}; sequence repeats for loss recovery`;
      index = (index + 1) % activeTransfer.packets.length;
      const holdMs = Math.max(140, Math.round(140 * Math.pow(activeTransfer.targetMatrixSize / 63, 1.35)));
      await new Promise<void>((resolve) => window.setTimeout(resolve, holdMs));
    }
  } catch (error) {
    sendStatus.textContent = error instanceof Error ? error.message : 'Could not render the transfer frame.';
  } finally {
    if (generation !== senderGeneration) return;
    sending = false;
    fileInput.disabled = false;
    targetMatrixInput.disabled = !receivePanel.hidden;
    sendButton.textContent = 'Send';
    if (sendStatus.textContent.startsWith('Displaying frame')) sendStatus.textContent = 'Stream stopped; prepared packets retained';
  }
};

canvas.addEventListener('click', () => {
  if (sending) stopSender();
});

function runWorkerDecodeTest(image: ImageData, matrixSize: number, label: string): Promise<void> {
  decoderTestStatus.textContent = `${label}: starting actual decoder worker...`;
  const testWorker = new Worker(new URL('./decoder.worker.ts', import.meta.url), { type: 'module' });
  return new Promise<void>((resolve) => {
    let finished = false;
    const finish = (message: string): void => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timeout);
      testWorker.terminate();
      decoderTestStatus.textContent = message;
      resolve();
    };
    const timeout = window.setTimeout(() => finish(`${label}: timed out before the decoder completed.`), 20000);
    testWorker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.type === 'diagnostic') {
        const trace = message.trace;
        decoderTestStatus.textContent = `${label}: ${statusForTrace(trace, message.counts)}; geometry ${trace.geometryCandidates ? 'accepted' : 'failed'}; colours ${trace.recognizedModules}/${trace.totalModules}; header ${trace.headerValid ?? 'not reached'}; CRC ${trace.crcValid ?? 'not reached'}; ${trace.reason}`;
      } else if (message.type === 'packet') {
        decoderTestStatus.textContent = `${label}: packet ${message.frameId} accepted; recovered ${message.solved}/${message.blockCount} blocks.`;
      } else if (message.type === 'complete') {
        finish(`${label}: COMPLETE — geometry, colour decoding, CRC32 and SHA-256 verified; packet ${message.unique ? 'accepted' : 'decoded'}, ${message.solved} block(s) recovered.`);
      } else if (message.type === 'error') {
        finish(`${label}: FAILED — ${message.message}`);
      }
    };
    testWorker.onerror = (event: ErrorEvent) => finish(`${label}: worker failed — ${event.message || 'unknown error'}`);
    testWorker.postMessage({ type: 'start', targetMatrixSize: matrixSize } satisfies WorkerRequest);
    testWorker.postMessage({ type: 'frame', pixels: image } satisfies WorkerRequest, [image.data.buffer]);
  });
}

decoderTestButton.onclick = async () => {
  decoderTestButton.disabled = true;
  try {
    const matrixSize = Number(targetMatrixInput.value);
    const testBytes = new TextEncoder().encode('HCAC test');
    const testFile = new File([testBytes], 'hcac-self-test.txt', { type: 'text/plain' });
    const prepared = await prepareAztecTransfer(testFile, matrixSize);
    const renderCanvas = document.createElement('canvas');
    drawAztecFrame(prepared.packets[0], renderCanvas, matrixSize);
    const context = renderCanvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Could not render the self-test frame.');
    await runWorkerDecodeTest(context.getImageData(0, 0, renderCanvas.width, renderCanvas.height), matrixSize, 'Generated-frame self-test');
  } catch (error) {
    decoderTestStatus.textContent = error instanceof Error ? `Self-test failed: ${error.message}` : 'Self-test failed.';
  } finally {
    decoderTestButton.disabled = false;
  }
};

savedFrameInput.onchange = async () => {
  const file = savedFrameInput.files?.[0];
  if (!file) return;
  try {
    decoderTestStatus.textContent = `Loading saved image "${file.name}"...`;
    const bitmap = await createImageBitmap(file);
    try {
      const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
      const imageCanvas = document.createElement('canvas');
      imageCanvas.width = Math.max(1, Math.round(bitmap.width * scale));
      imageCanvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = imageCanvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Could not read the selected image.');
      context.drawImage(bitmap, 0, 0, imageCanvas.width, imageCanvas.height);
      const image = context.getImageData(0, 0, imageCanvas.width, imageCanvas.height);
      await runWorkerDecodeTest(image, Number(targetMatrixInput.value), `Saved image "${file.name}"`);
    } finally {
      bitmap.close();
    }
  } catch (error) {
    decoderTestStatus.textContent = error instanceof Error ? `Saved-image decode failed: ${error.message}` : 'Saved-image decode failed.';
  }
};

startButton.onclick = async () => {
  if (stream) {
    stopReceiver();
    receiveStatus.textContent = 'Camera stopped';
    targetMatrixInput.disabled = false;
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    receiveStatus.textContent = 'Camera access is not available in this browser. Use a current mobile browser over HTTPS.';
    return;
  }
  const generation = ++receiverGeneration;
  startButton.disabled = true;
  receiveStatus.textContent = 'Requesting camera permission...';
  try {
    const matrixSize = Number(targetMatrixInput.value);
    const acquiredStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    if (generation !== receiverGeneration || receivePanel.hidden) {
      acquiredStream.getTracks().forEach((track) => track.stop());
      return;
    }
    stream = acquiredStream;
    camera.srcObject = acquiredStream;
    await camera.play();
    if (generation !== receiverGeneration || receivePanel.hidden) return;
    worker = new Worker(new URL('./decoder.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => handleWorkerMessage(event.data);
    worker.onerror = (event: ErrorEvent) => {
      receiveStatus.textContent = `Receiver worker failed: ${event.message || 'unknown error'}`;
      stopReceiver();
    };
    resetReceiveState();
    for (const track of acquiredStream.getVideoTracks()) {
      track.addEventListener('ended', () => {
        diagnosticElements.camera.textContent = 'DISCONNECTED';
        receiveStatus.textContent = 'Camera disconnected.';
      }, { once: true });
    }
    targetMatrixInput.disabled = true;
    setCameraZoomAvailability();
    receiveStatus.textContent = 'Camera active; center the entire colored frame in view.';
    startButton.textContent = 'Stop camera';
    worker.postMessage({ type: 'start', targetMatrixSize: matrixSize } satisfies WorkerRequest);
    scan();
  } catch (error) {
    if (generation !== receiverGeneration) return;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    worker?.terminate();
    worker = null;
    camera.srcObject = null;
    targetMatrixInput.disabled = false;
    const errorName = error instanceof DOMException ? error.name : '';
    const hint = errorName === 'NotAllowedError'
      ? 'Camera permission was denied. Allow camera access in browser settings.'
      : errorName === 'NotFoundError'
        ? 'No camera was found on this device.'
        : errorName === 'NotReadableError'
          ? 'The camera is already in use by another application.'
          : error instanceof Error
            ? error.message
            : 'Could not start the camera. HTTPS is required.';
    receiveStatus.textContent = hint;
    startButton.textContent = 'Start camera';
  } finally {
    startButton.disabled = false;
  }
};

zoomSlider.oninput = () => { void applyCameraZoom(); };
sendTab.onclick = () => setMode('send');
receiveTab.onclick = () => setMode('receive');
window.addEventListener('beforeunload', () => {
  stopSender();
  stopReceiver();
});
setMode('send');
