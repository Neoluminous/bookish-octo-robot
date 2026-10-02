import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw Error('Pass a new absolute release directory.');
if (fs.existsSync(output)) throw Error('Release directory already exists.');
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const publicFiles = ['index.html', 'app-mtsvynal.js', 'questions-mtsvynal.js', 'qrcode-mtsvynal.js', 'qrcode.js', 'ngo-compass-logo.png', 'ngo-team-funding-review.png', 'og.png', 'questions.json'];
for (const file of publicFiles) fs.copyFileSync(path.join(root, 'site', file), path.join(output, file));
fs.mkdirSync(path.join(output, 'assets'));
fs.copyFileSync(path.join(root, 'site', 'assets', 'index-CjYB9TMU.css'), path.join(output, 'assets', 'index-CjYB9TMU.css'));
for (const file of ['.htaccess', 'common.php', 'api.php', 'admin.php']) fs.copyFileSync(path.join(here, file), path.join(output, file));
console.log(`Prepared ${output}`);
