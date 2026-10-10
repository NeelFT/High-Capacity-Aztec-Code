import { COLORS, FINDER_SIZE, createAztecLayout, readU16, readU32, xorInto } from './aztec';

declare const cv: {
  matFromImageData(image: ImageData): any;
  Mat: new () => any;
  Size: new (width: number, height: number) => any;
  Point: new (x: number, y: number) => any;
  Scalar: new (v0: number, v1: number, v2: number, v3?: number) => any;
  COLOR_RGBA2RGB: number;
  COLOR_RGB2GRAY: number;
  ADAPTIVE_THRESH_GAUSSIAN_C: number;
  THRESH_BINARY: number;
  RETR_LIST: number;
  RETR_TREE: number;
  CHAIN_APPROX_SIMPLE: number;
  INTER_LINEAR: number;
  BORDER_CONSTANT: number;
  matFromArray(rows: number, cols: number, type: number, data: number[]): any;
  CV_32FC2: number;
  cvtColor(source: any, destination: any, code: number): void;
  threshold(source: any, destination: any, threshold: number, maxValue: number, type: number): void;
  adaptiveThreshold(source: any, destination: any, maxValue: number, adaptiveMethod: number, thresholdType: number, blockSize: number, constant: number): void;
  findContours(source: any, contours: any, hierarchy: any, mode: number, method: number): void;
  contourArea(contour: any): number;
  approxPolyDP(curve: any, approxCurve: any, epsilon: number, closed: boolean): void;
  boundingRect(contour: any): { x: number; y: number; width: number; height: number };
  getPerspectiveTransform(source: any, destination: any): any;
  warpPerspective(source: any, destination: any, transform: any, size: any, interpolation: number, borderMode: number, borderValue: any): void;
  MatVector: new () => any;
} | undefined;

interface DecodeMessage {
  type: 'frame' | 'start' | 'stop';
  pixels?: ImageData;
  width?: number;
  height?: number;
  targetMatrixSize?: number;
}

const palette = COLORS.map((hex) => hex.match(/[A-Fa-f0-9]{2}/g)!.map((value) => parseInt(value, 16)));
let lastSession = 0;
let decodedCount = 0;
let running = true;
let blockCount = 0;
let blockSize = 0;
let totalBytes = 0;
let metadata: { name: string; type: string } | null = null;
let targetMatrixSize = 63;
let lastDiagnosticAt = 0;
let diagnosticCounts = { frames: 0, pixels: 0, packets: 0, invalidPackets: 0 };
const equations = new Map<number, { indices: number[]; data: Uint8Array }>();
const solved = new Map<number, Uint8Array>();
const postWorkerMessage = (message: unknown, transfer?: Transferable[]): void => {
  (self as unknown as { postMessage(value: unknown, transfer?: Transferable[]): void }).postMessage(message, transfer);
};

function reportDiagnostic(code: 'FINDER_LOST_NO_CONTOURS' | 'FINDER_LOST_HIERARCHY_FAILED'): void {
  const now = Date.now();
  if (now - lastDiagnosticAt < 500) return;
  lastDiagnosticAt = now;
  postWorkerMessage({ type: 'diagnostic', code, counts: diagnosticCounts });
}

function distance(a: [number, number, number], b: number[]): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

function paddingColorIndex(frameId: number, moduleIndex: number): number {
  let state = (frameId ^ Math.imul(moduleIndex + 1, 0x9e3779b9)) >>> 0;
  state = (Math.imul(state ^ (state >>> 16), 0x45d9f3b) + 0x27100001) >>> 0;
  state ^= state >>> 13;
  return 1 + (state % 7);
}

function sample(image: ImageData, x: number, y: number): [number, number, number] {
  const index = (y * image.width + x) * 4;
  return [image.data[index], image.data[index + 1], image.data[index + 2]];
}

function cropCentered(image: ImageData, scale: number): ImageData {
  const sourceSize = Math.min(image.width, image.height);
  const cropSize = Math.max(32, Math.floor(sourceSize * scale));
  const sourceX = Math.floor((image.width - cropSize) / 2);
  const sourceY = Math.floor((image.height - cropSize) / 2);
  const rgba = new Uint8ClampedArray(cropSize * cropSize * 4);
  for (let y = 0; y < cropSize; y += 1) {
    const sourceRow = sourceY + y;
    for (let x = 0; x < cropSize; x += 1) {
      const sourceColumn = sourceX + x;
      const sourceIndex = (sourceRow * image.width + sourceColumn) * 4;
      const targetIndex = (y * cropSize + x) * 4;
      rgba[targetIndex] = image.data[sourceIndex];
      rgba[targetIndex + 1] = image.data[sourceIndex + 1];
      rgba[targetIndex + 2] = image.data[sourceIndex + 2];
      rgba[targetIndex + 3] = image.data[sourceIndex + 3];
    }
  }
  return new ImageData(rgba, cropSize, cropSize);
}

function findBlackSquare(image: ImageData): ImageData | null {
  const step = Math.max(2, Math.floor(Math.min(image.width, image.height) / 240));
  const isDark = (x: number, y: number): boolean => {
    const index = (y * image.width + x) * 4;
    return image.data[index] < 45 && image.data[index + 1] < 45 && image.data[index + 2] < 45;
  };
  let best: { left: number; top: number; right: number; bottom: number; score: number } | null = null;
  for (let y = 0; y < image.height; y += step) {
    for (let x = 0; x < image.width; x += step) {
      if (!isDark(x, y)) continue;
      const maxWidth = Math.min(image.width - x, image.height - y);
      for (let size = maxWidth; size >= Math.floor(maxWidth * 0.25); size -= Math.max(step * 4, Math.floor(size / 16))) {
        const right = x + size - 1;
        const bottom = y + size - 1;
        if (!isDark(right, y) || !isDark(x, bottom) || !isDark(right, bottom)) continue;
        const sampleCount = Math.max(4, Math.floor(size / 12));
        let dark = 0;
        for (let sample = 0; sample < sampleCount; sample += 1) {
          const offset = Math.floor((sample + 0.5) * size / sampleCount);
          dark += Number(isDark(x + offset, y) && isDark(x + offset, bottom));
          dark += Number(isDark(x, y + offset) && isDark(right, y + offset));
        }
        const score = dark / (sampleCount * 2) * size;
        if (score > (best?.score ?? 0)) best = { left: x, top: y, right, bottom, score };
      }
    }
  }
  if (!best) return null;
  const width = best.right - best.left + 1;
  const rgba = new Uint8ClampedArray(width * width * 4);
  for (let y = 0; y < width; y += 1) {
    const sourceStart = ((best.top + y) * image.width + best.left) * 4;
    rgba.set(image.data.subarray(sourceStart, sourceStart + width * 4), y * width * 4);
  }
  return new ImageData(rgba, width, width);
}

function normalizeWithOpenCv(image: ImageData): ImageData | null {
  if (typeof cv === 'undefined' || !cv) return null;
  let source: any;
  let rgb: any;
  let gray: any;
  let threshed: any;
  let contours: any;
  let hierarchy: any;
  let transform: any;
  let warped: any;
  try {
    source = cv.matFromImageData(image);
    rgb = new cv.Mat();
    gray = new cv.Mat();
    threshed = new cv.Mat();
    contours = new cv.MatVector();
    hierarchy = new cv.Mat();
    cv.cvtColor(source, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
    cv.adaptiveThreshold(gray, threshed, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 11, 2);
    cv.findContours(threshed, contours, hierarchy, cv.RETR_TREE, cv.CHAIN_APPROX_SIMPLE);
    const centerX = image.width / 2;
    const centerY = image.height / 2;
    const candidates: Array<{ x: number; y: number; width: number; height: number }> = [];
    for (let index = 0; index < contours.size(); index += 1) {
      const contour = contours.get(index);
      const rectangle = cv.boundingRect(contour);
      if (rectangle.width >= 12 && rectangle.height >= 12) candidates.push(rectangle);
      contour.delete();
    }
    if (candidates.length === 0) {
      reportDiagnostic('FINDER_LOST_NO_CONTOURS');
      return null;
    }
    const expectedFinderWidth = Math.min(image.width, image.height) * FINDER_SIZE / targetMatrixSize;
    const centered = candidates
      .filter((rectangle) => Math.hypot(rectangle.x + rectangle.width / 2 - centerX, rectangle.y + rectangle.height / 2 - centerY) < image.width * 0.2)
      .sort((a, b) => Math.abs(a.width - expectedFinderWidth) - Math.abs(b.width - expectedFinderWidth));
    let best: { x: number; y: number; width: number; height: number } | null = null;
    let bestHierarchyMatch = false;
    for (const outer of centered) {
      const outerCenterX = outer.x + outer.width / 2;
      const outerCenterY = outer.y + outer.height / 2;
      const nested = centered.filter((inner) => {
        const innerCenterX = inner.x + inner.width / 2;
        const innerCenterY = inner.y + inner.height / 2;
        return inner.width < outer.width * 0.9
          && inner.width > outer.width * 0.25
          && Math.hypot(innerCenterX - outerCenterX, innerCenterY - outerCenterY) < outer.width * 0.08;
      });
      const sizeError = Math.abs(outer.width - expectedFinderWidth) / Math.max(expectedFinderWidth, 1);
      if (sizeError < 1.5 && (!best || (nested.length >= 2 && !bestHierarchyMatch))) {
        best = outer;
        bestHierarchyMatch = nested.length >= 2;
        if (bestHierarchyMatch) break;
      }
    }
    if (!best) {
      reportDiagnostic('FINDER_LOST_HIERARCHY_FAILED');
      return null;
    }
    const finderCenterX = best.x + best.width / 2;
    const finderCenterY = best.y + best.height / 2;
    const halfWidth = best.width * targetMatrixSize / FINDER_SIZE / 2;
    const halfHeight = best.height * targetMatrixSize / FINDER_SIZE / 2;
    const sourcePoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
      finderCenterX - halfWidth, finderCenterY - halfHeight,
      finderCenterX + halfWidth, finderCenterY - halfHeight,
      finderCenterX + halfWidth, finderCenterY + halfHeight,
      finderCenterX - halfWidth, finderCenterY + halfHeight,
    ]);
    const destinationPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0, 0, targetMatrixSize, 0, targetMatrixSize, targetMatrixSize, 0, targetMatrixSize,
    ]);
    transform = cv.getPerspectiveTransform(sourcePoints, destinationPoints);
    warped = new cv.Mat();
    cv.warpPerspective(rgb, warped, transform, new cv.Size(targetMatrixSize, targetMatrixSize), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));
    const rgba = new Uint8ClampedArray(targetMatrixSize * targetMatrixSize * 4);
    for (let index = 0; index < targetMatrixSize * targetMatrixSize; index += 1) {
      rgba[index * 4] = warped.data[index * 3];
      rgba[index * 4 + 1] = warped.data[index * 3 + 1];
      rgba[index * 4 + 2] = warped.data[index * 3 + 2];
      rgba[index * 4 + 3] = 255;
    }
    return new ImageData(rgba, targetMatrixSize, targetMatrixSize);
  } catch {
    return null;
  } finally {
    source?.delete();
    rgb?.delete();
    gray?.delete();
    threshed?.delete();
    contours?.delete();
    hierarchy?.delete();
    transform?.delete();
    warped?.delete();
  }
}

function parsePacket(packet: Uint8Array): { frameId: number; session: number; total: number; count: number; size: number; indices: number[]; data: Uint8Array; metadata: Uint8Array } | null {
  if (packet.length < 25) return null;
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const frameId = readU32(view, 0);
  const total = readU32(view, 4);
  const session = readU32(view, 12);
  const count = readU16(view, 16);
  const size = readU16(view, 18);
  const degree = packet[20];
  if (!count || !size || total < 0 || degree < 1 || degree > count || degree > 24) return null;
  const indices: number[] = [];
  let offset = 21;
  for (let index = 0; index < degree; index += 1) {
    if (offset + 2 > packet.length) return null;
    const block = readU16(view, offset);
    if (block >= count || (index > 0 && block <= indices[index - 1])) return null;
    indices.push(block);
    offset += 2;
  }
  if (offset >= packet.length) return null;
  const metadataLength = packet[offset++];
  if (offset + metadataLength + size > packet.length) return null;
  return { frameId, session, total, count, size, indices, metadata: packet.slice(offset, offset + metadataLength), data: packet.slice(offset + metadataLength, offset + metadataLength + size) };
}

function resetSession(value: number): void {
  lastSession = value;
  decodedCount = 0;
  blockCount = 0;
  blockSize = 0;
  totalBytes = 0;
  equations.clear();
  solved.clear();
  metadata = null;
}

function solve(): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const [frameId, equation] of equations) {
      const unknown = equation.indices.filter((index) => !solved.has(index));
      if (unknown.length === 0) {
        equations.delete(frameId);
      } else if (unknown.length === 1) {
        const result = equation.data.slice();
        for (const index of equation.indices) if (index !== unknown[0]) xorInto(result, solved.get(index)!);
        solved.set(unknown[0], result);
        equations.delete(frameId);
        changed = true;
      }
    }
  }
  if (!metadata || solved.size < blockCount) return;
  const bytes = new Uint8Array(totalBytes);
  for (let index = 0; index < blockCount; index += 1) {
    const length = Math.min(blockSize, bytes.length - index * blockSize);
    bytes.set(solved.get(index)!.subarray(0, length), index * blockSize);
  }
  postWorkerMessage({ type: 'complete', bytes, name: metadata.name, mime: metadata.type, unique: decodedCount, solved: solved.size }, [bytes.buffer] as unknown as Transferable[]);
  running = false;
}

function decodePixels(image: ImageData, useOpenCv = true): Uint8Array | null {
  diagnosticCounts.pixels += 1;
  const layout = createAztecLayout(targetMatrixSize);
  const normalized = useOpenCv ? normalizeWithOpenCv(image) : null;
  const source = normalized ?? image;
  const grid = Math.min(source.width, source.height);
  const originX = Math.floor((source.width - grid) / 2);
  const originY = Math.floor((source.height - grid) / 2);
  const module = grid / targetMatrixSize;
  const references = palette.map((_, index) => sample(source, Math.floor(originX + (index + 3.5) * module), Math.floor(originY + 3.5 * module)));
  const bits: number[] = [];
  for (const [x, y] of layout.dataCoordinates) {
      const color = sample(source, Math.floor(originX + (x + 0.5) * module), Math.floor(originY + (y + 0.5) * module));
      const value = references.reduce((best, ref, index) => distance(color, ref) < distance(color, references[best]) ? index : best, 0);
      bits.push((value >> 2) & 1, (value >> 1) & 1, value & 1);
  }
  const output = new Uint8Array(Math.floor(bits.length / 8));
  for (let index = 0; index < output.length; index += 1) {
    for (let bit = 0; bit < 8; bit += 1) output[index] = (output[index] << 1) | bits[index * 8 + bit];
  }
  if (output.length >= 4) {
    const frameId = new DataView(output.buffer).getUint32(0, true);
    const payloadBits = output.length * 8;
    for (let moduleIndex = Math.floor(payloadBits / 3); moduleIndex < layout.dataCoordinates.length; moduleIndex += 1) {
      paddingColorIndex(frameId, moduleIndex);
    }
  }
  return output.length >= 25 ? output : null;
}

function publish(image: ImageData): void {
  diagnosticCounts.frames += 1;
  let packet: Uint8Array | null = null;
  let parsed: ReturnType<typeof parsePacket> = null;
  const scales = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4];
  for (const scale of scales) {
    const candidate = scale === 1 ? image : cropCentered(image, scale);
    packet = decodePixels(candidate);
    parsed = packet ? parsePacket(packet) : null;
    if (!parsed) {
      packet = decodePixels(candidate, false);
      parsed = packet ? parsePacket(packet) : null;
    }
    if (parsed) break;
  }
  if (!parsed) {
    const located = findBlackSquare(image);
    if (located) {
      packet = decodePixels(located, false);
      parsed = packet ? parsePacket(packet) : null;
    }
  }
  if (!packet || !parsed) {
    diagnosticCounts.invalidPackets += 1;
    reportDiagnostic('FINDER_LOST_HIERARCHY_FAILED');
    return;
  }
  diagnosticCounts.packets += 1;
  if (parsed.session && parsed.session !== lastSession) resetSession(parsed.session);
  if (!lastSession || parsed.session !== lastSession) return;
  if (!blockCount) {
    blockCount = parsed.count;
    blockSize = parsed.size;
    totalBytes = parsed.total;
  }
  if (parsed.count !== blockCount || parsed.size !== blockSize || parsed.total !== totalBytes) return;
  if (!metadata && parsed.metadata[0] === 1) {
    const nameLength = parsed.metadata[1];
    const typeLengthOffset = 2 + nameLength;
    const typeLength = parsed.metadata[typeLengthOffset];
    if (typeLengthOffset + 1 + typeLength <= parsed.metadata.length) {
      metadata = {
        name: new TextDecoder().decode(parsed.metadata.slice(2, typeLengthOffset)),
        type: new TextDecoder().decode(parsed.metadata.slice(typeLengthOffset + 1, typeLengthOffset + 1 + typeLength)),
      };
    }
  }
  if (equations.has(parsed.frameId)) return;
  equations.set(parsed.frameId, { indices: parsed.indices, data: parsed.data });
  solve();
  const view = new DataView(packet.buffer);
  const frameId = readU32(view, 0);
  const headerTotalBytes = readU32(view, 4);
  const seed = readU32(view, 8);
  decodedCount += 1;
  postWorkerMessage({ type: 'packet', packet: packet.slice(), frameId, totalBytes: headerTotalBytes, seed, session: parsed.session, decodedCount, counts: diagnosticCounts });
}

self.onmessage = (event: MessageEvent<DecodeMessage>) => {
  if (event.data.type === 'stop') {
    running = false;
    return;
  }
  if (event.data.type === 'start') {
    targetMatrixSize = event.data.targetMatrixSize ?? 63;
    createAztecLayout(targetMatrixSize);
    running = true;
    return;
  }
  if (event.data.type === 'frame' && event.data.pixels) {
    publish(event.data.pixels);
    postWorkerMessage({ type: 'frameDone', timestamp: performance.now(), counts: diagnosticCounts });
  }
};
