import config from './config.js';

class CloudService extends EventTarget {
  configured=Boolean(config.supabaseUrl&&config.supabaseKey);
  client=null;user=null;revision=0;status='local';error='';pending=null;timer=null;saving=null;blocked=false;generation=0;
  notify(){this.dispatchEvent(new Event('status'));}
  async init(){
    if(!this.configured)return;
    const {createClient}=await import('./vendor/supabase.js');
    this.client=createClient(config.supabaseUrl,config.supabaseKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
    const {data,error}=await this.client.auth.getSession();if(error)throw error;
    this.user=data.session?.user||null;this.status=this.user?'loading':'signedout';
    this.client.auth.onAuthStateChange((event,session)=>{
      // Auth callbacks must finish before further auth/database calls begin.
      setTimeout(()=>{
        if(event==='PASSWORD_RECOVERY'){this.recovery=true;this.dispatchEvent(new Event('recovery'));}
        if(this.user?.id!==session?.user?.id){this.generation++;this.pending=null;clearTimeout(this.timer);this.user=session?.user||null;this.revision=0;this.blocked=false;this.dispatchEvent(new Event('session'));}
      },0);
    });
  }
  async rpc(name,args={}){if(!this.user)throw new Error('Sign in to use cloud features.');const {data,error}=await this.client.rpc(name,args);if(error)throw new Error(error.message);return data;}
  async load(){
    const generation=this.generation;
    this.status='loading';this.notify();
    const {data,error}=await this.client.from('budget_accounts').select('document,revision').eq('owner_id',this.user.id).maybeSingle();
    if(generation!==this.generation)return null;
    if(error){this.status='error';this.error=error.message;this.blocked=true;this.notify();throw new Error(error.message);}
    this.revision=data?.revision||0;this.blocked=false;this.error='';this.status='synced';this.notify();return data?.document||null;
  }
  queue(document){
    if(!this.user)return;this.pending=structuredClone(document);this.status=this.blocked?'conflict':'pending';this.notify();
    clearTimeout(this.timer);if(!this.blocked)this.timer=setTimeout(()=>this.flush().catch(()=>{}),600);
  }
  async flush(){
    clearTimeout(this.timer);
    if(this.saving){await this.saving;if(this.pending&&!this.blocked)return this.flush();return;}
    if(this.blocked)throw new Error(this.error||'Reload cloud data before syncing.');
    if(!this.pending||!this.user)return;
    const generation=this.generation,document=this.pending;this.pending=null;this.status='saving';this.notify();
    this.saving=(async()=>{
      try{
        const revision=await this.rpc('save_budget',{p_document:document,p_expected_revision:this.revision});
        if(generation!==this.generation)return;
        this.revision=Number(revision);this.status='synced';this.error='';
      }catch(e){
        if(generation!==this.generation)return;
        this.pending ||= document;this.status=e.message.includes('CLOUD_CONFLICT')?'conflict':'error';this.error=e.message;this.blocked=true;throw e;
      }finally{if(generation===this.generation)this.notify();}
    })();
    try{await this.saving;}finally{this.saving=null;}
    if(this.pending&&!this.blocked)return this.flush();
  }
  async signIn(email,password){const {error}=await this.client.auth.signInWithPassword({email,password});if(error)throw new Error(error.message);}
  async signUp(email,password,name){const {data,error}=await this.client.auth.signUp({email,password,options:{data:{display_name:name},emailRedirectTo:location.origin+'/#account'}});if(error)throw new Error(error.message);return Boolean(data.session);}
  async signOut(skipSync=false){if(!skipSync&&(this.pending||this.saving))await this.flush();const {error}=await this.client.auth.signOut();if(error)throw new Error(error.message);}
  async resetPassword(email){const {error}=await this.client.auth.resetPasswordForEmail(email,{redirectTo:location.origin+'/#account'});if(error)throw new Error(error.message);}
  async updatePassword(password){const {error}=await this.client.auth.updateUser({password});if(error)throw new Error(error.message);this.recovery=false;}
  async households(){const {data,error}=await this.client.from('households').select('*').order('created_at');if(error)throw new Error(error.message);return data;}
  async members(group){const {data,error}=await this.client.from('household_members').select('user_id,display_name').eq('household_id',group);if(error)throw new Error(error.message);return data;}
  async bills(group){const {data,error}=await this.client.from('household_bills').select('*').eq('household_id',group).order('due_date');if(error)throw new Error(error.message);return data;}
  async snapshots(){const {data,error}=await this.client.from('support_snapshots').select('*').order('created_at',{ascending:false});if(error)throw new Error(error.message);return data;}
}
export const cloud=new CloudService();
