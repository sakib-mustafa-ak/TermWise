import fs from 'node:fs/promises';
import {prepareAssets} from './assets.mjs';
await prepareAssets('dist');
for(const file of ['index.html','styles.css','app.js','core.js','cloud.js','sample-transactions.csv'])await fs.copyFile(file,`dist/${file}`);
console.log('Built Termwise into dist/');
