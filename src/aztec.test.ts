import assert from 'node:assert/strict';
import test from 'node:test';

import { COLORS, colorSymbolMask, createAztecLayout, crc32, decode3BitPacket, decode3BitPayload, drawAztecFrame, encode3BitPayload, EVEN_FINDER_SIZE, FINDER_RING_THICKNESS, FINDER_SIZE, FountainEquationSolver, MAX_FILE_BYTES, MODULE_PIXELS, prepareAztecTransfer, QUIET_ZONE_MODULES, renderAztecFrameMatrix, sha256Hex, solveFountainEquations } from './aztec.ts';
import { decodeOpticalFrame, decodeOpticalFrameDetailed } from './image-decoder.ts';
import type { PixelImage } from './image-decoder.ts';

function makePayload(length: number, seed: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = (index * 37 + seed) & 0xff;
  }
  return bytes;
}

function makeRenderedImage(packet: Uint8Array, matrixSize: number): PixelImage {
  const layout = createAztecLayout(matrixSize);
  const matrix = renderAztecFrameMatrix(packet, matrixSize);
  const modulePixels = 6;
  const width = layout.frameSize;
  const data = new Uint8ClampedArray(width * width * 4);
  data.fill(255);
  const rgb = COLORS.map((color) => [
    parseInt(color.slice(1, 3), 16),
    parseInt(color.slice(3, 5), 16),
    parseInt(color.slice(5, 7), 16),
  ]);
  for (let y = 0; y < width; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const matrixX = Math.floor((x - layout.matrixOffset) / modulePixels);
      const matrixY = Math.floor((y - layout.matrixOffset) / modulePixels);
      if (matrixX < 0 || matrixX >= matrixSize || matrixY < 0 || matrixY >= matrixSize) continue;
      const color = rgb[matrix[matrixY * matrixSize + matrixX]];
      const offset = (y * width + x) * 4;
      data[offset] = color[0];
      data[offset + 1] = color[1];
      data[offset + 2] = color[2];
      data[offset + 3] = 255;
    }
  }
  return { width, height: width, data };
}

function scaleBrightness(image: PixelImage, multiplier: number): PixelImage {
  const data = new Uint8ClampedArray(image.data);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = Math.min(255, data[index] * multiplier);
    data[index + 1] = Math.min(255, data[index + 1] * multiplier);
    data[index + 2] = Math.min(255, data[index + 2] * multiplier);
  }
  return { width: image.width, height: image.height, data };
}

function addDarkCameraBackground(image: PixelImage, size: number): PixelImage {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let index = 0; index < size * size; index += 1) data[index * 4 + 3] = 255;
  const left = Math.floor((size - image.width) / 2);
  const top = Math.floor((size - image.height) / 2);
  for (let y = 0; y < image.height; y += 1) {
    const sourceStart = y * image.width * 4;
    const targetStart = ((top + y) * size + left) * 4;
    data.set(image.data.subarray(sourceStart, sourceStart + image.width * 4), targetStart);
  }
  return { width: size, height: size, data };
}

function makeOpticalFrame(packet: Uint8Array, matrixSize: number, rotation = 0, imageSize = 720): PixelImage {
  const sourceImage = makeRenderedImage(packet, matrixSize);
  const sourceSize = sourceImage.width;
  const source = sourceImage.data;
  const width = imageSize;
  const height = imageSize;
  const scale = imageSize / 720;
  const output = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    output[index * 4] = 255;
    output[index * 4 + 1] = 255;
    output[index * 4 + 2] = 255;
    output[index * 4 + 3] = 255;
  }
  const quad = [
    { x: 65, y: 60 },
    { x: 645, y: 78 },
    { x: 640, y: 640 },
    { x: 75, y: 630 },
  ].map(({ x, y }) => ({ x: x * scale, y: y * scale }));
  const targets = [
    { x: 0, y: 0 },
    { x: sourceSize, y: 0 },
    { x: sourceSize, y: sourceSize },
    { x: 0, y: sourceSize },
  ];
  const equations: number[][] = [];
  for (let index = 0; index < 4; index += 1) {
    const { x, y } = quad[index];
    const { x: targetX, y: targetY } = targets[index];
    equations.push([x, y, 1, 0, 0, 0, -targetX * x, -targetX * y, targetX]);
    equations.push([0, 0, 0, x, y, 1, -targetY * x, -targetY * y, targetY]);
  }
  for (let column = 0; column < 8; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 8; row += 1) {
      if (Math.abs(equations[row][column]) > Math.abs(equations[pivot][column])) pivot = row;
    }
    [equations[column], equations[pivot]] = [equations[pivot], equations[column]];
    const divisor = equations[column][column];
    for (let entry = column; entry <= 8; entry += 1) equations[column][entry] /= divisor;
    for (let row = 0; row < 8; row += 1) {
      if (row === column) continue;
      const factor = equations[row][column];
      for (let entry = column; entry <= 8; entry += 1) equations[row][entry] -= factor * equations[column][entry];
    }
  }
  const [a, b, c, d, e, f, g, h] = equations.map((row) => row[8]);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const denominator = g * x + h * y + 1;
      const u = (a * x + b * y + c) / denominator / sourceSize;
      const v = (d * x + e * y + f) / denominator / sourceSize;
      if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
      let sourceX = Math.floor(u * sourceSize);
      let sourceY = Math.floor(v * sourceSize);
      if (rotation === 1) [sourceX, sourceY] = [Math.floor(v * sourceSize), Math.floor((1 - u) * sourceSize)];
      if (rotation === 2) [sourceX, sourceY] = [Math.floor((1 - u) * sourceSize), Math.floor((1 - v) * sourceSize)];
      if (rotation === 3) [sourceX, sourceY] = [Math.floor((1 - v) * sourceSize), Math.floor(u * sourceSize)];
      sourceX = Math.max(0, Math.min(sourceSize - 1, sourceX));
      sourceY = Math.max(0, Math.min(sourceSize - 1, sourceY));
      const sourceOffset = (sourceY * sourceSize + sourceX) * 4;
      const targetOffset = (y * width + x) * 4;
      output.set(source.subarray(sourceOffset, sourceOffset + 4), targetOffset);
    }
  }
  return { width, height, data: output };
}

function makeTransparentExterior(image: PixelImage): PixelImage {
  const data = new Uint8ClampedArray(image.data);
  const visited = new Uint8Array(image.width * image.height);
  const queue = new Int32Array(image.width * image.height);
  let head = 0;
  let tail = 0;
  const addIfExteriorWhite = (x: number, y: number): void => {
    if (x < 0 || x >= image.width || y < 0 || y >= image.height) return;
    const index = y * image.width + x;
    if (visited[index]) return;
    const offset = index * 4;
    if (data[offset] !== 255 || data[offset + 1] !== 255 || data[offset + 2] !== 255 || data[offset + 3] === 0) return;
    visited[index] = 1;
    queue[tail++] = index;
  };
  for (let x = 0; x < image.width; x += 1) {
    addIfExteriorWhite(x, 0);
    addIfExteriorWhite(x, image.height - 1);
  }
  for (let y = 0; y < image.height; y += 1) {
    addIfExteriorWhite(0, y);
    addIfExteriorWhite(image.width - 1, y);
  }
  while (head < tail) {
    const index = queue[head++];
    const x = index % image.width;
    const y = Math.floor(index / image.width);
    const offset = index * 4;
    data[offset] = 0;
    data[offset + 1] = 0;
    data[offset + 2] = 0;
    data[offset + 3] = 0;
    addIfExteriorWhite(x - 1, y);
    addIfExteriorWhite(x + 1, y);
    addIfExteriorWhite(x, y - 1);
    addIfExteriorWhite(x, y + 1);
  }
  return { width: image.width, height: image.height, data };
}

function translateImage(image: PixelImage, dx: number, dy: number): PixelImage {
  const data = new Uint8ClampedArray(image.width * image.height * 4);
  for (let index = 0; index < image.width * image.height; index += 1) {
    data[index * 4] = 255;
    data[index * 4 + 1] = 255;
    data[index * 4 + 2] = 255;
    data[index * 4 + 3] = 255;
  }
  for (let y = 0; y < image.height; y += 1) {
    const targetY = y + dy;
    if (targetY < 0 || targetY >= image.height) continue;
    for (let x = 0; x < image.width; x += 1) {
      const targetX = x + dx;
      if (targetX < 0 || targetX >= image.width) continue;
      const sourceOffset = (y * image.width + x) * 4;
      const targetOffset = (targetY * image.width + targetX) * 4;
      data.set(image.data.subarray(sourceOffset, sourceOffset + 4), targetOffset);
    }
  }
  return { width: image.width, height: image.height, data };
}

test('transparent exterior pixels do not change frame detection', async () => {
  const transfer = await prepareAztecTransfer(new File([makePayload(80, 19)], 'transparent-test.bin'), 32);
  const image = makeOpticalFrame(transfer.packets[0], 32);
  const opaque = decodeOpticalFrameDetailed(image, 32);
  const transparent = decodeOpticalFrameDetailed(makeTransparentExterior(image), 32);
  assert.equal(opaque.status, 'packet-decoded', opaque.reason);
  assert.equal(transparent.status, 'packet-decoded', transparent.reason);
  assert.equal(transparent.candidateCount, opaque.candidateCount);
  assert.deepStrictEqual(transparent.packet, opaque.packet);
});

test('small image translations preserve detected frame corner accuracy', async () => {
  const transfer = await prepareAztecTransfer(new File([makePayload(80, 23)], 'translation-test.bin'), 32);
  const image = makeOpticalFrame(transfer.packets[0], 32);
  const baseline = decodeOpticalFrameDetailed(image, 32);
  const dx = 4;
  const dy = 3;
  const shifted = decodeOpticalFrameDetailed(translateImage(image, dx, dy), 32);
  assert.equal(baseline.status, 'packet-decoded', baseline.reason);
  assert.equal(shifted.status, 'packet-decoded', shifted.reason);
  assert.ok(baseline.candidateCount > 0);
  assert.ok(shifted.candidateCount > 0);
  assert.ok(baseline.corners && shifted.corners);
  let minimumMaximumError = Infinity;
  for (let shift = 0; shift < 4; shift += 1) {
    let maximumError = 0;
    for (let index = 0; index < 4; index += 1) {
      const expected = baseline.corners[index];
      const actual = shifted.corners[(index + shift) % 4];
      maximumError = Math.max(maximumError, Math.hypot(actual.x - expected.x - dx, actual.y - expected.y - dy));
    }
    minimumMaximumError = Math.min(minimumMaximumError, maximumError);
  }
  assert.ok(minimumMaximumError <= 2, `translated corners drifted by ${minimumMaximumError.toFixed(2)} pixels`);
});

test('3-bit payload round trips for all final alignments', () => {
  for (let length = 0; length <= 64; length += 1) {
    const bytes = makePayload(length, 17 + length);
    const encoded = encode3BitPayload(bytes);
    const decoded = decode3BitPayload(encoded, bytes.length * 8);
    assert.deepStrictEqual(decoded, bytes, `round-trip failed for payload length=${length}`);
  }

  for (const headByte of [0x00, 0x01, 0x80, 0xff, 0xaa, 0x55]) {
    const payload = new Uint8Array([headByte]);
    const encoded = encode3BitPayload(payload);
    const decoded = decode3BitPayload(encoded, payload.length * 8);
    assert.deepStrictEqual(decoded, payload, 'single-byte payload should survive a 1-bit or 2-bit tail');
  }

  const shortPayloads = [
    new Uint8Array([0x00, 0x00]),
    new Uint8Array([0x01, 0x80]),
    new Uint8Array([0xff, 0xff]),
    new Uint8Array([0x80, 0x01, 0x40]),
  ];

  for (const payload of shortPayloads) {
    const encoded = encode3BitPayload(payload);
    const decoded = decode3BitPayload(encoded, payload.length * 8);
    assert.deepStrictEqual(decoded, payload, 'short payloads should keep their trailing bits');
  }
});

test('CRC32 is stable and detects tampering', () => {
  const payload = new Uint8Array([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]);
  const checksum = crc32(payload);
  assert.equal(typeof checksum, 'number');
  assert.equal(crc32(payload), checksum);
  const tampered = new Uint8Array(payload);
  tampered[0] ^= 0x80;
  assert.notEqual(crc32(tampered), checksum);
});

test('packet decoding ignores padded color modules and preserves the exact packet bytes', async () => {
  const file = new File([new Uint8Array([0x12, 0x34, 0x56, 0x78])], 'packet.bin');
  const transfer = await prepareAztecTransfer(file, 63);
  const packet = transfer.packets[0];
  const symbols = encode3BitPayload(packet);
  const capacity = createAztecLayout(63).dataCoordinates.length;
  const paddedSymbols = new Uint8Array(capacity);
  for (let index = 0; index < paddedSymbols.length; index += 1) {
    paddedSymbols[index] = ((symbols[index] ?? 0) ^ colorSymbolMask(index)) & 0x7;
  }

  const nonBlackPadding = paddedSymbols.slice(symbols.length).filter((symbol) => symbol !== 0).length;
  assert.ok(nonBlackPadding > (paddedSymbols.length - symbols.length) * 0.7, 'zero-filled packet padding should render as a varied color pattern');
  const decodedSymbols = paddedSymbols.map((symbol, index) => symbol ^ colorSymbolMask(index));
  assert.deepStrictEqual(decode3BitPacket(decodedSymbols), packet);
  paddedSymbols[0] ^= 1;
  const corruptedSymbols = paddedSymbols.map((symbol, index) => symbol ^ colorSymbolMask(index));
  assert.equal(decode3BitPacket(corruptedSymbols), null, 'a corrupted packet must fail its CRC');
});

test('renderer redraws every module and changes frame-dependent padding', async () => {
  const transfer = await prepareAztecTransfer(new File([makePayload(200, 19)], 'render.bin'), 63);
  const firstPacket = transfer.packets[0];
  const nextPacket = transfer.packets[1];
  const size = transfer.targetMatrixSize;
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => context,
  } as unknown as HTMLCanvasElement;
  let fillStyle = '';
  let draws = new Map<number, string>();
  const context = {
    clearRect: () => { draws = new Map<number, string>(); },
    fillRect: (x: number, y: number, width: number, height: number) => {
      if (width !== 6 || height !== 6) return;
      assert.equal(width, 6);
      assert.equal(height, 6);
      draws.set(((y - 12) / 6) * size + (x - 12) / 6, fillStyle);
    },
    set fillStyle(value: string) { fillStyle = value; },
    get fillStyle() { return fillStyle; },
  } as unknown as CanvasRenderingContext2D;

  const first = drawAztecFrame(firstPacket, canvas, size);
  const firstMatrix = renderAztecFrameMatrix(firstPacket, size);
  assert.equal(first.width, (size + 4) * 6);
  assert.equal(first.height, (size + 4) * 6);
  assert.equal(draws.size, size * size, 'every matrix module, including corners, must be redrawn');
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      assert.equal(draws.get(y * size + x), COLORS[firstMatrix[y * size + x]]);
    }
  }
  assert.equal(firstMatrix[0], 0);
  assert.equal(firstMatrix[size - 1], 0);
  assert.equal(firstMatrix[(size - 1) * size], 0);
  assert.equal(firstMatrix[size * size - 1], 0);

  const second = drawAztecFrame(nextPacket, canvas, size);
  const secondMatrix = renderAztecFrameMatrix(nextPacket, size);
  assert.equal(draws.size, size * size, 'the next frame must also redraw the complete matrix');
  assert.ok(second.changedModules > size * size * 0.2, 'a new frame must replace stale symbols across the data region');
  assert.equal(second.totalModules, size * size);
  assert.notDeepEqual(firstMatrix, secondMatrix);
});

test('32x32 and 63x63 layouts share a centered fixed-size finder and disjoint data geometry', () => {
  for (const size of [32, 63]) {
    const layout = createAztecLayout(size);
    assert.equal(layout.finderSize, size % 2 === 0 ? EVEN_FINDER_SIZE : FINDER_SIZE);
    assert.equal(layout.finderSize, size === 32 ? 8 : 9);
    assert.equal(layout.finderCenter, size / 2);
    assert.equal(layout.finderStart, (size - layout.finderSize) / 2);
    assert.equal(layout.matrixOffset, QUIET_ZONE_MODULES * MODULE_PIXELS);
    assert.equal(layout.frameSize, (size + QUIET_ZONE_MODULES * 2) * MODULE_PIXELS);

    const data = new Set(layout.dataCoordinates.map(([x, y]) => `${x},${y}`));
    for (const structural of layout.alignmentCoordinates) assert.equal(data.has(structural), false);
    for (let ring = 0; ring < Math.ceil(layout.finderSize / 2); ring += 1) {
      const expected = Math.floor(ring / FINDER_RING_THICKNESS) % 2 === 0 ? '#000000' : '#FFFFFF';
      const near: number = layout.finderStart + ring;
      const far: number = layout.finderStart + layout.finderSize - 1 - ring;
      const ringCorners: Array<[number, number]> = [[near, near], [far, near], [far, far], [near, far]];
      for (const [x, y] of ringCorners) {
        assert.equal(layout.grid[y][x], expected);
      }
    }
    for (let y = Math.floor(layout.finderCenter) - 1; y <= Math.floor(layout.finderCenter); y += 1) {
      for (let x = Math.floor(layout.finderCenter) - 1; x <= Math.floor(layout.finderCenter); x += 1) {
        const centerRing: number = Math.floor(Math.min(
          x - layout.finderStart,
          y - layout.finderStart,
          layout.finderStart + layout.finderSize - 1 - x,
          layout.finderStart + layout.finderSize - 1 - y,
        ) / FINDER_RING_THICKNESS) % 2;
        assert.equal(layout.grid[y][x], centerRing === 0 ? '#000000' : '#FFFFFF');
      }
    }
    const matrix = renderAztecFrameMatrix(new Uint8Array([0]), size);
    const nextMatrix = renderAztecFrameMatrix(new Uint8Array([1]), size);
    assert.equal(new Set(matrix).size, COLORS.length, 'the matrix must preserve all eight encoding colours');
    for (let y = layout.finderStart; y < layout.finderStart + layout.finderSize; y += 1) {
      for (let x = layout.finderStart; x < layout.finderStart + layout.finderSize; x += 1) {
        assert.equal(matrix[y * size + x], nextMatrix[y * size + x], 'finder geometry must not vary between frames');
      }
    }
  }
});

test('32x32 frames carry and decode valid packets while 24x24 remains below protocol capacity', async () => {
  const file = new File([new TextEncoder().encode('HCAC test')], 'hcac-self-test.txt', { type: 'text/plain' });
  const transfer = await prepareAztecTransfer(file, 32);
  const layout = createAztecLayout(32);
  assert.equal(transfer.targetMatrixSize, 32);
  assert.equal(transfer.blockCount, 1, 'the 32x32 decoder self-test must fit in one frame');
  assert.equal(createAztecLayout(32).frameSize, 216);
  assert.equal(renderAztecFrameMatrix(transfer.packets[0], 32).length, 32 * 32);
  for (const packet of transfer.packets) {
    const matrix = renderAztecFrameMatrix(packet, 32);
    const dataPalette = new Set(layout.dataCoordinates.map(([x, y]) => matrix[y * 32 + x]));
    assert.equal(dataPalette.size, COLORS.length, 'every frame data area must contain all eight colors');
    const trace = decodeOpticalFrameDetailed(makeRenderedImage(packet, 32), 32);
    assert.equal(trace.status, 'packet-decoded', trace.reason);
    assert.deepStrictEqual(trace.packet, packet);
  }
  assert.ok(transfer.blockSize > 0);

  assert.equal(Math.floor(createAztecLayout(24).dataCoordinates.length * 3 / 8), 79);
  await assert.rejects(prepareAztecTransfer(file, 24), /cannot fit a safe fountain packet/);
});

test('actual sender render decodes in the receiver pipeline at varied brightness', async () => {
  const transfer = await prepareAztecTransfer(new File([makePayload(128, 77)], 'self-test.bin'), 63);
  const image = makeRenderedImage(transfer.packets[0], transfer.targetMatrixSize);
  const layout = createAztecLayout(transfer.targetMatrixSize);
  for (const packet of transfer.packets) {
    const matrix = renderAztecFrameMatrix(packet, transfer.targetMatrixSize);
    const dataPalette = new Set(layout.dataCoordinates.map(([x, y]) => matrix[y * transfer.targetMatrixSize + x]));
    assert.equal(dataPalette.size, COLORS.length, 'every frame data area must contain all eight colors');
  }
  for (const brightness of [0.7, 1, 1.15]) {
    const trace = decodeOpticalFrameDetailed(scaleBrightness(image, brightness), transfer.targetMatrixSize);
    assert.equal(trace.status, 'packet-decoded', `decoder failed at brightness multiplier ${brightness}: ${trace.reason}`);
    assert.equal(trace.geometryCandidates, 1);
    assert.equal(trace.orientationFound, true);
    assert.equal(trace.gridSampled, true);
    assert.equal(trace.recognizedModules, trace.totalModules);
    assert.equal(trace.headerValid, true);
    assert.equal(trace.crcValid, true);
    assert.deepStrictEqual(trace.packet, transfer.packets[0]);
  }
  const firstDetection = decodeOpticalFrameDetailed(image, transfer.targetMatrixSize);
  assert.equal(firstDetection.status, 'packet-decoded');
  assert.equal(firstDetection.finderSizeModules, createAztecLayout(transfer.targetMatrixSize).finderSize);
  const trackedFrame = decodeOpticalFrameDetailed(image, transfer.targetMatrixSize, firstDetection.corners);
  assert.equal(trackedFrame.status, 'packet-decoded', trackedFrame.reason);
  assert.equal(trackedFrame.trackedCandidate, true);
  assert.equal(trackedFrame.candidateCount, 0, 'tracked reads must not inflate newly detected candidate counts');
  const corruptedPacket = transfer.packets[0].slice();
  corruptedPacket[corruptedPacket.length - 5] ^= 0x80;
  const trackedCrcFailure = decodeOpticalFrameDetailed(
    makeRenderedImage(corruptedPacket, transfer.targetMatrixSize),
    transfer.targetMatrixSize,
    firstDetection.corners,
  );
  assert.equal(trackedCrcFailure.status, 'crc-failed');
  assert.equal(trackedCrcFailure.trackedCandidate, true);
  assert.equal(trackedCrcFailure.candidateCount, 0);
  const darkRoomTrace = decodeOpticalFrameDetailed(addDarkCameraBackground(image, 720), transfer.targetMatrixSize);
  assert.equal(darkRoomTrace.status, 'packet-decoded', `quiet zone should separate the matrix from a dark screen background: ${darkRoomTrace.reason}`);
  assert.deepStrictEqual(darkRoomTrace.packet, transfer.packets[0]);
});

test('receiver diagnostics distinguish absent candidates, bad geometry, and CRC failures', async () => {
  const size = 240;
  const white = new Uint8ClampedArray(size * size * 4);
  for (let index = 0; index < size * size; index += 1) {
    white[index * 4] = 255;
    white[index * 4 + 1] = 255;
    white[index * 4 + 2] = 255;
    white[index * 4 + 3] = 255;
  }
  const noCandidate = decodeOpticalFrameDetailed({ width: size, height: size, data: white }, 63);
  assert.equal(noCandidate.status, 'candidate-not-found');
  assert.match(noCandidate.reason, /No square dark frame boundary/);
  const trackedOnly = decodeOpticalFrameDetailed({ width: size, height: size, data: white }, 63, [
    { x: 40, y: 40 },
    { x: 200, y: 40 },
    { x: 200, y: 200 },
    { x: 40, y: 200 },
  ]);
  assert.equal(trackedOnly.candidateCount, 0, 'tracked coordinates must not be reported as a newly detected candidate');
  assert.equal(trackedOnly.trackedCandidate, true);

  for (let y = 70; y < 130; y += 1) {
    for (let x = 70; x < 130; x += 1) {
      const offset = (y * size + x) * 4;
      white[offset] = 0;
      white[offset + 1] = 0;
      white[offset + 2] = 0;
    }
  }
  const badGeometry = decodeOpticalFrameDetailed({ width: size, height: size, data: white }, 63);
  assert.equal(badGeometry.status, 'geometry-failed');
  assert.match(badGeometry.reason, /covers less than 8%/);

  const transfer = await prepareAztecTransfer(new File([makePayload(32, 90)], 'crc.bin'), 63);
  const corrupted = transfer.packets[0].slice();
  corrupted[corrupted.length - 5] ^= 0x80;
  const crcTrace = decodeOpticalFrameDetailed(makeRenderedImage(corrupted, 63), 63);
  assert.equal(crcTrace.status, 'crc-failed');
  assert.equal(crcTrace.headerValid, true);
  assert.equal(crcTrace.crcValid, false);
  assert.match(crcTrace.reason, /CRC32/);
});

test('empty files and UTF-8 filenames retain valid packet metadata', async () => {
  const file = new File([], '資料-🧪.bin', { type: 'application/octet-stream' });
  const transfer = await prepareAztecTransfer(file, 63);
  assert.equal(transfer.totalBytes, 0);
  assert.equal(transfer.blockCount, 1);
  const packet = transfer.packets[0];
  const degree = packet[20];
  const metadataOffset = 21 + degree * 2;
  const metadataLength = packet[metadataOffset];
  const metadata = packet.subarray(metadataOffset + 1, metadataOffset + 1 + metadataLength);
  const nameLength = metadata[1];
  assert.equal(new TextDecoder().decode(metadata.subarray(2, 2 + nameLength)), file.name);

  const solver = new FountainEquationSolver(transfer.blockCount, transfer.blockSize);
  const payloadOffset = metadataOffset + 1 + metadataLength;
  assert.equal(solver.addEquation([0], packet.subarray(payloadOffset, payloadOffset + transfer.blockSize)), true);
  assert.equal(solver.solved.size, 1);
  assert.ok(solver.solved.get(0)?.every((value) => value === 0));
});

test('file metadata exceeding protocol limits is rejected instead of truncated', async () => {
  const file = new File([], `${'a'.repeat(118)}🧪.bin`);
  await assert.rejects(prepareAztecTransfer(file, 63), /File name exceeds the 120-byte transfer limit/);
  const typedFile = new File([], 'file.bin', { type: 'a'.repeat(121) });
  await assert.rejects(prepareAztecTransfer(typedFile, 63), /File type exceeds the 120-byte transfer limit/);
});

test('incremental fountain solver handles out-of-order and repeated equations', () => {
  const solver = new FountainEquationSolver(2, 2);
  assert.equal(solver.addEquation([0, 1], new Uint8Array([0x13, 0x37])), true);
  assert.equal(solver.addEquation([0], new Uint8Array([0x12, 0x34])), true);
  assert.deepStrictEqual(solver.solved.get(1), new Uint8Array([0x01, 0x03]));
  assert.equal(solver.addEquation([0], new Uint8Array([0x12, 0x34])), true, 'an identical duplicate should be harmless');
  assert.equal(solver.addEquation([0], new Uint8Array([0x99, 0x99])), false, 'a conflicting duplicate must be rejected');
  assert.equal(solver.addEquation([0, 0], new Uint8Array([0, 0])), false, 'duplicate block indices must be rejected');
});

test('matrix and file size limits reject unsupported input', async () => {
  assert.throws(() => createAztecLayout(30), /24, 32, or an odd integer from 31 through 999/);
  assert.throws(() => createAztecLayout(26), /24, 32, or an odd integer from 31 through 999/);
  assert.throws(() => createAztecLayout(1001), /24, 32, or an odd integer from 31 through 999/);
  await assert.rejects(prepareAztecTransfer(new File([new Uint8Array(MAX_FILE_BYTES + 1)], 'too-large.bin'), 63), /larger than 16 MiB/);
  await assert.rejects(prepareAztecTransfer(new File([], 'too-small-matrix.bin'), 24), /cannot fit a safe fountain packet/);
});

test('32x32 and 63x63 camera frames rectify perspective and identify quarter-turn orientation', async () => {
  const file = new File([new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x90])], 'camera.bin');
  for (const matrixSize of [32, 63]) {
    const transfer = await prepareAztecTransfer(file, matrixSize);
    const packet = transfer.packets[0];
    for (const imageSize of [360, 720]) {
      for (const rotation of [0, 1, 2, 3]) {
        const image = makeOpticalFrame(packet, matrixSize, rotation, imageSize);
        const decoded = decodeOpticalFrame(image, matrixSize);
        if (!decoded) throw new Error(`Failed to decode ${matrixSize}x${matrixSize} perspective frame at ${imageSize}px and ${rotation * 90} degrees: ${decodeOpticalFrameDetailed(image, matrixSize).reason}`);
        assert.deepStrictEqual(decoded.packet, packet, `packet mismatch for ${matrixSize}x${matrixSize} at ${imageSize}px and ${rotation * 90} degrees`);
      }
    }
  }
});

test('SHA-256 digest is deterministic and hex-encoded', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const digest = await sha256Hex(bytes);
  assert.equal(digest.length, 64);
  assert.equal(await sha256Hex(bytes), digest);
  assert.notEqual(digest, '');
});

test('valid optical packet reaches reconstruction and verifies the complete file hash', async () => {
  const source = makePayload(64, 33);
  const file = new File([source], 'verified.bin', { type: 'application/octet-stream' });
  const transfer = await prepareAztecTransfer(file, 63);
  const trace = decodeOpticalFrameDetailed(makeRenderedImage(transfer.packets[0], 63), 63);
  assert.equal(trace.status, 'packet-decoded');
  assert.ok(trace.packet);
  const packet = trace.packet;
  const degree = packet[20];
  let offset = 21 + degree * 2;
  const metadataLength = packet[offset++];
  const metadata = packet.subarray(offset, offset + metadataLength);
  const nameLength = metadata[1];
  const typeLengthOffset = 2 + nameLength;
  const typeLength = metadata[typeLengthOffset];
  const hashLengthOffset = typeLengthOffset + 1 + typeLength;
  const expectedHash = new TextDecoder().decode(metadata.subarray(hashLengthOffset + 1));
  offset += metadataLength;
  const payload = packet.subarray(offset, offset + transfer.blockSize);
  const solver = new FountainEquationSolver(transfer.blockCount, transfer.blockSize);
  assert.equal(solver.addEquation([0], payload), true);
  const reconstructed = solver.solved.get(0)?.subarray(0, source.length);
  assert.deepStrictEqual(reconstructed, source);
  assert.equal(await sha256Hex(reconstructed ?? new Uint8Array()), expectedHash);
});

test('fountain packets recover files through realistic packet-loss patterns', async () => {
  const payload = new Uint8Array(1_000_000);
  for (let index = 0; index < payload.length; index += 1) payload[index] = (index * 17 + 13) & 0xff;
  const file = new File([payload], 'fountain.bin', { type: 'application/octet-stream' });
  const transfer = await prepareAztecTransfer(file, 95);
  assert.ok(transfer.blockCount > 1, 'expected multi-block file for a meaningful fountain recovery test');

  const scenarios = [
    { lossRate: 0, pattern: 'random' },
    { lossRate: 0.05, pattern: 'random' },
    { lossRate: 0.1, pattern: 'random' },
    { lossRate: 0.15, pattern: 'random' },
    { lossRate: 0.2, pattern: 'random' },
    { lossRate: 0.15, pattern: 'burst' },
  ] as const;

  for (const { lossRate, pattern } of scenarios) {
    const packetCount = transfer.packets.length;
    const dropped = new Set<number>();
    const random = (seed: number): number => {
      const x = Math.sin(seed * 12.9898) * 43758.5453;
      return x - Math.floor(x);
    };
    for (let packetIndex = 0; packetIndex < packetCount; packetIndex += 1) {
      let shouldDrop = false;
      if (pattern === 'burst') {
        const burstStart = Math.floor(packetCount * 0.3);
        const burstLength = Math.max(1, Math.floor(packetCount * 0.18));
        shouldDrop = packetIndex >= burstStart && packetIndex < burstStart + burstLength && random(packetIndex + 1) < lossRate;
      } else {
        shouldDrop = random(packetIndex + 1 + lossRate * 1000) < lossRate;
      }
      if (shouldDrop) dropped.add(packetIndex);
    }

    const equations = new Map<number, { indices: number[]; data: Uint8Array }>();
    const solver = new FountainEquationSolver(transfer.blockCount, transfer.blockSize);
    for (let packetIndex = 0; packetIndex < packetCount; packetIndex += 1) {
      if (dropped.has(packetIndex)) continue;
      const packet = transfer.packets[packetIndex];
      const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
      const frameId = view.getUint32(0, true);
      const blockCount = view.getUint16(16, true);
      const blockSize = view.getUint16(18, true);
      let offset = 21;
      const indices: number[] = [];
      const degree = packet[20];
      for (let index = 0; index < degree; index += 1) {
        indices.push(view.getUint16(offset, true));
        offset += 2;
      }
      const metadataLength = packet[offset++] ?? 0;
      offset += metadataLength;
      const payload = packet.subarray(offset, offset + blockSize);
      equations.set(frameId, { indices, data: payload });
      assert.equal(solver.addEquation(indices, payload), true, `equation ${frameId} was rejected`);
    }

    const solved = solver.solved;
    assert.ok(solved.size >= transfer.blockCount, `recovery failed at ${lossRate * 100}% ${pattern} loss`);
    const recovered = new Uint8Array(transfer.totalBytes);
    for (let blockIndex = 0; blockIndex < transfer.blockCount; blockIndex += 1) {
      const block = solved.get(blockIndex);
      if (!block) throw new Error(`Missing block ${blockIndex} after ${lossRate * 100}% ${pattern} loss.`);
      const start = blockIndex * transfer.blockSize;
      recovered.set(block.subarray(0, Math.min(block.length, recovered.length - start)), start);
    }
    assert.deepStrictEqual(recovered, payload, `recovered payload mismatch at ${lossRate * 100}% ${pattern} loss`);
    if (lossRate === 0 && pattern === 'random') {
      const batchSolved = new Map<number, Uint8Array>();
      solveFountainEquations(equations, batchSolved);
      assert.deepStrictEqual(batchSolved, solved, 'batch and incremental fountain solvers should agree');
    }
  }
});
