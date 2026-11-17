import fs from 'node:fs/promises';
await fs.mkdir('dist',{recursive:true});
for (const f of ['index.html','styles.css','app.js','core.js','sample-transactions.csv']) await fs.copyFile(f,`dist/${f}`);
console.log('Built Termwise into dist/');
