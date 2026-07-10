import { describe, expect, it } from 'vitest';
import {
  BodyTooLargeError,
  readJsonBody,
} from '../../supabase/functions/_shared/readJsonBody';
import { isSafeProxyPath } from '../../supabase/functions/_shared/validatePath';

describe('bounded edge-function JSON bodies', () => {
  it('parses a streamed body without content-length', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"reports":'));
        controller.enqueue(encoder.encode('[]}'));
        controller.close();
      },
    });
    const request = new Request('https://example.invalid', {
      method: 'POST',
      body,
      duplex: 'half',
    } as RequestInit);
    await expect(readJsonBody(request, 32)).resolves.toEqual({ reports: [] });
  });

  it('cancels a chunked body as soon as the byte limit is exceeded', async () => {
    const request = new Request('https://example.invalid', {
      method: 'POST',
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(9));
        },
      }),
      duplex: 'half',
    } as RequestInit);
    await expect(readJsonBody(request, 8)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
  });

  it('rejects an oversized declared length before reading', async () => {
    const request = new Request('https://example.invalid', {
      method: 'POST',
      headers: { 'content-length': '100' },
      body: '{}',
    });
    await expect(readJsonBody(request, 8)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
  });
});

describe('bounded proxy paths', () => {
  it('rejects oversized paths and excessive query cardinality', () => {
    expect(isSafeProxyPath('/event/2026test?simple=true')).toBe(true);
    expect(isSafeProxyPath(`/${'a'.repeat(512)}`)).toBe(false);
    expect(
      isSafeProxyPath(`/?${Array.from({ length: 21 }, (_, i) => `k${i}=v`).join('&')}`),
    ).toBe(false);
  });
});
