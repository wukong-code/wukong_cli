/**
 * Rolldown module types used by tsdown after `?raw` has been resolved away.
 * Keep this allowlist aligned with the prompt source extensions in agent-core.
 */
export const RAW_TEXT_LOADERS = Object.freeze({
  '.md': 'text',
  '.yaml': 'text',
});

/**
 * Resolve Vite-style `?raw` imports to their underlying file. Rolldown then
 * reads the file through its built-in `text` module type, so this adapter does
 * not implement file loading or source generation itself.
 */
export function rawTextQueryPlugin() {
  return {
    name: 'wukong-raw-text-query',
    enforce: 'pre',
    async resolveId(id, importer) {
      const [path, query = ''] = id.split('?', 2);
      if (!query.split('&').includes('raw')) return null;
      return this.resolve(path, importer, { skipSelf: true });
    },
  };
}
