import assert from 'node:assert/strict';
import test from 'node:test';

import { COLORS, colorSymbolMask, createAztecLayout, crc32, decode3BitPacket, decode3BitPayload, encode3BitPayload, FountainEquationSolver, MAX_FILE_BYTES, prepareAztecTransfer, sha256Hex, solveFountainEquations } from './aztec.ts';
import { decodeOpticalFrame } from './image-decoder.ts';
import type { PixelImage } from './image-decoder.ts';

function makePayload(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = (index * 37 + seed) & 0xff;
  }
  return bytes;
}

function makeOpticalFrame(packet: Uint8Array, matrixSize: number, rotation = 0): PixelImage {
  const layout = createAztecLayout(matrixSize);
  const modulePixels = 6;
  const sourceSize = matrixSize * modulePixels;
  const source = new Uint8ClampedArray(sourceSize * sourceSize * 4);
  const symbols = encode3BitPayload(packet);
  const dataIndex = new Map(layout.dataCoordinates.map(([x, y], index) => [`${x},${y}`, index]));
  const rgb = COLORS.map((color) => [
    parseInt(color.slice(1, 3), 16),
    parseInt(color.slice(3, 5), 16),
    parseInt(color.slice(5, 7), 16),
  ]);
  for (let y = 0; y < matrixSize; y += 1) {
    for (let x = 0; x < matrixSize; x += 1) {
      const dataPosition = dataIndex.get(`${x},${y}`);
      const structuralColor = layout.grid[y][x];
      const colorIndex = structuralColor
        ? COLORS.indexOf(structuralColor as typeof COLORS[number])
        : ((symbols[dataPosition ?? 0] ?? 0) ^ colorSymbolMask(dataPosition ?? 0)) & 0x7;
      const color = rgb[colorIndex < 0 ? 7 : colorIndex];
      for (let py = 0; py < modulePixels; py += 1) {
        for (let px = 0; px < modulePixels; px += 1) {
          const targetX = x * modulePixels + px;
          const targetY = y * modulePixels + py;
          const offset = (targetY * sourceSize + targetX) * 4;
          source[offset] = color[0];
          source[offset + 1] = color[1];
          source[offset + 2] = color[2];
          source[offset + 3] = 255;
        }
      }
    }
  }

  const width = 720;
  const height = 720;
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
  ];
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
  assert.throws(() => createAztecLayout(30), /odd integer from 31 through 999/);
  assert.throws(() => createAztecLayout(1001), /odd integer from 31 through 999/);
  await assert.rejects(prepareAztecTransfer(new File([new Uint8Array(MAX_FILE_BYTES + 1)], 'too-large.bin'), 63), /larger than 16 MiB/);
  await assert.rejects(prepareAztecTransfer(new File([], 'too-small-matrix.bin'), 31), /cannot fit a safe fountain packet/);
});

test('camera decoder rectifies perspective and identifies quarter-turn orientation', async () => {
  const file = new File([new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x90])], 'camera.bin');
  for (const matrixSize of [63, 95]) {
    const transfer = await prepareAztecTransfer(file, matrixSize);
    const packet = transfer.packets[0];
    for (const rotation of [0, 1, 2, 3]) {
      const image = makeOpticalFrame(packet, matrixSize, rotation);
      const decoded = decodeOpticalFrame(image, matrixSize);
      if (!decoded) throw new Error(`Failed to decode ${matrixSize}x${matrixSize} perspective frame at rotation ${rotation * 90} degrees.`);
      assert.deepStrictEqual(decoded.packet, packet, `packet mismatch for ${matrixSize}x${matrixSize} at rotation ${rotation * 90} degrees`);
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
