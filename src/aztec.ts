export const FINDER_SIZE = 15;
export const MODULE_PIXELS = 6;
export const COLORS = ['#000000', '#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF', '#00FFFF', '#FFFFFF'] as const;
export const REDUNDANCY = 1.5;
export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_BLOCK_COUNT = 32767;
const HEADER_BYTES = 12;
const PALETTE_Y = 3;
const MAX_BLOCK_SIZE = 30 * 1024;
export const MAX_EQUATION_DEGREE = 24;
const PACKET_FIXED_BYTES = HEADER_BYTES + 4 + 2 + 2 + 1 + 1;
const MAX_METADATA_BYTES = 3 + 120 + 120 + 64;

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

export function colorSymbolMask(moduleIndex: number): number {
  let state = Math.imul(moduleIndex + 1, 0x9e3779b9) >>> 0;
  state = (Math.imul(state ^ (state >>> 16), 0x45d9f3b) + 0x27100001) >>> 0;
  state ^= state >>> 13;
  return state & 0x7;
}

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function encode3BitPayload(payload: Uint8Array): Uint8Array {
  const bitLength = payload.length * 8;
  const symbolCount = Math.ceil(bitLength / 3);
  const symbols = new Uint8Array(symbolCount);
  for (let symbolIndex = 0; symbolIndex < symbolCount; symbolIndex += 1) {
    let value = 0;
    for (let bitOffset = 0; bitOffset < 3; bitOffset += 1) {
      const bitIndex = symbolIndex * 3 + bitOffset;
      if (bitIndex >= bitLength) break;
      const byteIndex = Math.floor(bitIndex / 8);
      const bitInByte = 7 - (bitIndex % 8);
      const bit = (payload[byteIndex] ?? 0) >> bitInByte & 1;
      value |= bit << (2 - bitOffset);
    }
    symbols[symbolIndex] = value & 0x7;
  }
  return symbols;
}

export function decode3BitPayload(symbols: Uint8Array, bitLength: number): Uint8Array {
  const output = new Uint8Array(Math.ceil(bitLength / 8));
  let bitCursor = 0;
  for (const symbol of symbols) {
    for (let bitOffset = 2; bitOffset >= 0; bitOffset -= 1) {
      if (bitCursor >= bitLength) break;
      const bit = (symbol >> bitOffset) & 1;
      const byteIndex = Math.floor(bitCursor / 8);
      const bitInByte = 7 - (bitCursor % 8);
      output[byteIndex] |= bit << bitInByte;
      bitCursor += 1;
    }
  }
  return output;
}

export function decode3BitPacket(symbols: Uint8Array): Uint8Array | null {
  const headerBytes = HEADER_BYTES + 9;
  const headerSymbolCount = Math.ceil(headerBytes * 8 / 3);
  if (symbols.length < headerSymbolCount) return null;

  const header = decode3BitPayload(symbols.subarray(0, headerSymbolCount), headerBytes * 8);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const blockCount = readU16(view, HEADER_BYTES + 4);
  const blockSize = readU16(view, HEADER_BYTES + 6);
  const degree = header[HEADER_BYTES + 8];
  if (!blockCount || !blockSize || degree < 1 || degree > blockCount || degree > MAX_EQUATION_DEGREE) return null;

  const metadataLengthOffset = headerBytes + degree * 2;
  const metadataLengthSymbolCount = Math.ceil((metadataLengthOffset + 1) * 8 / 3);
  if (symbols.length < metadataLengthSymbolCount) return null;
  const metadataHeader = decode3BitPayload(symbols.subarray(0, metadataLengthSymbolCount), (metadataLengthOffset + 1) * 8);
  const metadataLength = metadataHeader[metadataLengthOffset];
  const packetLength = metadataLengthOffset + 1 + metadataLength + blockSize + 4;
  const packetSymbolCount = Math.ceil(packetLength * 8 / 3);
  if (symbols.length < packetSymbolCount) return null;

  const packet = decode3BitPayload(symbols.subarray(0, packetSymbolCount), packetLength * 8);
  const checksumOffset = packetLength - 4;
  if (readU32(new DataView(packet.buffer, packet.byteOffset, packet.byteLength), checksumOffset) !== crc32(packet.subarray(0, checksumOffset))) return null;
  return packet;
}

export function robustSolitonDegree(seed: number, blockCount: number): number {
  const random = seededRandom(seed);
  const safeCount = Math.max(1, Math.floor(blockCount));
  if (safeCount === 1) return 1;
  const c = 0.1;
  const delta = 0.05;
  const r = c * Math.log(safeCount / delta) * Math.sqrt(safeCount);
  const pivot = Math.max(1, Math.min(safeCount, Math.floor(safeCount / r)));
  const maximumDegree = Math.min(safeCount, MAX_EQUATION_DEGREE);
  const weights = new Array<number>(maximumDegree + 1).fill(0);
  for (let degree = 1; degree <= maximumDegree; degree += 1) {
    const ideal = degree === 1 ? 1 / safeCount : 1 / (degree * (degree - 1));
    const robust = degree < pivot
      ? r / (degree * safeCount)
      : degree === pivot && r > delta
        ? r * Math.log(r / delta) / safeCount
        : 0;
    weights[degree] = ideal + robust;
  }
  const total = weights.reduce((sum, value) => sum + value, 0);
  const target = random() * total;
  let running = 0;
  for (let degree = 1; degree <= maximumDegree; degree += 1) {
    running += weights[degree];
    if (target <= running) return Math.min(safeCount, Math.max(1, degree));
  }
  return 1;
}

export function chooseSubset(seed: number, blockCount: number): number[] {
  if (!Number.isInteger(blockCount) || blockCount < 1) throw new Error('Fountain block count must be a positive integer.');
  const random = seededRandom(seed ^ 0xa5a5a5a5);
  const degree = robustSolitonDegree(seed, blockCount);
  const selected = new Set<number>();
  while (selected.size < degree) selected.add(Math.floor(random() * blockCount));
  return [...selected].sort((a, b) => a - b);
}

function highestSetBit(bits: Uint8Array): number {
  for (let byteIndex = bits.length - 1; byteIndex >= 0; byteIndex -= 1) {
    const byte = bits[byteIndex];
    if (!byte) continue;
    for (let bitIndex = 7; bitIndex >= 0; bitIndex -= 1) {
      if ((byte & (1 << bitIndex)) !== 0) return (byteIndex << 3) + bitIndex;
    }
  }
  return -1;
}

function hasBit(bits: Uint8Array, bitIndex: number): boolean {
  if (bitIndex < 0) return false;
  const byteIndex = bitIndex >>> 3;
  if (byteIndex >= bits.length) return false;
  return (bits[byteIndex] & (1 << (bitIndex & 7))) !== 0;
}

function clearBit(bits: Uint8Array, bitIndex: number): void {
  bits[bitIndex >>> 3] &= ~(1 << (bitIndex & 7));
}

function setBit(bits: Uint8Array, bitIndex: number): void {
  bits[bitIndex >>> 3] |= 1 << (bitIndex & 7);
}

function forEachSetBit(bits: Uint8Array, visit: (index: number) => void): void {
  for (let byteIndex = 0; byteIndex < bits.length; byteIndex += 1) {
    let value = bits[byteIndex];
    while (value) {
      const leastSignificantBit = value & -value;
      visit(byteIndex * 8 + 31 - Math.clz32(leastSignificantBit));
      value &= value - 1;
    }
  }
}

function bitCount(bits: Uint8Array): number {
  let count = 0;
  for (const byte of bits) {
    let value = byte;
    while (value) {
      value &= value - 1;
      count += 1;
    }
  }
  return count;
}

function isZero(data: Uint8Array): boolean {
  return data.every((value) => value === 0);
}

interface FountainRow {
  coeffs: Uint8Array;
  data: Uint8Array;
}

export class FountainEquationSolver {
  readonly solved = new Map<number, Uint8Array>();
  private readonly basis = new Map<number, FountainRow>();
  private readonly rowsByIndex = new Map<number, Set<number>>();
  private readonly coeffsLength: number;
  private readonly blockCount: number;
  private readonly blockSize: number;

  constructor(blockCount: number, blockSize: number) {
    if (!Number.isInteger(blockCount) || blockCount < 1 || blockCount > MAX_BLOCK_COUNT) {
      throw new Error('Fountain block count is outside the supported protocol range.');
    }
    if (!Number.isInteger(blockSize) || blockSize < 1 || blockSize > 65535) {
      throw new Error('Fountain block size is outside the supported protocol range.');
    }
    this.blockCount = blockCount;
    this.blockSize = blockSize;
    this.coeffsLength = Math.ceil(blockCount / 8);
  }

  private updateIncidence(rowIndex: number, bitIndex: number, present: boolean): void {
    if (present) {
      let rows = this.rowsByIndex.get(bitIndex);
      if (!rows) {
        rows = new Set<number>();
        this.rowsByIndex.set(bitIndex, rows);
      }
      rows.add(rowIndex);
      return;
    }
    const rows = this.rowsByIndex.get(bitIndex);
    rows?.delete(rowIndex);
    if (rows?.size === 0) this.rowsByIndex.delete(bitIndex);
  }

  private addBasisRow(pivot: number, row: FountainRow): void {
    this.basis.set(pivot, row);
    forEachSetBit(row.coeffs, (index) => this.updateIncidence(pivot, index, true));
  }

  private removeBasisRow(pivot: number, row: FountainRow): void {
    this.basis.delete(pivot);
    forEachSetBit(row.coeffs, (index) => this.updateIncidence(pivot, index, false));
  }

  private xorIncoming(left: Uint8Array, right: Uint8Array): void {
    forEachSetBit(right, (index) => {
      if (hasBit(left, index)) clearBit(left, index);
      else setBit(left, index);
    });
  }

  private xorStored(rowIndex: number, left: Uint8Array, right: Uint8Array): void {
    forEachSetBit(right, (index) => {
      const present = hasBit(left, index);
      if (present) clearBit(left, index);
      else setBit(left, index);
      this.updateIncidence(rowIndex, index, !present);
    });
  }

  addEquation(indices: number[], data: Uint8Array): boolean {
    if (data.length !== this.blockSize || indices.length < 1 || indices.length > MAX_EQUATION_DEGREE) return false;
    const coeffs = new Uint8Array(this.coeffsLength);
    for (const index of indices) {
      if (!Number.isInteger(index) || index < 0 || index >= this.blockCount || hasBit(coeffs, index)) return false;
      coeffs[index >>> 3] |= 1 << (index & 7);
    }
    const row: FountainRow = { coeffs, data: data.slice() };
    for (const index of indices) {
      const solved = this.solved.get(index);
      if (!solved) continue;
      if (hasBit(row.coeffs, index)) {
        clearBit(row.coeffs, index);
        xorInto(row.data, solved);
      }
    }

    let pivot = highestSetBit(row.coeffs);
    while (pivot >= 0) {
      const match = this.basis.get(pivot);
      if (!match) break;
      this.xorIncoming(row.coeffs, match.coeffs);
      xorInto(row.data, match.data);
      pivot = highestSetBit(row.coeffs);
    }
    if (pivot < 0) return isZero(row.data);

    const singletonRows: Array<{ row: FountainRow; pivot: number | null }> = [];
    for (const existingPivot of [...(this.rowsByIndex.get(pivot) ?? [])]) {
      const existing = this.basis.get(existingPivot);
      if (!existing) continue;
      this.xorStored(existingPivot, existing.coeffs, row.coeffs);
      xorInto(existing.data, row.data);
      if (bitCount(existing.coeffs) === 1) singletonRows.push({ row: existing, pivot: existingPivot });
    }
    if (bitCount(row.coeffs) === 1) {
      singletonRows.push({ row, pivot: null });
    } else {
      this.addBasisRow(pivot, row);
    }

    while (singletonRows.length > 0) {
      const current = singletonRows.pop();
      if (!current) continue;
      if (current.pivot !== null) this.removeBasisRow(current.pivot, current.row);
      const solvedIndex = highestSetBit(current.row.coeffs);
      if (solvedIndex < 0) {
        if (!isZero(current.row.data)) return false;
        continue;
      }
      const prior = this.solved.get(solvedIndex);
      if (prior) {
        if (prior.some((value, index) => value !== current.row.data[index])) return false;
        continue;
      }
      const value = current.row.data.slice();
      this.solved.set(solvedIndex, value);
      for (const existingPivot of [...(this.rowsByIndex.get(solvedIndex) ?? [])]) {
        const existing = this.basis.get(existingPivot);
        if (!existing) continue;
        clearBit(existing.coeffs, solvedIndex);
        this.updateIncidence(existingPivot, solvedIndex, false);
        xorInto(existing.data, value);
        const remainingBits = bitCount(existing.coeffs);
        if (remainingBits === 0) {
          this.removeBasisRow(existingPivot, existing);
          if (!isZero(existing.data)) return false;
        } else if (remainingBits === 1) {
          this.removeBasisRow(existingPivot, existing);
          singletonRows.push({ row: existing, pivot: null });
        }
      }
    }
    return true;
  }
}

export function solveFountainEquations(equations: Map<number, { indices: number[]; data: Uint8Array }>, solved: Map<number, Uint8Array>): number {
  if (equations.size === 0) return solved.size;
  const firstEquation = equations.values().next().value as { indices: number[]; data: Uint8Array } | undefined;
  if (!firstEquation) return solved.size;
  let maxIndex = -1;
  for (const equation of equations.values()) {
    for (const index of equation.indices) maxIndex = Math.max(maxIndex, index);
  }
  if (maxIndex < 0) return solved.size;
  const solver = new FountainEquationSolver(maxIndex + 1, firstEquation.data.length);
  for (const equation of equations.values()) solver.addEquation(equation.indices, equation.data);
  for (const [index, data] of solver.solved) solved.set(index, data);
  return solved.size;
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
  const maxDegree = Math.min(MAX_EQUATION_DEGREE, MAX_BLOCK_COUNT);
  const reserved = PACKET_FIXED_BYTES + 4 + maxDegree * 2 + MAX_METADATA_BYTES;
  const available = packetCapacity(layout) - reserved;
  if (available < 64) {
    throw new Error(`Matrix ${layout.targetMatrixSize}x${layout.targetMatrixSize} cannot fit a safe fountain packet. Choose a larger matrix.`);
  }
  return Math.min(MAX_BLOCK_SIZE, available);
}

export function prepareAztecTransfer(file: File, targetMatrixSize: number, onProgress?: (current: number, total: number) => void): Promise<PreparedAztecTransfer> {
  return new Promise(async (resolve, reject) => {
    try {
      if (file.size > MAX_FILE_BYTES) {
        throw new Error(`Files larger than ${MAX_FILE_BYTES / (1024 * 1024)} MiB are not supported.`);
      }
      const layout = createAztecLayout(targetMatrixSize);
      const session = randomU32();
      const blockSize = framePayloadSize(layout);
      const blockCount = Math.max(1, Math.ceil(file.size / blockSize));
      if (blockCount > MAX_BLOCK_COUNT) {
        throw new Error(`This matrix size requires ${blockCount} blocks, above the protocol limit of ${MAX_BLOCK_COUNT}. Choose a larger matrix or smaller file.`);
      }
      const fileBytes = new Uint8Array(await file.arrayBuffer());
      const fileHashHex = await sha256Hex(fileBytes);
      const blocks: Uint8Array[] = [];
      for (let index = 0; index < blockCount; index += 1) {
        const block = new Uint8Array(blockSize);
        block.set(new Uint8Array(fileBytes.subarray(index * blockSize, (index + 1) * blockSize)));
        blocks.push(block);
        onProgress?.(index + 1, blockCount);
      }
      const metadataName = encodeUtf8(file.name);
      const metadataType = encodeUtf8(file.type || 'application/octet-stream');
      const hashBytes = encodeUtf8(fileHashHex.slice(0, 64));
      if (metadataName.length > 120) throw new Error('File name exceeds the 120-byte transfer limit.');
      if (metadataType.length > 120) throw new Error('File type exceeds the 120-byte transfer limit.');
      if (hashBytes.length > 64) throw new Error('File hash is too large for a fountain packet.');
      const packets: Uint8Array[] = [];
      const totalPackets = blockCount + Math.max(1, Math.ceil(blockCount * REDUNDANCY));
      for (let frameId = 0; frameId < totalPackets; frameId += 1) {
        const seed = randomU32();
        const indices = frameId < blockCount ? [frameId] : chooseSubset(seed, blockCount);
        const payload = new Uint8Array(blockSize);
        for (const index of indices) xorInto(payload, blocks[index]);
        const metadata = frameId === 0
          ? new Uint8Array([1, metadataName.length, ...metadataName, metadataType.length, ...metadataType, hashBytes.length, ...hashBytes])
          : new Uint8Array([0]);
        const packetLength = PACKET_FIXED_BYTES + indices.length * 2 + metadata.length + blockSize + 4;
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
        offset += payload.length;
        writeU32(view, offset, crc32(packet.subarray(0, offset)));
        offset += 4;
        if (offset !== packet.length) {
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
  const symbols = encode3BitPayload(packet);
  if (symbols.length > layout.dataCoordinates.length) {
    throw new Error(`Packet requires ${symbols.length} data modules, but the ${targetMatrixSize}x${targetMatrixSize} matrix has room for ${layout.dataCoordinates.length}.`);
  }
  const values = new Uint8Array(layout.dataCoordinates.length);
  for (let index = 0; index < values.length; index += 1) {
    values[index] = ((symbols[index] ?? 0) ^ colorSymbolMask(index)) & 0x7;
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

export { HEADER_BYTES, readU16, readU32, xorInto };
