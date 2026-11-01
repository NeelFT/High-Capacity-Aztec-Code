import { crc32, FountainEquationSolver, MAX_BLOCK_COUNT, MAX_EQUATION_DEGREE, MAX_FILE_BYTES, readU16, readU32, sha256Hex } from './aztec';
import { decodeOpticalFrame } from './image-decoder';
import type { FrameCorners, PixelImage } from './image-decoder';
import { WorkerRequest, WorkerResponse } from './worker-protocol';

let lastSession: number | null = null;
let decodedCount = 0;
let running = false;
let completionSent = false;
let blockCount = 0;
let blockSize = 0;
let totalBytes = 0;
let metadata: { name: string; type: string; hash: string } | null = null;
let targetMatrixSize = 63;
let lastCorners: FrameCorners | null = null;
let lastDiagnosticAt = 0;
const diagnosticCounts = { frames: 0, pixels: 0, packets: 0, invalidPackets: 0 };
const receivedFrames = new Set<number>();
let solver: FountainEquationSolver | null = null;

function postWorkerMessage(message: WorkerResponse, transfer?: Transferable[]): void {
  (self as unknown as { postMessage(value: WorkerResponse, transfer?: Transferable[]): void }).postMessage(message, transfer);
}

function reportDiagnostic(code: string): void {
  const now = Date.now();
  if (now - lastDiagnosticAt < 500) return;
  lastDiagnosticAt = now;
  postWorkerMessage({ type: 'diagnostic', code, counts: { ...diagnosticCounts } });
}

function parsePacket(packet: Uint8Array): { frameId: number; session: number; total: number; count: number; size: number; indices: number[]; data: Uint8Array; metadata: Uint8Array } | null {
  if (packet.length < 29) return null;
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const checksumOffset = packet.length - 4;
  if (readU32(view, checksumOffset) !== crc32(packet.subarray(0, checksumOffset))) return null;
  const frameId = readU32(view, 0);
  const total = readU32(view, 4);
  const session = readU32(view, 12);
  const count = readU16(view, 16);
  const size = readU16(view, 18);
  const degree = packet[20];
  if (!count || count > MAX_BLOCK_COUNT || !size || total > MAX_FILE_BYTES || degree < 1 || degree > count || degree > MAX_EQUATION_DEGREE) return null;
  if (total === 0 ? count !== 1 : count !== Math.ceil(total / size) || total > count * size || total <= (count - 1) * size) return null;

  const indices: number[] = [];
  let offset = 21;
  for (let index = 0; index < degree; index += 1) {
    if (offset + 2 > checksumOffset) return null;
    const blockIndex = readU16(view, offset);
    if (blockIndex >= count || (index > 0 && blockIndex <= indices[index - 1])) return null;
    indices.push(blockIndex);
    offset += 2;
  }
  if (offset >= checksumOffset) return null;
  const metadataLength = packet[offset++];
  if (metadataLength > checksumOffset - offset - size) return null;
  if (offset + metadataLength + size !== checksumOffset) return null;
  return {
    frameId,
    session,
    total,
    count,
    size,
    indices,
    metadata: packet.slice(offset, offset + metadataLength),
    data: packet.slice(offset + metadataLength, checksumOffset),
  };
}

function parseMetadata(value: Uint8Array): { name: string; type: string; hash: string } | null {
  if (value.length < 4 || value[0] !== 1) return null;
  const nameLength = value[1];
  const typeLengthOffset = 2 + nameLength;
  if (nameLength > 120 || typeLengthOffset >= value.length) return null;
  const typeLength = value[typeLengthOffset];
  const hashLengthOffset = typeLengthOffset + 1 + typeLength;
  if (typeLength > 120 || hashLengthOffset + 1 >= value.length) return null;
  const hashLength = value[hashLengthOffset];
  const hashStart = hashLengthOffset + 1;
  if (hashLength !== 64 || hashStart + hashLength !== value.length) return null;
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const name = decoder.decode(value.subarray(2, typeLengthOffset));
    const type = decoder.decode(value.subarray(typeLengthOffset + 1, hashLengthOffset));
    const hash = decoder.decode(value.subarray(hashStart));
    if (!/^[\da-f]{64}$/i.test(hash)) return null;
    return { name, type, hash };
  } catch {
    return null;
  }
}

function resetSession(value: number): void {
  lastSession = value;
  decodedCount = 0;
  blockCount = 0;
  blockSize = 0;
  totalBytes = 0;
  completionSent = false;
  metadata = null;
  receivedFrames.clear();
  solver = null;
}

async function completeIfSolved(): Promise<void> {
  const solved = solver?.solved;
  if (completionSent || !metadata || !solver || !solved || solved.size < blockCount) return;
  for (let index = 0; index < blockCount; index += 1) {
    if (!solved.has(index)) return;
  }
  const bytes = new Uint8Array(totalBytes);
  for (let index = 0; index < blockCount; index += 1) {
    const block = solved.get(index);
    if (!block) return;
    const start = index * blockSize;
    bytes.set(block.subarray(0, Math.min(blockSize, bytes.length - start)), start);
  }
  const actualHash = await sha256Hex(bytes);
  if (actualHash !== metadata.hash) {
    completionSent = true;
    postWorkerMessage({ type: 'error', message: 'Transfer integrity failure: reconstructed file hash mismatch.' });
    return;
  }
  completionSent = true;
  postWorkerMessage({
    type: 'complete',
    bytes,
    name: metadata.name,
    mime: metadata.type,
    expectedHash: metadata.hash,
    verified: true,
    unique: decodedCount,
    solved: solved.size,
  }, [bytes.buffer]);
  running = false;
}

async function publish(image: PixelImage): Promise<void> {
  diagnosticCounts.frames += 1;
  diagnosticCounts.pixels += image.width * image.height;
  if (completionSent) return;
  let decoded = lastCorners ? decodeOpticalFrame(image, targetMatrixSize, lastCorners) : null;
  if (!lastCorners || diagnosticCounts.frames % 5 === 0) {
    const detected = decodeOpticalFrame(image, targetMatrixSize);
    if (detected) decoded = detected;
  }
  if (!decoded) {
    diagnosticCounts.invalidPackets += 1;
    reportDiagnostic('FRAME_NOT_DECODED');
    return;
  }
  lastCorners = decoded.corners;
  const parsed = parsePacket(decoded.packet);
  if (!parsed) {
    diagnosticCounts.invalidPackets += 1;
    reportDiagnostic('PACKET_INVALID_OR_CHECKSUM_FAILED');
    return;
  }
  diagnosticCounts.packets += 1;

  if (lastSession !== null && parsed.session !== lastSession) resetSession(parsed.session);
  if (lastSession === null) resetSession(parsed.session);
  if (parsed.count !== blockCount && blockCount !== 0) return;
  if (parsed.size !== blockSize && blockSize !== 0) return;
  if (parsed.total !== totalBytes && blockCount !== 0) return;
  if (blockCount === 0) {
    blockCount = parsed.count;
    blockSize = parsed.size;
    totalBytes = parsed.total;
  }
  if (parsed.metadata[0] === 1) {
    const parsedMetadata = parseMetadata(parsed.metadata);
    if (!parsedMetadata) {
      reportDiagnostic('TRANSFER_METADATA_INVALID');
      return;
    }
    metadata = parsedMetadata;
  } else if (parsed.metadata.length !== 1 || parsed.metadata[0] !== 0) {
    reportDiagnostic('PACKET_METADATA_INVALID');
    return;
  }
  if (!solver) solver = new FountainEquationSolver(blockCount, blockSize);
  if (receivedFrames.has(parsed.frameId)) return;
  if (!solver.addEquation(parsed.indices, parsed.data)) {
    reportDiagnostic('FOUNTAIN_EQUATION_REJECTED');
    return;
  }
  receivedFrames.add(parsed.frameId);
  decodedCount += 1;
  await completeIfSolved();
  postWorkerMessage({
    type: 'packet',
    frameId: parsed.frameId,
    session: parsed.session,
    decodedCount,
    blockCount,
    solved: solver.solved.size,
    name: metadata?.name,
  });
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  if (event.data.type === 'stop') {
    running = false;
    resetSession(0);
    lastSession = null;
    lastCorners = null;
    return;
  }
  if (event.data.type === 'start') {
    targetMatrixSize = event.data.targetMatrixSize;
    resetSession(0);
    lastSession = null;
    lastCorners = null;
    diagnosticCounts.frames = 0;
    diagnosticCounts.pixels = 0;
    diagnosticCounts.packets = 0;
    diagnosticCounts.invalidPackets = 0;
    running = true;
    return;
  }
  if (event.data.type === 'frame' && event.data.pixels && running) {
    try {
      await publish(event.data.pixels);
    } catch (error) {
      postWorkerMessage({ type: 'error', message: error instanceof Error ? error.message : 'Camera frame processing failed.' });
    } finally {
      postWorkerMessage({ type: 'frameDone', timestamp: performance.now(), counts: { ...diagnosticCounts } });
    }
  }
};
