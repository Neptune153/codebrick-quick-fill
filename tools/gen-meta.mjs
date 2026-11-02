// 从 codebrick-quick-fill.user.js 的元数据头生成 codebrick-quick-fill.meta.js
// 脚本管理器检查更新时只取 meta.js 那几行，取到新 @version 才去下载整个脚本。
// 用法：node tools/gen-meta.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'codebrick-quick-fill.user.js');
const DST = join(ROOT, 'codebrick-quick-fill.meta.js');
const END = '// ==/UserScript==';

const text = readFileSync(SRC, 'utf8');
const end = text.indexOf(END);

if (end < 0) {
  console.error(`${SRC} 里找不到 ${END}`);
  process.exit(1);
}

const meta = text.slice(0, end + END.length) + '\n';
writeFileSync(DST, meta, 'utf8');
console.log(`已写入 ${DST}（${meta.split('\n').length - 1} 行）`);
