// ZIP streaming mínimo, método "store" (sem compressão) com data descriptor,
// para montar o arquivo sem conhecer CRC/tamanho antes nem carregar tudo na
// memória. Suficiente para empacotar mídias e um .md. Sem dependências.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(crc: number, buf: Uint8Array): number {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array | AsyncIterable<Uint8Array>;
}

/** Gera os bytes de um zip a partir de entradas (streaming). */
export async function* zipStream(
  entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>,
): AsyncGenerator<Uint8Array> {
  const enc = new TextEncoder();
  const central: Uint8Array[] = [];
  let offset = 0;

  const asIter: AsyncIterable<ZipEntry> =
    Symbol.asyncIterator in (entries as object)
      ? (entries as AsyncIterable<ZipEntry>)
      : (async function* () {
          for (const e of entries as Iterable<ZipEntry>) yield e;
        })();

  for await (const entry of asIter) {
    const nameBytes = enc.encode(entry.name);
    const FLAGS = 0x0808; // bit 3 (data descriptor) + bit 11 (UTF-8)
    const MDATE = 0x21; // 1980-01-01

    const local = new Uint8Array(30 + nameBytes.length);
    const ldv = new DataView(local.buffer);
    ldv.setUint32(0, 0x04034b50, true);
    ldv.setUint16(4, 20, true);
    ldv.setUint16(6, FLAGS, true);
    ldv.setUint16(8, 0, true); // store
    ldv.setUint16(10, 0, true);
    ldv.setUint16(12, MDATE, true);
    ldv.setUint32(14, 0, true); // crc (no descriptor)
    ldv.setUint32(18, 0, true); // comp size
    ldv.setUint32(22, 0, true); // uncomp size
    ldv.setUint16(26, nameBytes.length, true);
    ldv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    const localOffset = offset;
    yield local;
    offset += local.length;

    let crc = 0;
    let size = 0;
    if (entry.data instanceof Uint8Array) {
      crc = crc32(0, entry.data);
      size = entry.data.length;
      yield entry.data;
      offset += entry.data.length;
    } else {
      for await (const chunk of entry.data) {
        crc = crc32(crc, chunk);
        size += chunk.length;
        yield chunk;
        offset += chunk.length;
      }
    }

    const desc = new Uint8Array(16);
    const ddv = new DataView(desc.buffer);
    ddv.setUint32(0, 0x08074b50, true);
    ddv.setUint32(4, crc, true);
    ddv.setUint32(8, size, true);
    ddv.setUint32(12, size, true);
    yield desc;
    offset += 16;

    const cd = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(cd.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(8, FLAGS, true);
    cdv.setUint16(10, 0, true);
    cdv.setUint16(12, 0, true);
    cdv.setUint16(14, MDATE, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, size, true);
    cdv.setUint32(24, size, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint16(30, 0, true);
    cdv.setUint16(32, 0, true);
    cdv.setUint16(34, 0, true);
    cdv.setUint16(36, 0, true);
    cdv.setUint32(38, 0, true);
    cdv.setUint32(42, localOffset, true);
    cd.set(nameBytes, 46);
    central.push(cd);
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const cd of central) {
    yield cd;
    cdSize += cd.length;
    offset += cd.length;
  }

  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(4, 0, true);
  edv.setUint16(6, 0, true);
  edv.setUint16(8, central.length, true);
  edv.setUint16(10, central.length, true);
  edv.setUint32(12, cdSize, true);
  edv.setUint32(16, cdStart, true);
  edv.setUint16(20, 0, true);
  yield eocd;
}

/** Converte um async generator de bytes em ReadableStream (web). */
export function toReadableStream(gen: AsyncGenerator<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await gen.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel() {
      await gen.return?.(undefined as never);
    },
  });
}
