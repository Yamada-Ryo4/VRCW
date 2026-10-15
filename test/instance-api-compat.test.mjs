import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const helper = read('public/js/instance-api.js');
const world = 'wrld_10000000-0000-4000-8000-000000000001';
const owner = 'usr_10000000-0000-4000-8000-000000000001';
const location = world + ':12345~private(' + owner + ')~region(jp)';
const clone = value => JSON.parse(JSON.stringify(value));
const response = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
function helperContext(extra = {}) {
  const context = vm.createContext(extra);
  vm.runInContext(helper, context);
  return context;
}

test('private creation has bare world ID, request type, region and owner only; invite+ retains its flag', () => {
  const c = helperContext();
  assert.deepEqual(clone(c.instanceCreateBody(location, 'invite', 'jp', owner)), { worldId: world, type: 'private', region: 'jp', ownerId: owner });
  assert.deepEqual(clone(c.instanceCreateBody(world, 'inviteplus', 'usw', owner)), { worldId: world, type: 'private', region: 'us', ownerId: owner, canRequestInvite: true });
  assert.deepEqual(clone(c.instanceCreateBody(world, 'public', 'use', owner)), { worldId: world, type: 'public', region: 'use', ownerId: null });
  for (const region of ['us','use','eu','jp']) assert.equal(c.instanceCreateBody(world,'friends',region,owner).region,region);
});

test('creation response accepts complete location/id or bare instanceId without double world prefix', () => {
  const c = helperContext();
  for (const body of [{location}, {id:location}, {instanceId:location}, {instanceId:location.split(':')[1]}]) {
    assert.equal(c.createdInstanceLocation(body,world),location);
  }
  assert.throws(() => c.createdInstanceLocation({},world),/missing its location/);
});

test('API errors expose original upstream message, not just status, with fallback on empty responses', async () => {
  const c = helperContext();
  assert.equal((await c.instanceApiError(response({error:{message:'Bad response data'}},400),'HTTP 400')).message,'Bad response data');
  assert.equal((await c.instanceApiError({json:async()=>{throw new Error('empty');}},'HTTP 503')).message,'HTTP 503');
});

const worlds = read('public/js/worlds.js');
const joinSource = worlds.slice(worlds.indexOf('async function joinWorldInstance()'),worlds.indexOf('function joinSpecificInstance('));
function joinHarness(route) {
  const requests=[], buttons=new Map(['worldDetailJoinBtn','worldDetailMobileJoinBtn'].map(id=>[id,{id,disabled:false,innerHTML:'',classList:{remove(){}}}]));
  const status={textContent:'',innerHTML:'',style:{}};
  const c=helperContext({currentWorldDetail:{id:world},currentUserId:owner,myProfileData:null,
    PREF_TYPE:'type',PREF_REGION:'region',INSTANCE_TYPE_LABELS:{invite:'Private'},REGION_LABELS:{usw:'US West'},
    localStorage:{getItem:key=>key==='type'?'invite':'usw'},document:{getElementById:id=>buttons.get(id)||status},
    t:key=>key,showToast(){},setTimeout(){},apiCall:async(path,options)=>{requests.push({path,options});return route(path,options);}});
  vm.runInContext(joinSource,c);
  return {c,requests,status};
}

test('world join creates once with request region us then self-invites bodylessly to returned location', async () => {
  const h=joinHarness(path=>response(path==='/api/vrc/instances'?{id:location}:{}));
  await h.c.joinWorldInstance();
  assert.equal(h.requests.length,2);
  assert.deepEqual(clone(h.requests[0].options.json),{worldId:world,type:'private',region:'us',ownerId:owner});
  assert.equal(h.requests[1].path,'/api/vrc/invite/myself/to/'+encodeURIComponent(location));
  assert.equal('json' in h.requests[1].options,false);
});

test('create rejection and missing instance response never send a malformed self invite', async () => {
  for(const result of [response({error:{message:'Bad response data'}},400),response({})]) {
    const h=joinHarness(()=>result);
    await h.c.joinWorldInstance();
    assert.equal(h.requests.length,1);
    assert.match(h.status.textContent,/Bad response data|missing its location/);
  }
});

test('instance helper is resident before lazy worlds and shares current page version', () => {
  const html=read('public/index.html');
  const helperRef=html.match(/src="js\/instance-api.js\?v=(\d+)"/);
  assert.ok(helperRef);
  assert.equal(helperRef[1],html.match(/src="js\/core.js\?v=(\d+)"/)[1]);
  assert.ok(html.indexOf('js/instance-api.js')<html.indexOf('js/worlds-shell.js'));
});

if(existsSync(new URL('../public/dating/index.html',import.meta.url))) {
  const dating=read('public/dating/index.html');
  const directSource=dating.slice(dating.indexOf('async function generateDirectInvite(targetId)'),dating.indexOf('\n</script>',dating.indexOf('async function generateDirectInvite(targetId)')));
  function directHarness(createReply=response({id:location}),cancel=false) {
    const requests=[],toasts=[],button={innerHTML:'Direct flight',disabled:false};
    const c=helperContext({profileModalTargetId:'usr_partner',profileModalProfile:{vrc_id:'usr_partner',favorite_world_id:world},profileModalRequestSeq:1,
      currentUser:{id:owner},directInviteButtonDefaultHtml:null,DEFAULT_DIRECTFLIGHT_WORLD:world,
      isDisplayedModalTarget:()=>true,getDatingFriendStatus:async()=>true,setProfileFriendActions(){},
      document:{getElementById:id=>id==='btnDirectInvite'?button:id==='setting_region'?{value:'usw'}:null},
      t:key=>key,escHtml:s=>s,confirmDialog:async()=>!cancel,showToast:(message,type)=>toasts.push({message,type}),console,
      apiFetch:async(path,options={})=>{requests.push({path,options});if(path.startsWith('/api/vrc/worlds/'))return response({name:'Fixture'});if(path==='/api/vrc/instances')return createReply;if(path.endsWith('/message'))return response([]);return response({});}});
    vm.runInContext(directSource,c);
    return {c,requests,toasts};
  }
  test('dating direct flight creates a private instance and sends the returned address to both users',async()=>{
    const h=directHarness();await h.c.generateDirectInvite('usr_partner');
    const creates=h.requests.filter(r=>r.path==='/api/vrc/instances');
    assert.equal(creates.length,1);
    assert.deepEqual(JSON.parse(creates[0].options.body),{worldId:world,type:'private',region:'us',ownerId:owner});
    const self=h.requests.find(r=>r.path.includes('/invite/myself/'));
    assert.equal(self.path,'/api/vrc/invite/myself/to/'+encodeURIComponent(location));
    assert.equal('body' in self.options,false);
    const other=h.requests.find(r=>r.path==='/api/vrc/invite/usr_partner');
    assert.equal(JSON.parse(other.options.body).instanceId,location);
    assert.ok(h.requests.indexOf(creates[0])<h.requests.indexOf(self));
    assert.doesNotMatch(directSource,/Math\.random\(|~private\(/);
  });
  test('cancelled or rejected dating creation sends no messages or invites and displays upstream error',async()=>{
    for(const cancel of [true,false]) {
      const h=directHarness(response({error:{message:'Bad response data'}},400),cancel);await h.c.generateDirectInvite('usr_partner');
      assert.equal(h.requests.some(r=>r.path.includes('/invite/')||r.path.includes('/message/')),false);
      assert.equal(h.requests.filter(r=>r.path==='/api/vrc/instances').length,cancel?0:1);
      if(!cancel)assert.equal(h.toasts.at(-1).type,'error');
    }
  });
}
