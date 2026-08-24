import createModule from 'bentopdf-pdfium';

const inBrowser = typeof window !== 'undefined';

function resolveWasmUrl() {
  if (inBrowser) {
    return new URL('bentopdf-pdfium/editcore.wasm', import.meta.url).href;
  }
  const resolve = import.meta.resolve;
  if (typeof resolve !== 'function') return null;
  return new URL(resolve('bentopdf-pdfium/editcore.wasm')).pathname;
}

const wasmUrl = resolveWasmUrl();

export const ENGINE_BUILD = 'bentopdf-pdfium';

export function createEngineModule(options) {
  return createModule({
    ...(options ?? {}),
    locateFile: (file, prefix) =>
      file.endsWith('.wasm')
        ? (wasmUrl ?? `${prefix}editcore.wasm`)
        : `${prefix}${file}`,
  });
}
