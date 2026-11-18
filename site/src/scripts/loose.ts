/**
 * Reading files picked or dropped one by one (not in a .zip or a folder) within
 * the same limits as a .zip: 50 MB per file, 200 MB in all. A build log over the
 * per-file limit keeps its first and last part, where TeX writes the preamble,
 * the summary and most errors that end a run. Pure apart from Blob reads, so it
 * runs in Node for the tests.
 */
import { ZIP_LIMITS, type ZipLimits } from './zip';

/** Bytes kept from each end of a build log that is over the per-file limit. */
export const LOG_KEEP_BYTES = 8 * 1024 * 1024;

export type LooseRead =
  | { ok: true; data: Uint8Array; note?: string }
  | { ok: false; reason: string };

const mb = (n: number) => `${Math.ceil(n / 1048576)} MB`;

/**
 * Reads `file` if it fits. `used` counts the bytes read so far for this drop
 * and is updated. `isLog` lets an oversized log keep its head and tail.
 */
export async function readWithinLimits(
  file: Blob & { name: string },
  isLog: boolean,
  used: { bytes: number },
  limits: Pick<ZipLimits, 'maxEntryBytes' | 'maxTotalBytes'> = ZIP_LIMITS,
  keep = LOG_KEEP_BYTES,
): Promise<LooseRead> {
  const tooBig = file.size > limits.maxEntryBytes;
  if (tooBig && !isLog)
    return {
      ok: false,
      reason: `too large (${mb(file.size)}; the limit is ${mb(limits.maxEntryBytes)})`,
    };
  const part = Math.min(keep, Math.floor(limits.maxEntryBytes / 2));
  const size = tooBig ? 2 * part : file.size;
  if (used.bytes + size > limits.maxTotalBytes)
    return {
      ok: false,
      reason: `too large (the files together are over ${mb(limits.maxTotalBytes)})`,
    };
  used.bytes += size;
  if (!tooBig) return { ok: true, data: new Uint8Array(await file.arrayBuffer()) };
  const head = new Uint8Array(await file.slice(0, part).arrayBuffer());
  const tail = new Uint8Array(await file.slice(file.size - part).arrayBuffer());
  const data = new Uint8Array(head.length + 1 + tail.length);
  data.set(head, 0);
  data[head.length] = 0x0a;
  data.set(tail, head.length + 1);
  return {
    ok: true,
    data,
    note: `${file.name} is ${mb(file.size)}: only its first and last ${mb(part)} were checked.`,
  };
}
