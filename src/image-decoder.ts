import { COLORS, colorSymbolMask, createAztecLayout, decode3BitPacketDetailed } from './aztec.ts';
import type { AztecLayout } from './aztec.ts';

export interface PixelImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface FramePoint {
  x: number;
  y: number;
}

export type FrameCorners = [FramePoint, FramePoint, FramePoint, FramePoint];

export interface DecoderTrace {
  status: 'candidate-not-found' | 'geometry-failed' | 'orientation-failed' | 'grid-sampling-failed' | 'colour-recognition-failed' | 'header-invalid' | 'crc-failed' | 'packet-decoded';
  candidateCount: number;
  imageWidth: number;
  imageHeight: number;
  geometryCandidates: number;
  orientationFound: boolean;
  gridSampled: boolean;
  recognizedModules: number;
  totalModules: number;
  candidateConfidence: number | null;
  colourConfidence: number | null;
  finderCenter: FramePoint | null;
  finderCorners: FrameCorners | null;
  finderSizeModules: number | null;
  trackedCandidate: boolean;
  headerValid: boolean | null;
  crcValid: boolean | null;
  corners: FrameCorners | null;
  gridLines: Array<[FramePoint, FramePoint]>;
  packet: Uint8Array | null;
  reason: string;
}

type Transform = (x: number, y: number) => FramePoint;
type LabColor = [number, number, number];

const paletteRgb = COLORS.map((color) => [
  parseInt(color.slice(1, 3), 16),
  parseInt(color.slice(3, 5), 16),
  parseInt(color.slice(5, 7), 16),
]);

function isDarkPixel(image: PixelImage, x: number, y: number): boolean {
  const offset = (y * image.width + x) * 4;
  const alpha = image.data[offset + 3] / 255;
  const red = image.data[offset] * alpha + 255 * (1 - alpha);
  const green = image.data[offset + 1] * alpha + 255 * (1 - alpha);
  const blue = image.data[offset + 2] * alpha + 255 * (1 - alpha);
  return red <= 65 && green <= 65 && blue <= 65;
}

function findFrameCandidates(image: PixelImage): FrameCorners[] {
  const step = Math.max(1, Math.floor(Math.min(image.width, image.height) / 480));
  const columns = Math.ceil(image.width / step);
  const rows = Math.ceil(image.height / step);
  const pixelCount = columns * rows;
  const dark = new Uint8Array(pixelCount);
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < columns; x += 1) {
      const sourceX = Math.min(image.width - 1, x * step);
      const sourceY = Math.min(image.height - 1, y * step);
      if (!isDarkPixel(image, sourceX, sourceY)) continue;
      dark[y * columns + x] = 1;
    }
  }

  const queue = new Int32Array(pixelCount);
  const candidates: Array<{ corners: FrameCorners; score: number }> = [];
  for (let start = 0; start < pixelCount; start += 1) {
    if (!dark[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    dark[start] = 0;
    let count = 0;
    let minX = columns;
    let maxX = -1;
    let minY = rows;
    let maxY = -1;
    let minSum = Infinity;
    let maxSum = -Infinity;
    let minDifference = Infinity;
    let maxDifference = -Infinity;
    let topLeft: FramePoint | null = null;
    let topRight: FramePoint | null = null;
    let bottomRight: FramePoint | null = null;
    let bottomLeft: FramePoint | null = null;
    while (head < tail) {
      const current = queue[head++];
      const x = current % columns;
      const y = Math.floor(current / columns);
      count += 1;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      const point = { x: Math.min(image.width - 1, x * step), y: Math.min(image.height - 1, y * step) };
      const sum = x + y;
      const difference = x - y;
      if (sum < minSum) { minSum = sum; topLeft = point; }
      if (difference > maxDifference) { maxDifference = difference; topRight = point; }
      if (sum > maxSum) { maxSum = sum; bottomRight = point; }
      if (difference < minDifference) { minDifference = difference; bottomLeft = point; }
      const left = current - 1;
      if (x > 0 && dark[left]) {
        dark[left] = 0;
        queue[tail++] = left;
      }
      const right = current + 1;
      if (x + 1 < columns && dark[right]) {
        dark[right] = 0;
        queue[tail++] = right;
      }
      const above = current - columns;
      if (y > 0 && dark[above]) {
        dark[above] = 0;
        queue[tail++] = above;
      }
      const below = current + columns;
      if (y + 1 < rows && dark[below]) {
        dark[below] = 0;
        queue[tail++] = below;
      }
    }
    if (!topLeft || !topRight || !bottomRight || !bottomLeft) continue;
    const width = (maxX - minX + 1) * step;
    const height = (maxY - minY + 1) * step;
    const areaRatio = width * height / (image.width * image.height);
    const aspectRatio = width / Math.max(1, height);
    if (Math.min(width, height) < Math.min(image.width, image.height) * 0.02 ||
      areaRatio < 0.005 || areaRatio > 0.98 ||
      aspectRatio < 0.2 || aspectRatio > 5) continue;
    const density = count / Math.max(1, width * height / (step * step));
    candidates.push({
      corners: [topLeft, topRight, bottomRight, bottomLeft],
      score: areaRatio * (1 - Math.min(1, density)),
    });
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, 8).map(({ corners }) => corners);
}

function validateFrameGeometry(image: PixelImage, corners: FrameCorners): string | null {
  const minDimension = Math.min(image.width, image.height);
  for (let index = 0; index < corners.length; index += 1) {
    const current = corners[index];
    const next = corners[(index + 1) % corners.length];
    if (!Number.isFinite(current.x) || !Number.isFinite(current.y) || current.x < 0 || current.y < 0 || current.x >= image.width || current.y >= image.height) {
      return 'Candidate corners fall outside the camera image.';
    }
    if (Math.hypot(current.x - next.x, current.y - next.y) < minDimension * 0.12) {
      return 'Candidate is too small or degenerate to contain a matrix.';
    }
  }
  const area = Math.abs(corners.reduce((sum, point, index) => {
    const next = corners[(index + 1) % corners.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0)) / 2;
  if (area < image.width * image.height * 0.08) return 'Candidate covers less than 8% of the camera image.';
  if (area > image.width * image.height * 0.92) return 'Candidate fills more than 92% of the camera image; the full matrix boundary is not isolated.';
  const centerX = corners.reduce((sum, point) => sum + point.x, 0) / 4;
  const centerY = corners.reduce((sum, point) => sum + point.y, 0) / 4;
  if (Math.abs(centerX - image.width / 2) > image.width * 0.35 || Math.abs(centerY - image.height / 2) > image.height * 0.35) {
    return 'Candidate is too far from the center of the camera image.';
  }
  let crossSign = 0;
  for (let index = 0; index < corners.length; index += 1) {
    const current = corners[index];
    const next = corners[(index + 1) % corners.length];
    const after = corners[(index + 2) % corners.length];
    const cross = (next.x - current.x) * (after.y - next.y) - (next.y - current.y) * (after.x - next.x);
    if (Math.abs(cross) < 1e-6) return 'Candidate edges do not define a stable quadrilateral.';
    if (crossSign !== 0 && Math.sign(cross) !== crossSign) return 'Candidate corners do not form a convex quadrilateral.';
    crossSign = Math.sign(cross);
  }
  return null;
}

function createTransform(corners: FrameCorners, size: number): Transform | null {
  const destinations = [
    { x: 0, y: 0 },
    { x: size, y: 0 },
    { x: size, y: size },
    { x: 0, y: size },
  ];
  const matrix: number[][] = [];
  for (let index = 0; index < 4; index += 1) {
    const { x, y } = destinations[index];
    const { x: sourceX, y: sourceY } = corners[index];
    matrix.push([x, y, 1, 0, 0, 0, -sourceX * x, -sourceX * y, sourceX]);
    matrix.push([0, 0, 0, x, y, 1, -sourceY * x, -sourceY * y, sourceY]);
  }

  for (let column = 0; column < 8; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 8; row += 1) {
      if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) pivot = row;
    }
    if (Math.abs(matrix[pivot][column]) < 1e-10) return null;
    [matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]];
    const divisor = matrix[column][column];
    for (let entry = column; entry <= 8; entry += 1) matrix[column][entry] /= divisor;
    for (let row = 0; row < 8; row += 1) {
      if (row === column) continue;
      const factor = matrix[row][column];
      for (let entry = column; entry <= 8; entry += 1) matrix[row][entry] -= factor * matrix[column][entry];
    }
  }

  const [a, b, c, d, e, f, g, h] = matrix.map((row) => row[8]);
  return (x, y) => {
    const denominator = g * x + h * y + 1;
    return {
      x: (a * x + b * y + c) / denominator,
      y: (d * x + e * y + f) / denominator,
    };
  };
}

function averageColor(image: PixelImage, transform: Transform, cellX: number, cellY: number): [number, number, number] {
  let red = 0;
  let green = 0;
  let blue = 0;
  for (const offsetY of [0.32, 0.68]) {
    for (const offsetX of [0.32, 0.68]) {
      const point = transform(cellX + offsetX, cellY + offsetY);
      const x = Math.max(0, Math.min(image.width - 1, Math.round(point.x)));
      const y = Math.max(0, Math.min(image.height - 1, Math.round(point.y)));
      const offset = (y * image.width + x) * 4;
      red += image.data[offset];
      green += image.data[offset + 1];
      blue += image.data[offset + 2];
    }
  }
  return [red / 4, green / 4, blue / 4];
}

function rgbToLab([red, green, blue]: [number, number, number]): LabColor {
  const linearize = (value: number): number => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  const r = linearize(red);
  const g = linearize(green);
  const b = linearize(blue);
  const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
  const z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883;
  const transform = (value: number): number => value > 0.008856451679 ? Math.cbrt(value) : 7.787037037 * value + 16 / 116;
  const fx = transform(x);
  const fy = transform(y);
  const fz = transform(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function nearestPaletteColor(color: [number, number, number], referenceLabs: LabColor[]): { index: number; nearest: number; margin: number } {
  const sampleLab = rgbToLab(color);
  let bestIndex = -1;
  let nearest = Infinity;
  let secondNearest = Infinity;
  for (let index = 0; index < referenceLabs.length; index += 1) {
    const reference = referenceLabs[index];
    const distance = Math.hypot(sampleLab[0] - reference[0], sampleLab[1] - reference[1], sampleLab[2] - reference[2]);
    if (distance < nearest) {
      secondNearest = nearest;
      nearest = distance;
      bestIndex = index;
    } else if (distance < secondNearest) {
      secondNearest = distance;
    }
  }
  return { index: bestIndex, nearest, margin: secondNearest - nearest };
}

function makeGridLines(transform: Transform, size: number): Array<[FramePoint, FramePoint]> {
  const lines: Array<[FramePoint, FramePoint]> = [];
  for (let division = 0; division <= 8; division += 1) {
    const position = size * division / 8;
    lines.push([transform(position, 0), transform(position, size)]);
    lines.push([transform(0, position), transform(size, position)]);
  }
  return lines;
}

function candidateOrientations(candidate: FrameCorners): FrameCorners[] {
  const orientations: FrameCorners[] = [];
  for (const direction of [1, -1]) {
    for (let start = 0; start < 4; start += 1) {
      orientations.push(Array.from({ length: 4 }, (_, offset) => candidate[(start + direction * offset + 8) % 4]) as FrameCorners);
    }
  }
  return orientations;
}

function decodeCandidate(image: PixelImage, layout: AztecLayout, corners: FrameCorners): DecoderTrace {
  const base: DecoderTrace = {
    status: 'geometry-failed',
    candidateCount: 1,
    imageWidth: image.width,
    imageHeight: image.height,
    geometryCandidates: 0,
    orientationFound: false,
    gridSampled: false,
    recognizedModules: 0,
    totalModules: layout.dataCoordinates.length,
    candidateConfidence: null,
    colourConfidence: null,
    finderCenter: null,
    finderCorners: null,
    finderSizeModules: null,
    trackedCandidate: false,
    headerValid: null,
    crcValid: null,
    corners,
    gridLines: [],
    packet: null,
    reason: '',
  };
  const geometryError = validateFrameGeometry(image, corners);
  if (geometryError) {
    base.reason = geometryError;
    return base;
  }
  const transform = createTransform(corners, layout.targetMatrixSize);
  if (!transform) {
    base.reason = 'Perspective transform could not be calculated from the candidate corners.';
    return base;
  }
  base.geometryCandidates = 1;
  base.gridLines = makeGridLines(transform, layout.targetMatrixSize);
  const finderEnd = layout.finderStart + layout.finderSize;
  base.finderCenter = transform(layout.finderCenter + 0.5, layout.finderCenter + 0.5);
  base.finderCorners = [
    transform(layout.finderStart, layout.finderStart),
    transform(finderEnd, layout.finderStart),
    transform(finderEnd, finderEnd),
    transform(layout.finderStart, finderEnd),
  ];
  base.finderSizeModules = layout.finderSize;
  const references = paletteRgb.map((_, index) => averageColor(image, transform, index + 3, 3));
  const referenceLabs = references.map((reference) => rgbToLab(reference));
  const structural = [...layout.alignmentCoordinates];
  let matched = 0;
  for (const coordinate of structural) {
    const [x, y] = coordinate.split(',').map(Number);
    const expectedColor = layout.grid[y][x];
    if (!expectedColor) continue;
    const expectedIndex = COLORS.indexOf(expectedColor as typeof COLORS[number]);
    if (expectedIndex < 0) continue;
    const classified = nearestPaletteColor(averageColor(image, transform, x, y), referenceLabs);
    if (classified.index === expectedIndex && classified.nearest < 55 && classified.margin > 2) matched += 1;
  }
  const structuralRatio = structural.length === 0 ? 0 : matched / structural.length;
  base.candidateConfidence = structuralRatio * 100;
  if (structuralRatio < 0.68) {
    base.status = 'orientation-failed';
    base.reason = `Finder/alignment markers matched ${matched} of ${structural.length} (${(structuralRatio * 100).toFixed(1)}%); 68% is required.`;
    base.colourConfidence = structuralRatio * 100;
    return base;
  }
  base.orientationFound = true;

  const symbols = new Uint8Array(layout.dataCoordinates.length);
  let recognizedModules = 0;
  let totalMargin = 0;
  let firstRejected: { x: number; y: number; distance: number; margin: number } | null = null;
  for (let index = 0; index < layout.dataCoordinates.length; index += 1) {
    const [x, y] = layout.dataCoordinates[index];
    const classified = nearestPaletteColor(averageColor(image, transform, x, y), referenceLabs);
    totalMargin += Math.max(0, classified.margin);
    if (classified.nearest > 45 || classified.margin < 4) {
      firstRejected ??= { x, y, distance: classified.nearest, margin: classified.margin };
    } else {
      recognizedModules += 1;
    }
    symbols[index] = classified.index ^ colorSymbolMask(index);
  }
  base.gridSampled = true;
  base.recognizedModules = recognizedModules;
  base.colourConfidence = totalMargin / Math.max(1, layout.dataCoordinates.length);
  if (firstRejected) {
    base.status = 'colour-recognition-failed';
    base.reason = `Module (${firstRejected.x}, ${firstRejected.y}) is ambiguous: ΔE ${firstRejected.distance.toFixed(1)}, palette margin ${firstRejected.margin.toFixed(1)}; thresholds are 45 and 4.`;
    return base;
  }

  const decoded = decode3BitPacketDetailed(symbols);
  base.headerValid = decoded.headerValid;
  base.crcValid = decoded.crcValid;
  base.packet = decoded.packet;
  base.status = decoded.status === 'crc-failed' ? 'crc-failed' : decoded.status === 'header-invalid' ? 'header-invalid' : 'packet-decoded';
  base.reason = decoded.reason ?? 'Packet decoded and CRC32 verified.';
  return base;
}

export interface OpticalFrameResult {
  packet: Uint8Array;
  corners: FrameCorners;
}

export function decodeOpticalFrameDetailed(image: PixelImage, targetMatrixSize: number, trackedCorners?: FrameCorners | null): DecoderTrace {
  const layout = createAztecLayout(targetMatrixSize);
  if (trackedCorners) {
    const trackedTrace = decodeCandidate(image, layout, trackedCorners);
    trackedTrace.trackedCandidate = true;
    trackedTrace.candidateCount = 0;
    if (trackedTrace.geometryCandidates && trackedTrace.orientationFound) return trackedTrace;
  }
  const detectedCandidates = findFrameCandidates(image);
  const candidates = detectedCandidates.map((corners) => ({ corners, tracked: false }));
  if (trackedCorners && !detectedCandidates.some((candidate) => candidate.every((point, index) =>
    Math.hypot(point.x - trackedCorners[index].x, point.y - trackedCorners[index].y) < 3))) {
    candidates.push({ corners: trackedCorners, tracked: true });
  }
  if (candidates.length === 0) {
    return {
      status: 'candidate-not-found',
      candidateCount: 0,
      imageWidth: image.width,
      imageHeight: image.height,
      geometryCandidates: 0,
      orientationFound: false,
      gridSampled: false,
      recognizedModules: 0,
      totalModules: layout.dataCoordinates.length,
      candidateConfidence: null,
      colourConfidence: null,
      finderCenter: null,
      finderCorners: null,
      finderSizeModules: null,
      trackedCandidate: false,
      headerValid: null,
      crcValid: null,
      corners: null,
      gridLines: [],
      packet: null,
      reason: 'No square dark frame boundary was found in the camera image.',
    };
  }
  const candidateCount = detectedCandidates.length;
  let best: DecoderTrace | null = null;
  for (const candidate of candidates) {
    for (const corners of candidateOrientations(candidate.corners)) {
      const trace = decodeCandidate(image, layout, corners);
      trace.candidateCount = candidateCount;
      trace.trackedCandidate = candidate.tracked;
      if (!best || trace.geometryCandidates > best.geometryCandidates ||
        (trace.orientationFound && !best.orientationFound) ||
        (trace.gridSampled && !best.gridSampled) ||
        trace.recognizedModules > best.recognizedModules) {
        best = trace;
      }
      if (trace.status === 'packet-decoded') return trace;
    }
  }
  if (best) return best;
  return {
    status: 'candidate-not-found',
    candidateCount: 0,
    imageWidth: image.width,
    imageHeight: image.height,
    geometryCandidates: 0,
    orientationFound: false,
    gridSampled: false,
    recognizedModules: 0,
    totalModules: layout.dataCoordinates.length,
    candidateConfidence: null,
    colourConfidence: null,
    finderCenter: null,
    finderCorners: null,
    finderSizeModules: null,
    trackedCandidate: false,
    headerValid: null,
    crcValid: null,
    corners: null,
    gridLines: [],
    packet: null,
    reason: 'No valid matrix orientation was found.',
  };
}

export function decodeOpticalFrame(image: PixelImage, targetMatrixSize: number, trackedCorners?: FrameCorners | null): (OpticalFrameResult & { trace?: DecoderTrace }) | null {
  const trace = decodeOpticalFrameDetailed(image, targetMatrixSize, trackedCorners);
  if (!trace.packet || !trace.corners) return null;
  return { packet: trace.packet, corners: trace.corners, trace };
}
