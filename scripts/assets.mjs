import fs from 'node:fs/promises';
import {build,stop} from 'esbuild';
import {publicConfig} from './public-config.mjs';
try{process.loadEnvFile?.();}catch(e){if(e.code!=='ENOENT')throw e;}
export async function prepareAssets(directory){
  await fs.mkdir(`${directory}/vendor`,{recursive:true});
  await fs.writeFile(`${directory}/config.js`,`export default ${JSON.stringify(publicConfig())};\n`);
  try{await build({stdin:{contents:"export {createClient} from '@supabase/supabase-js';",resolveDir:process.cwd()},bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,outfile:`${directory}/vendor/supabase.js`});}finally{stop();}
}
