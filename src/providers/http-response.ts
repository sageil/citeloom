export async function readBoundedResponseBytes(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  const body = response.body;
  if (body === null) {
    return new Uint8Array();
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        return joinResponseChunks(chunks, totalBytes);
      }
      totalBytes += result.value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        throw new Error(`Provider response exceeded ${maximumBytes} bytes.`);
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
}

export async function readBoundedResponseText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const bytes = await readBoundedResponseBytes(response, maximumBytes);
  return new TextDecoder().decode(bytes);
}

export async function readBoundedJsonResponse(
  response: Response,
  maximumBytes: number,
): Promise<unknown> {
  const text = await readBoundedResponseText(response, maximumBytes);
  return JSON.parse(text) as unknown;
}

function joinResponseChunks(
  chunks: readonly Uint8Array[],
  totalBytes: number,
): Uint8Array {
  const joined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}
