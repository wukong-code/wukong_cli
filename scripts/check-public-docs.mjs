import fs from 'node:fs';
import path from 'node:path';

export function checkPublicDocs(root) {
  const allowed = new Set(JSON.parse(fs.readFileSync(path.join(root, 'docs/public-documents.json'), 'utf8')));
  const actual = new Set();
  const errors = [];
  const rules = [
    ['private archive marker', /WUKONG_PRIVATE_DOCUMENT/],
    ['candidate pricing', /\$[1-9]\d*(?:\/|\s*per\s+)(?:月|团队|人|month|team)/i],
    ['business experiment', /SKU 与价格实验|生产匿名聚合数据|首轮 30 天实验顺序/],
    ['internal cohort target', /(?:\d+\/){3}\d+\s+(?:cohort|opt-in)/i],
    ['production activity counts', /\d+ installs\/\d+ active days/],
    ['private website audit snapshot', /\d+ 项 = \d+ critical/],
  ];
  function inspect(file) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    // The generated deployment marker has its own release-identity validator.
    if (relative === 'docs/public-documents.json' || relative === 'docs/_release.json') return;
    actual.add(relative);
    if (!allowed.has(relative)) errors.push(`${relative}: not in the reviewed public document list`);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (const [label, pattern] of rules) {
      const index = lines.findIndex((line) => pattern.test(line));
      if (index !== -1) errors.push(`${relative}:${index + 1}: ${label}`);
    }
  }
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) errors.push(`${path.relative(root, file)}: document symlink is not allowed`);
      else if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) inspect(file);
    }
  }
  walk(path.join(root, 'docs'));
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) inspect(path.join(root, entry.name));
  }
  for (const file of allowed) {
    if (!actual.has(file)) errors.push(`${file}: reviewed document is missing`);
  }
  if (errors.length > 0) throw new Error(`Public document boundary failed:\n${errors.join('\n')}`);
  console.log(`Public document boundary passed (${actual.size} reviewed documents).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  checkPublicDocs(path.resolve(import.meta.dirname, '..'));
}
