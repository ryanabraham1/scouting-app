export class BodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "BodyTooLargeError";
  }
}

async function readBoundedBytes(
  headers: Headers,
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array> {
  const rawLength = headers.get("content-length");
  if (rawLength !== null) {
    const declared = Number(rawLength);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      throw new TypeError("invalid content-length");
    }
    if (declared > maxBytes) throw new BodyTooLargeError();
  }

  if (!body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  const reader = body.getReader();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new BodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readJsonBody(
  request: Request,
  maxBytes: number,
): Promise<unknown> {
  const bytes = await readBoundedBytes(request.headers, request.body, maxBytes);
  if (bytes.byteLength === 0) return null;
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export async function readJsonResponse(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  const bytes = await readBoundedBytes(response.headers, response.body, maxBytes);
  if (bytes.byteLength === 0) return null;
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export async function readTextResponse(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const bytes = await readBoundedBytes(response.headers, response.body, maxBytes);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
