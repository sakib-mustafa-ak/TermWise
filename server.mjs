import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {prepareAssets} from './scripts/assets.mjs';
const root = process.cwd();
await prepareAssets('tmp/runtime');
const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.csv':'text/csv; charset=utf-8','.svg':'image/svg+xml'};
const files = new Set(['index.html','styles.css','app.js','core.js','cloud.js','config.js','vendor/supabase.js','sample-transactions.csv']);
http.createServer(async (req,res) => {
  const requested = new URL(req.url, 'http://localhost').pathname;
  const file = requested === '/' ? 'index.html' : requested.slice(1);
  if (!files.has(file)) {res.writeHead(404);res.end('Not found');return;}
  try {const data = await fs.readFile(path.join(root,['config.js','vendor/supabase.js'].includes(file)?'tmp/runtime':'',file));res.writeHead(200,{'Content-Type':types[path.extname(file)],'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});res.end(data);}
  catch {res.writeHead(404);res.end('Not found');}
}).listen(Number(process.env.PORT)||5173,'127.0.0.1',()=>console.log(`Termwise is ready at http://localhost:${Number(process.env.PORT)||5173}`));
