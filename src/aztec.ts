export const FINDER_SIZE = 15;
export const MODULE_PIXELS = 6;
export const COLORS = ['#000000', '#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF', '#00FFFF', '#FFFFFF'] as const;
export const REDUNDANCY = 0.15;
const HEADER_BYTES = 12;
const PALETTE_Y = 3;
const MAX_BLOCK_SIZE = 30 * 1024;
const PACKET_FIXED_BYTES = HEADER_BYTES + 4 + 2 + 2 + 1 + 1;

export interface AztecLayout {
  targetMatrixSize: number;
  frameSize: number;
  dataCoordinates: Array<[number, number]>;
  alignmentCoordinates: Set<string>;
  grid: Array<Array<string | null>>;
}

export interface StreamPacket {
  frameId: number;
  totalBytes: number;
  seed: number;
  session: number;
  blockCount: number;
  blockSize: number;
  indices: number[];
  payload: Uint8Array;
  metadata?: { name: string; type: string };
}

export interface PreparedAztecTransfer {
  file: File;
  session: number;
  totalBytes: number;
  blockCount: number;
  blockSize: number;
  packets: Uint8Array[];
  frameCount: number;
  targetMatrixSize: number;
}

function randomU32(): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0];
}

function writeU32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function writeU16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

function readU16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function xorInto(target: Uint8Array, source: Uint8Array): void {
  for (let index = 0; index < target.length; index += 1) target[index] ^= source[index] ?? 0;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state ^ (state >>> 16), 0x45d9f3b) + 0x27100001) >>> 0;
    state ^= state >>> 13;
    return (state >>> 0) / 0x100000000;
  };
}

function paddingColorIndex(frameId: number, moduleIndex: number): number {
  let state = (frameId ^ Math.imul(moduleIndex + 1, 0x9e3779b9)) >>> 0;
  state = (Math.imul(state ^ (state >>> 16), 0x45d9f3b) + 0x27100001) >>> 0;
  state ^= state >>> 13;
  return 1 + (state % 7);
}

function chooseSubset(seed: number, blockCount: number): number[] {
  const random = seededRandom(seed);
  const degree = Math.min(blockCount, Math.max(1, Math.floor(1 + Math.pow(random(), 2) * Math.min(24, blockCount))));
  const selected = new Set<number>();
  while (selected.size < degree) selected.add(Math.floor(random() * blockCount));
  return [...selected].sort((a, b) => a - b);
}

function validateMatrixSize(targetMatrixSize: number): number {
  if (!Number.isInteger(targetMatrixSize) || targetMatrixSize < FINDER_SIZE + 16 || targetMatrixSize > 999 || targetMatrixSize % 2 === 0) {
    throw new Error('The matrix size must be an odd integer from 31 through 999.');
  }
  return targetMatrixSize;
}

export function createAztecLayout(targetMatrixSize: number): AztecLayout {
  const size = validateMatrixSize(targetMatrixSize);
  const center = Math.floor(size / 2);
  const finderStart = center - Math.floor(FINDER_SIZE / 2);
  const grid: Array<Array<string | null>> = Array.from({ length: size }, () => Array<string | null>(size).fill(null));
  const alignmentCoordinates = new Set<string>();
  const setStructural = (x: number, y: number, color: string): void => {
    if (x >= 0 && x < size && y >= 0 && y < size) {
      grid[y][x] = color;
      alignmentCoordinates.add(`${x},${y}`);
    }
  };
  for (let edge = 0; edge < 3; edge += 1) {
    for (let index = 0; index < size; index += 1) {
      setStructural(index, edge, '#000000');
      setStructural(index, size - 1 - edge, '#000000');
      setStructural(edge, index, '#000000');
      setStructural(size - 1 - edge, index, '#000000');
    }
  }
  for (let y = finderStart; y < finderStart + FINDER_SIZE; y += 1) {
    for (let x = finderStart; x < finderStart + FINDER_SIZE; x += 1) {
      const edge = Math.min(x - finderStart, y - finderStart, finderStart + FINDER_SIZE - 1 - x, finderStart + FINDER_SIZE - 1 - y);
      setStructural(x, y, edge % 2 === 0 || (x === center && y === center) ? '#000000' : '#FFFFFF');
    }
  }
  const alignmentTrack = [10, size - 11];
  for (const row of alignmentTrack) {
    for (let x = 3; x < size - 3; x += 1) setStructural(x, row, x % 2 === 0 ? '#FFFFFF' : '#000000');
  }
  for (const column of alignmentTrack) {
    for (let y = 3; y < size - 3; y += 1) setStructural(column, y, y % 2 === 0 ? '#FFFFFF' : '#000000');
  }
  for (let x = 0; x < COLORS.length; x += 1) setStructural(x + 3, PALETTE_Y, COLORS[x]);
  for (let layer = 16; finderStart - layer >= 0 && finderStart + FINDER_SIZE - 1 + layer < size; layer += 16) {
    const radius = Math.floor(FINDER_SIZE / 2) + layer;
    for (let offset = -radius; offset <= radius; offset += 1) {
      setStructural(center + offset, center - radius, (center + offset) % 2 === 0 ? '#FFFFFF' : '#000000');
      setStructural(center + radius, center + offset, (center + offset) % 2 === 0 ? '#FFFFFF' : '#000000');
      setStructural(center - offset, center + radius, (center + offset) % 2 === 0 ? '#FFFFFF' : '#000000');
      setStructural(center - radius, center - offset, (center + offset) % 2 === 0 ? '#FFFFFF' : '#000000');
    }
  }
  const dataCoordinates: Array<[number, number]> = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const onPerimeter = x === 0 || y === 0 || x === size - 1 || y === size - 1;
      if (!onPerimeter && grid[y][x] === null) dataCoordinates.push([x, y]);
    }
  }
  return { targetMatrixSize: size, frameSize: size * MODULE_PIXELS, dataCoordinates, alignmentCoordinates, grid };
}

function packetCapacity(layout: AztecLayout): number {
  return Math.floor((layout.dataCoordinates.length * 3) / 8);
}

function framePayloadSize(layout: AztecLayout): number {
  const maxDegree = 24;
  const metadataReserve = 2 + 120 + 1 + 120;
  const reserved = PACKET_FIXED_BYTES + maxDegree * 2 + metadataReserve;
  const available = packetCapacity(layout) - reserved;
  if (available < 64) {
    throw new Error(`Matrix ${layout.targetMatrixSize}x${layout.targetMatrixSize} cannot fit a safe fountain packet. Choose a larger matrix.`);
  }
  return Math.min(MAX_BLOCK_SIZE, available);
}

export function prepareAztecTransfer(file: File, targetMatrixSize: number, onProgress?: (current: number, total: number) => void): Promise<PreparedAztecTransfer> {
  return new Promise(async (resolve, reject) => {
    try {
      const layout = createAztecLayout(targetMatrixSize);
      const session = randomU32();
      const blockSize = framePayloadSize(layout);
      const blockCount = Math.max(1, Math.ceil(file.size / blockSize));
      const blocks: Uint8Array[] = [];
      for (let index = 0; index < blockCount; index += 1) {
        const block = new Uint8Array(blockSize);
        block.set(new Uint8Array(await file.slice(index * blockSize, (index + 1) * blockSize).arrayBuffer()));
        blocks.push(block);
        onProgress?.(index + 1, blockCount);
      }
      const metadataName = encodeUtf8(file.name.slice(0, 120));
      const metadataType = encodeUtf8((file.type || 'application/octet-stream').slice(0, 120));
      if (metadataName.length > 120 || metadataType.length > 120) {
        throw new Error('File metadata is too large for a fountain packet.');
      }
      const packets: Uint8Array[] = [];
      const totalPackets = blockCount + Math.max(1, Math.ceil(blockCount * REDUNDANCY));
      for (let frameId = 0; frameId < totalPackets; frameId += 1) {
        const seed = randomU32();
        const indices = frameId < blockCount ? [frameId] : chooseSubset(seed, blockCount);
        const payload = new Uint8Array(blockSize);
        for (const index of indices) xorInto(payload, blocks[index]);
        const metadata = frameId === 0
          ? new Uint8Array([1, metadataName.length, ...metadataName, metadataType.length, ...metadataType])
          : new Uint8Array([0]);
        const packetLength = PACKET_FIXED_BYTES + indices.length * 2 + metadata.length + blockSize;
        const packet = new Uint8Array(packetLength);
        const view = new DataView(packet.buffer);
        writeU32(view, 0, frameId);
        writeU32(view, 4, file.size);
        writeU32(view, 8, seed);
        writeU32(view, HEADER_BYTES, session);
        writeU16(view, HEADER_BYTES + 4, blockCount);
        writeU16(view, HEADER_BYTES + 6, blockSize);
        packet[HEADER_BYTES + 8] = indices.length;
        let offset = HEADER_BYTES + 9;
        for (const index of indices) {
          writeU16(view, offset, index);
          offset += 2;
        }
        packet[offset++] = metadata.length;
        packet.set(metadata, offset);
        offset += metadata.length;
        packet.set(payload, offset);
        if (offset + payload.length !== packet.length) {
          throw new Error('Fountain packet layout calculation failed.');
        }
        packets.push(packet);
      }
      resolve({ file, session, totalBytes: file.size, blockCount, blockSize, packets, frameCount: packets.length, targetMatrixSize: layout.targetMatrixSize });
    } catch (error) {
      reject(error);
    }
  });
}

function isFinder(x: number, y: number, targetMatrixSize: number): boolean {
  const start = Math.floor((targetMatrixSize - FINDER_SIZE) / 2);
  const localX = x - start;
  const localY = y - start;
  if (localX < 0 || localY < 0 || localX >= FINDER_SIZE || localY >= FINDER_SIZE) return false;
  const edge = Math.min(localX, localY, FINDER_SIZE - 1 - localX, FINDER_SIZE - 1 - localY);
  return edge % 2 === 0 || (edge === 6 && localX >= 4 && localX <= 10 && localY >= 4 && localY <= 10);
}

function isPalette(x: number, y: number): boolean {
  return y === PALETTE_Y && x < COLORS.length;
}

export function drawAztecFrame(packet: Uint8Array, canvas: HTMLCanvasElement, targetMatrixSize: number): void {
  const layout = createAztecLayout(targetMatrixSize);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas rendering is unavailable.');
  canvas.width = layout.frameSize;
  canvas.height = layout.frameSize;
  const bits: number[] = [];
  for (const byte of packet) for (let bit = 7; bit >= 0; bit -= 1) bits.push((byte >> bit) & 1);
  const values = new Uint8Array(layout.dataCoordinates.length);
  const packetBitLength = bits.length;
  const frameId = packet.length >= 4 ? new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint32(0, true) : 0;
  for (let index = 0; index < values.length; index += 1) {
    const byteOffset = Math.floor(index * 3 / 8);
    const bitOffset = (index * 3) % 8;
    const firstBit = byteOffset * 8 + bitOffset;
    if (firstBit >= packetBitLength) {
      values[index] = paddingColorIndex(frameId, index);
      continue;
    }
    let value = 0;
    let complete = true;
    for (let bit = 0; bit < 3; bit += 1) {
      const sourceBit = firstBit + bit;
      if (sourceBit >= packetBitLength) {
        complete = false;
        break;
      }
      value = (value << 1) | bits[sourceBit];
    }
    values[index] = complete ? Math.max(0, Math.min(7, value)) : paddingColorIndex(frameId, index);
  }
  const draw = (x: number, y: number, color: string) => {
    context.fillStyle = color;
    context.fillRect(x * MODULE_PIXELS, y * MODULE_PIXELS, MODULE_PIXELS, MODULE_PIXELS);
  };
  context.fillStyle = '#FFFFFF';
  context.fillRect(0, 0, layout.frameSize, layout.frameSize);
  for (let y = 0; y < layout.targetMatrixSize; y += 1) {
    for (let x = 0; x < layout.targetMatrixSize; x += 1) {
      const structural = layout.grid[y][x];
      if (structural !== null) draw(x, y, structural);
    }
  }
  for (let index = 0; index < layout.dataCoordinates.length; index += 1) {
    const [x, y] = layout.dataCoordinates[index];
    if (x < 1 || x >= layout.targetMatrixSize - 1 || y < 1 || y >= layout.targetMatrixSize - 1) continue;
    draw(x, y, COLORS[values[index]]);
  }
  context.fillStyle = '#000000';
  context.fillRect(0, 0, layout.frameSize, 3);
  context.fillRect(0, layout.frameSize - 3, layout.frameSize, 3);
  context.fillRect(0, 0, 3, layout.frameSize);
  context.fillRect(layout.frameSize - 3, 0, 3, layout.frameSize);
  context.imageSmoothingEnabled = false;
}

export { HEADER_BYTES, readU16, readU32, xorInto, chooseSubset };
