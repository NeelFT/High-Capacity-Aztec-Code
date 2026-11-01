export async function compressGzipIfSmaller(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null;
  const source = new Uint8Array(bytes.byteLength);
  source.set(bytes);
  const compressed = await new Response(
    new Blob([source.buffer]).stream().pipeThrough(new CompressionStream('gzip')),
  ).arrayBuffer();
  const result = new Uint8Array(compressed);
  return result.length < bytes.length ? result : null;
}

export async function decompressGzip(bytes: Uint8Array, maxOutputBytes: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot decompress the received gzip transfer.');
  }
  const source = new Uint8Array(bytes.byteLength);
  source.set(bytes);
  const reader = new Blob([source.buffer])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'))
    .getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    totalBytes += result.value.byteLength;
    if (totalBytes > maxOutputBytes) {
      await reader.cancel();
      throw new Error(`Decompressed transfer exceeds its ${maxOutputBytes}-byte size limit.`);
    }
    chunks.push(result.value);
  }
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
