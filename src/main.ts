import { drawAztecFrame, prepareAztecTransfer, PreparedAztecTransfer, readU16, readU32, xorInto } from './aztec';

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

let transfer: PreparedAztecTransfer | null = null;
let sending = false;
let stream: MediaStream | null = null;
let worker: Worker | null = null;
let scanTimer = 0;
let packetCount = 0;
let session = 0;
let blockCount = 0;
let blockSize = 0;
let fileSize = 0;
let fileNameReceived = '';
let fileTypeReceived = 'application/octet-stream';
let targetMatrixSize = 63;
let metadataReady = false;
let frameInFlight = false;
let scanFrames = 0;
let scanLatencyMs = 0;
let frameSentAt = 0;
let fileBuffer: Uint8Array[] = [];
let receivedPacketsCount = 0;
let totalRequiredPackets: number | null = null;
let isTransferComplete = false;
const equations = new Map<number, { indices: number[]; data: Uint8Array }>();
const solved = new Map<number, Uint8Array>();

function setMode(mode: 'send' | 'receive'): void {
  const receiving = mode === 'receive';
  sendPanel.hidden = receiving;
  receivePanel.hidden = !receiving;
  sendTab.classList.toggle('active', !receiving);
  receiveTab.classList.toggle('active', receiving);
  if (!receiving) stopReceiver();
}

function packetData(packet: Uint8Array): { frameId: number; total: number; seed: number; session: number; blockCount: number; blockSize: number; indices: number[]; data: Uint8Array; metadata: Uint8Array } | null {
  if (packet.length < 25) return null;
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const frameId = readU32(view, 0);
  const total = readU32(view, 4);
  const seed = readU32(view, 8);
  const frameSession = readU32(view, 12);
  const count = readU16(view, 16);
  const size = readU16(view, 18);
  const degree = packet[20];
  if (degree < 1 || degree > count || degree > 24 || count < 1 || size < 1 || total < 0) return null;
  let offset = 21;
  const indices: number[] = [];
  for (let index = 0; index < degree; index += 1) {
    if (offset + 2 > packet.length) return null;
    indices.push(readU16(view, offset));
    offset += 2;
  }
  if (offset >= packet.length) return null;
  const metadataLength = packet[offset++];
  if (offset + metadataLength > packet.length) return null;
  const metadata = packet.slice(offset, offset + metadataLength);
  offset += metadataLength;
  if (offset + size > packet.length) return null;
  return { frameId, total, seed, session: frameSession, blockCount: count, blockSize: size, indices, data: packet.slice(offset, offset + size), metadata };
}

function peel(): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, equation] of equations) {
      const unknown = equation.indices.filter((index) => !solved.has(index));
      if (unknown.length === 0) {
        equations.delete(id);
      } else if (unknown.length === 1) {
        const result = equation.data.slice();
        for (const index of equation.indices) {
          if (index !== unknown[0]) xorInto(result, solved.get(index)!);
        }
        solved.set(unknown[0], result);
        equations.delete(id);
        changed = true;
      }
    }
  }
}

function finishIfComplete(): void {
  if (isTransferComplete || !metadataReady || solved.size < blockCount) return;
  isTransferComplete = true;
  const output = new Uint8Array(fileSize);
  for (let index = 0; index < blockCount; index += 1) {
    const destinationOffset = index * blockSize;
    if (destinationOffset >= output.length) break;
    output.set(solved.get(index)!.subarray(0, Math.min(blockSize, output.length - destinationOffset)), destinationOffset);
  }
  const blob = new Blob([new Uint8Array(output)], { type: fileTypeReceived });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileNameReceived || 'received-file';
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  transferComplete.hidden = false;
  receiveStatus.textContent = 'Transfer Complete';
  receiveProgress.textContent = `${solved.size} fountain blocks solved; file downloaded`;
  stopReceiver();
}

function downloadCompletedFile(bytes: Uint8Array, name: string, mime: string, unique: number, solvedBlocks: number): void {
  const blob = new Blob([new Uint8Array(bytes)], { type: mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name || 'received-file';
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  transferComplete.hidden = false;
  receiveStatus.textContent = 'Transfer Complete';
  receiveProgress.textContent = `${unique} unique fountain packets; ${solvedBlocks} blocks solved; file downloaded`;
  stopReceiver();
}

function acceptPacket(packet: Uint8Array): void {
  const parsed = packetData(packet);
  if (isTransferComplete || !parsed || (session && parsed.session !== session)) return;
  if (!session) {
    session = parsed.session;
    blockCount = parsed.blockCount;
    blockSize = parsed.blockSize;
    fileSize = parsed.total;
    totalRequiredPackets = parsed.blockCount;
  }
  if (!metadataReady && parsed.metadata[0] === 1) {
    const nameLength = parsed.metadata[1];
    const nameStart = 2;
    const typeLength = parsed.metadata[nameStart + nameLength];
    fileNameReceived = new TextDecoder().decode(parsed.metadata.slice(nameStart, nameStart + nameLength));
    fileTypeReceived = new TextDecoder().decode(parsed.metadata.slice(nameStart + nameLength + 1, nameStart + nameLength + 1 + typeLength));
    metadataReady = true;
    receiveFileName.textContent = fileNameReceived;
  }
  if (equations.has(parsed.frameId)) return;
  fileBuffer.push(parsed.data);
  receivedPacketsCount += 1;
  equations.set(parsed.frameId, { indices: parsed.indices, data: parsed.data });
  peel();
  packetCount += 1;
  receiveProgress.textContent = `Decoded ${receivedPacketsCount} unique packets; solved ${solved.size} of ${blockCount} blocks`;
  finishIfComplete();
}

function scan(): void {
  if (!stream || !worker) return;
  if (camera.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    scanTimer = requestAnimationFrame(scan);
    return;
  }
  if (frameInFlight) {
    scanTimer = requestAnimationFrame(scan);
    return;
  }
  cameraCanvas.width = camera.videoWidth;
  cameraCanvas.height = camera.videoHeight;
  const context = cameraCanvas.getContext('2d');
  if (!context) return;
  context.drawImage(camera, 0, 0);
  const sourceSize = Math.min(cameraCanvas.width, cameraCanvas.height);
  const cropX = Math.floor((cameraCanvas.width - sourceSize) / 2);
  const cropY = Math.floor((cameraCanvas.height - sourceSize) / 2);
  const image = context.getImageData(cropX, cropY, sourceSize, sourceSize);
  frameInFlight = true;
  frameSentAt = performance.now();
  worker.postMessage({ type: 'frame', pixels: image, width: image.width, height: image.height });
  scanTimer = requestAnimationFrame(scan);
}

function stopReceiver(): void {
  if (scanTimer) cancelAnimationFrame(scanTimer);
  worker?.postMessage({ type: 'stop' });
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  worker?.terminate();
  worker = null;
  frameInFlight = false;
  startButton.textContent = 'Start camera';
}

function resetReceiveState(): void {
  session = 0;
  packetCount = 0;
  blockCount = 0;
  blockSize = 0;
  fileSize = 0;
  fileNameReceived = '';
  fileTypeReceived = 'application/octet-stream';
  metadataReady = false;
  fileBuffer = [];
  receivedPacketsCount = 0;
  totalRequiredPackets = null;
  isTransferComplete = false;
  equations.clear();
  solved.clear();
  scanFrames = 0;
  scanLatencyMs = 0;
  frameInFlight = false;
  transferComplete.hidden = true;
  receiveProgress.textContent = '';
  receiveFileName.textContent = '';
}

fileInput.onchange = async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  transfer = null;
  sendButton.disabled = true;
  fileName.textContent = file.name;
  sendStatus.textContent = 'Preparing fountain blocks...';
  try {
    targetMatrixSize = Number(targetMatrixInput.value);
    transfer = await prepareAztecTransfer(file, targetMatrixSize, (current, total) => { sendStatus.textContent = `Reading file block ${current} of ${total}...`; });
    frameCount.textContent = `${transfer.frameCount} ${transfer.targetMatrixSize}x${transfer.targetMatrixSize} color frames; ${transfer.blockCount} source blocks; 15% repair allowance`;
    sendStatus.textContent = 'Ready - press Send to stream continuously';
    sendButton.disabled = false;
  } catch (error) {
    sendStatus.textContent = error instanceof Error ? error.message : 'Could not prepare file.';
  }
};

sendButton.onclick = async () => {
  if (sending) {
    sending = false;
    return;
  }
  if (!transfer) return;
  sending = true;
  sendButton.textContent = 'Stop';
  let index = 0;
  while (sending) {
    drawAztecFrame(transfer.packets[index], canvas, transfer.targetMatrixSize);
    const dataBits = transfer.packets[index].length * 8;
    const paddedModules = Math.max(0, transfer.targetMatrixSize ** 2 - Math.floor(dataBits / 3));
    const ringCount = Math.floor((transfer.targetMatrixSize - 15) / 2);
    transmitTelemetry.textContent = `${dataBits} data bits | ${paddedModules} padded modules | ${ringCount} rings`;
    sendStatus.textContent = `Streaming frame ${index + 1} of ${transfer.frameCount} continuously`;
    index = (index + 1) % transfer.packets.length;
    const scannerSafeHoldMs = Math.max(90, Math.round(90 * Math.pow(transfer.targetMatrixSize / 63, 1.35)));
    await new Promise<void>((resolve) => window.setTimeout(resolve, scannerSafeHoldMs));
  }
  sendButton.textContent = 'Send';
  sendStatus.textContent = 'Stream stopped; cached fountain packets retained';
};

canvas.addEventListener('click', () => {
  if (sending) sending = false;
});

startButton.onclick = async () => {
  if (stream) {
    stopReceiver();
    receiveStatus.textContent = 'Camera stopped';
    return;
  }
  try {
    targetMatrixSize = Number(targetMatrixInput.value);
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    camera.srcObject = stream;
    await camera.play();
    worker = new Worker(new URL('./decoder.worker.ts', import.meta.url), { type: 'module' });
    resetReceiveState();
    worker.onmessage = (event: MessageEvent<{ type: string; code?: string; packet: Uint8Array; bytes: Uint8Array; name: string; mime: string; unique: number; solved: number; timestamp?: number; counts?: { frames: number; pixels: number; packets: number; invalidPackets: number } }>) => {
      if (event.data.type === 'packet') acceptPacket(event.data.packet);
      if (event.data.type === 'diagnostic') {
        const counts = event.data.counts;
        receiveStatus.textContent = counts
          ? `Scanner: ${event.data.code} (${counts.packets} packets / ${counts.frames} frames)`
          : `Scanner: ${event.data.code}`;
      }
      if (event.data.type === 'frameDone') {
        frameInFlight = false;
        scanFrames += 1;
        scanLatencyMs = frameSentAt > 0 ? performance.now() - frameSentAt : scanLatencyMs;
        const effectiveFps = scanLatencyMs > 0 ? (1000 / scanLatencyMs).toFixed(1) : '0.0';
        receiveProgress.textContent = `Scanner ${effectiveFps} FPS | ${scanLatencyMs.toFixed(0)} ms/frame | ${receivedPacketsCount} packets`;
      }
    };
    session = 0;
    packetCount = 0;
    equations.clear();
    solved.clear();
    metadataReady = false;
    transferComplete.hidden = true;
    receiveStatus.textContent = 'Worker scanner active; searching for color fountain packets';
    startButton.textContent = 'Stop camera';
    worker.postMessage({ type: 'start', targetMatrixSize });
    scan();
  } catch (error) {
    receiveStatus.textContent = error instanceof Error ? error.message : 'Could not start camera. HTTPS is required.';
  }
};

sendTab.onclick = () => setMode('send');
receiveTab.onclick = () => setMode('receive');
setMode('send');
