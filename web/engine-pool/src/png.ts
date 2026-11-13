import { deflateSync } from 'node:zlib'

/**
 * A minimal PNG encoder for the server-side Electron shim.
 *
 * Upstream rasterizes PDF pages with PDFium and turns the raw bitmap into a
 * PNG through Electron's `nativeImage`. The server has no Electron, so the
 * shim encodes the PNG itself — the same bytes, without the native module.
 */

interface Bitmap {
  width: number
  height: number
  data: Buffer
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let crc = -1
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ -1) >>> 0
}

function chunk(type: string, payload: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(payload.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), payload])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/** Encode an RGBA bitmap as a PNG. */
export function encodePng(bitmap: Bitmap): Buffer {
  const { width, height, data } = bitmap
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // colour type: RGBA
  header[10] = 0 // compression
  header[11] = 0 // filter
  header[12] = 0 // interlace

  // Every scanline is prefixed with its filter type (0 = none).
  const raw = Buffer.alloc(height * (width * 4 + 1))
  for (let row = 0; row < height; row += 1) {
    const target = row * (width * 4 + 1)
    raw[target] = 0
    data.copy(raw, target + 1, row * width * 4, (row + 1) * width * 4)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
