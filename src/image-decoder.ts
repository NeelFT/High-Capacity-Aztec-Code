import { COLORS, colorSymbolMask, createAztecLayout, decode3BitPacket } from './aztec.ts';
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

type Transform = (x: number, y: number) => FramePoint;
type LabColor = [number, number, number];

const paletteRgb = COLORS.map((color) => [
  parseInt(color.slice(1, 3), 16),
  parseInt(color.slice(3, 5), 16),
  parseInt(color.slice(5, 7), 16),
]);

function findFrameCorners(image: PixelImage): FrameCorners | null {
  const step = Math.max(1, Math.floor(Math.min(image.width, image.height) / 480));
  let topLeft: FramePoint | null = null;
  let topRight: FramePoint | null = null;
  let bottomRight: FramePoint | null = null;
  let bottomLeft: FramePoint | null = null;
  let minSum = Infinity;
  let maxSum = -Infinity;
  let minDifference = Infinity;
  let maxDifference = -Infinity;

  for (let y = 0; y < image.height; y += step) {
    for (let x = 0; x < image.width; x += step) {
      const offset = (y * image.width + x) * 4;
      if (image.data[offset] > 65 || image.data[offset + 1] > 65 || image.data[offset + 2] > 65) continue;
      const sum = x + y;
      const difference = x - y;
      if (sum < minSum) {
        minSum = sum;
        topLeft = { x, y };
      }
      if (difference > maxDifference) {
        maxDifference = difference;
        topRight = { x, y };
      }
      if (sum > maxSum) {
        maxSum = sum;
        bottomRight = { x, y };
      }
      if (difference < minDifference) {
        minDifference = difference;
        bottomLeft = { x, y };
      }
    }
  }

  if (!topLeft || !topRight || !bottomRight || !bottomLeft) return null;
  const corners = [topLeft, topRight, bottomRight, bottomLeft] as const;
  const minDimension = Math.min(image.width, image.height);
  for (let index = 0; index < corners.length; index += 1) {
    const current = corners[index];
    const next = corners[(index + 1) % corners.length];
    if (Math.hypot(current.x - next.x, current.y - next.y) < minDimension * 0.12) return null;
  }
  const area = Math.abs(corners.reduce((sum, point, index) => {
    const next = corners[(index + 1) % corners.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0)) / 2;
  if (area < image.width * image.height * 0.08) return null;
  const centerX = corners.reduce((sum, point) => sum + point.x, 0) / 4;
  const centerY = corners.reduce((sum, point) => sum + point.y, 0) / 4;
  if (Math.abs(centerX - image.width / 2) > image.width * 0.35 || Math.abs(centerY - image.height / 2) > image.height * 0.35) return null;
  return [...corners];
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

function decodeCandidate(image: PixelImage, layout: AztecLayout, corners: FrameCorners): Uint8Array | null {
  const transform = createTransform(corners, layout.targetMatrixSize);
  if (!transform) return null;
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
  if (structural.length === 0 || matched / structural.length < 0.68) return null;

  const symbols = new Uint8Array(layout.dataCoordinates.length);
  for (let index = 0; index < layout.dataCoordinates.length; index += 1) {
    const [x, y] = layout.dataCoordinates[index];
    const classified = nearestPaletteColor(averageColor(image, transform, x, y), referenceLabs);
    if (classified.nearest > 45 || classified.margin < 4) return null;
    symbols[index] = classified.index ^ colorSymbolMask(index);
  }
  return decode3BitPacket(symbols);
}

export function decodeOpticalFrame(image: PixelImage, targetMatrixSize: number, trackedCorners?: FrameCorners | null): { packet: Uint8Array; corners: FrameCorners } | null {
  const layout = createAztecLayout(targetMatrixSize);
  const initialCorners = trackedCorners ?? findFrameCorners(image);
  if (!initialCorners) return null;
  const candidates: FrameCorners[] = [];
  for (let direction of [1, -1]) {
    for (let start = 0; start < 4; start += 1) {
      candidates.push(Array.from({ length: 4 }, (_, offset) => initialCorners[(start + direction * offset + 8) % 4]) as FrameCorners);
    }
  }
  for (const corners of candidates) {
    const packet = decodeCandidate(image, layout, corners);
    if (packet) return { packet, corners };
  }
  return null;
}
