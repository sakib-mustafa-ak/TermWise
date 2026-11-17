export function publicConfig(env=process.env){
  const url=env.SUPABASE_URL?.trim()||'',key=env.SUPABASE_PUBLISHABLE_KEY?.trim()||'';
  if(!url&&!key)return {supabaseUrl:'',supabaseKey:''};
  if(!url||!key)throw new Error('Set both SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.');
  const parsed=new URL(url);
  if(parsed.username||parsed.password||parsed.search||parsed.hash||!['','/'].includes(parsed.pathname))throw new Error('Use only the Supabase project origin, without credentials, query parameters or a path.');
  if(parsed.protocol!=='https:'&&!(parsed.protocol==='http:'&&['localhost','127.0.0.1'].includes(parsed.hostname)))throw new Error('Use HTTPS for the Supabase project URL.');
  let publicKey=key.startsWith('sb_publishable_');
  if(!publicKey){try{publicKey=JSON.parse(Buffer.from(key.split('.')[1],'base64url').toString()).role==='anon';}catch{}}
  if(!publicKey)throw new Error('Only a Supabase publishable key or legacy anon key may be exposed. Never use a service-role or secret key.');
  return {supabaseUrl:url.replace(/\/$/,''),supabaseKey:key};
}
