import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

registerHooks({
  load(url, context, nextLoad) {
    const [fileUrl, query = ''] = url.split('?', 2);
    if (!query.split('&').includes('raw') || !fileUrl.startsWith('file:')) {
      return nextLoad(url, context);
    }

    const text = readFileSync(fileURLToPath(fileUrl), 'utf-8');
    return {
      format: 'module',
      shortCircuit: true,
      source: `export default ${JSON.stringify(text)};`,
    };
  },
});
