import { createAztecLayout, drawAztecFrame, MAX_FILE_BYTES, prepareAztecTransfer } from './aztec';
import type { PreparedAztecTransfer } from './aztec';
import type { WorkerRequest, WorkerResponse } from './worker-protocol';

const fileInput = document.getElementById('fileInput') as HTMLInputElement;
const sendButton = document.getElementById('sendButton') as HTMLButtonElement;
const fileName = document.getElementById('sendFileName') as HTMLElement;
const sendStatus = document.getElementById('sendStatus') as HTMLElement;
const frameCount = document.getElementById('frameCount') as HTMLElement;
const canvas = document.getElementById('tx') as HTMLCanvasElement;
const camera = document.getElementById('camera') as HTMLVideoElement;
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

type ZoomCapabilities = MediaTrackCapabilities & { zoom?: { min: number; max: number; step?: number } };
type ZoomConstraints = MediaTrackConstraints & { advanced?: Array<MediaTrackConstraintSet & { zoom?: number }> };

function stopSender(): void {
  sending = false;
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

function updateTransmitTelemetry(packet: Uint8Array, currentFrame: number, totalFrames: number, layout: ReturnType<typeof createAztecLayout>): void {
  if (!transfer) return;
  const encodedModules = Math.ceil(packet.length * 8 / 3);
  const paddingModules = layout.dataCoordinates.length - encodedModules;
  const structuralModules = transfer.targetMatrixSize ** 2 - layout.dataCoordinates.length;
  transmitTelemetry.textContent = `Frame ${currentFrame}/${totalFrames} | ${packet.length} packet bytes | ${encodedModules} data modules | ${paddingModules} padding | ${structuralModules} structural | ${layout.dataCoordinates.length * 3} data-bit capacity`;
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
}

function resetReceiveState(): void {
  receivedPacketsCount = 0;
  isTransferComplete = false;
  frameInFlight = false;
  transferComplete.hidden = true;
  receiveProgress.textContent = '';
  receiveFileName.textContent = '';
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
    receiveStatus.textContent = `${message.code} (${message.counts.packets} packets / ${message.counts.frames} camera frames)`;
    return;
  }
  if (message.type === 'frameDone') {
    frameInFlight = false;
    if (message.counts.frames > 0) {
      const elapsed = frameSentAt > 0 ? performance.now() - frameSentAt : 0;
      const fps = elapsed > 0 ? (1000 / elapsed).toFixed(1) : '0.0';
      if (message.counts.packets === 0) receiveStatus.textContent = `Looking for the full color frame… ${fps} FPS`;
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

fileInput.onchange = async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  const generation = ++prepareGeneration;
  transfer = null;
  sendButton.disabled = true;
  fileName.textContent = file.name;
  sendStatus.textContent = 'Preparing fountain blocks...';
  try {
    if (file.size > MAX_FILE_BYTES) throw new Error(`Files larger than ${MAX_FILE_BYTES / (1024 * 1024)} MiB are not supported.`);
    const matrixSize = Number(targetMatrixInput.value);
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
};

sendButton.onclick = async () => {
  if (sending) {
    sending = false;
    return;
  }
  if (!transfer) return;
  const activeTransfer = transfer;
  sending = true;
  fileInput.disabled = true;
  targetMatrixInput.disabled = true;
  sendButton.textContent = 'Stop';
  let index = 0;
  const layout = createAztecLayout(activeTransfer.targetMatrixSize);
  try {
    while (sending) {
      const packet = activeTransfer.packets[index];
      drawAztecFrame(packet, canvas, activeTransfer.targetMatrixSize);
      updateTransmitTelemetry(packet, index + 1, activeTransfer.frameCount, layout);
      sendStatus.textContent = `Displaying frame ${index + 1} of ${activeTransfer.frameCount}; sequence repeats for loss recovery`;
      index = (index + 1) % activeTransfer.packets.length;
      const holdMs = Math.max(140, Math.round(140 * Math.pow(activeTransfer.targetMatrixSize / 63, 1.35)));
      await new Promise<void>((resolve) => window.setTimeout(resolve, holdMs));
    }
  } catch (error) {
    sendStatus.textContent = error instanceof Error ? error.message : 'Could not render the transfer frame.';
  } finally {
    sending = false;
    fileInput.disabled = false;
    targetMatrixInput.disabled = !receivePanel.hidden;
    sendButton.textContent = 'Send';
    if (sendStatus.textContent.startsWith('Displaying frame')) sendStatus.textContent = 'Stream stopped; prepared packets retained';
  }
};

canvas.addEventListener('click', () => {
  if (sending) sending = false;
});

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
