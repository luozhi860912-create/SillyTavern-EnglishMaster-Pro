import { getContext } from '../../../extensions.js';

const NAME = 'ChatReader';
const STORE = 'cr_v3';
const PGSZ = 50;

// ===== State =====
let S = { lastChar:'', positions:{}, lastViewed:{}, fabPos:null,
    set:{ deRate:1, zhRate:1, audio:'cnenmix', showEN:true, showCN:true, showWW:true, playMode:'seq' }};
let cache={}, chars=[], selChar='', selArt=-1, si=0, pg=0;
let playing=false, ptimer=null, sid=0, voices=[], mobView='list';
let plMode=false, plIdx=0, plArts=[];
let tipEl=null, tipTm=null, keepAl=null;

const $=id=>document.getElementById(id);
const esc=s=>(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const escA=s=>(s||'').replace(/"/g,'&quot;').replace(/</g,'&lt;');
const mob=()=>window.innerWidth<=768;

function toast(m){let t=$('cr-toast');if(!t){t=document.createElement('div');t.id='cr-toast';t.className='cr-toast';document.body.appendChild(t)}
t.textContent=m;t.classList.add('show');clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove('show'),2500)}

// ===== Persistence =====
function load(){try{const d=JSON.parse(localStorage.getItem(STORE));if(d)Object.assign(S,d)}catch(e){}}
function save(){try{localStorage.setItem(STORE,JSON.stringify(S))}catch(e){}}
function savePos(){if(!selChar||selArt<0)return;if(!S.positions[selChar])S.positions[selChar]={};
S.positions[selChar]={ai:selArt,si};S.lastChar=selChar;S.lastViewed[selChar]=selArt;save()}

// ===== Parse =====
function clean(raw){let t=raw||'';
t=t.replace(/<prepare>[\s\S]*?<\/prepare>/gi,'');
t=t.replace(/<details>[\s\S]*?<\/details>/gi,'');
t=t.replace(/<br\s*\/?>/gi,'\n');t=t.replace(/<[^>]+>/g,'');
const a=document.createElement('textarea');a.innerHTML=t;t=a.value;
const ci=t.search(/>\s*选择[：:]/);if(ci>0)t=t.substring(0,ci);return t.trim()}

function isE(l){const e=(l.match(/[a-zA-Z]/g)||[]).length,c=(l.match(/[\u4e00-\u9fff]/g)||[]).length;return e>c&&e>=3}
function isC(l){return(l.match(/[\u4e00-\u9fff]/g)||[]).length>=2}
function isW(l){return((l||'').match(/[a-zA-Z][a-zA-Z'\u2019\-]*\s*\([^)]*[\u4e00-\u9fff][^)]*\)/g)||[]).length>=2}

function parseChat(msgs,cf){const arts=[];let fl=0;
for(let mi=0;mi<msgs.length;mi++){const m=msgs[mi];
if(m.is_user||m.is_system||!m.mes?.trim())continue;
const text=clean(m.mes),lines=text.split('\n').map(l=>l.trim()).filter(l=>l);
const ss=[];let i=0;
while(i<lines.length){
if(i+2<lines.length&&isE(lines[i])&&isC(lines[i+1])&&isW(lines[i+2])){ss.push({en:lines[i],cn:lines[i+1],ww:lines[i+2]});i+=3}
else if(i+1<lines.length&&isE(lines[i])&&isC(lines[i+1])){ss.push({en:lines[i],cn:lines[i+1],ww:''});i+=2}
else i++}
if(!ss.length)continue;fl++;
let title=`#${fl}`;
for(let pi=mi-1;pi>=0;pi--){if(msgs[pi].is_user&&msgs[pi].mes){title=`#${fl} ${clean(msgs[pi].mes).substring(0,40)}`;break}}
arts.push({title,sentences:ss,floor:fl,cf,mi})}
return arts}

// ===== API =====
async function apiP(urls,body){
const ep=Array.isArray(urls)?urls:[urls];
for(const u of ep){try{const r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
if(r.ok)return await r.json()}catch(e){}}return null}

async function loadChar(name,avatar){
if(cache[name]?.loaded)return cache[name];
const d={name,avatar,articles:[],loaded:false};cache[name]=d;
const ctx=getContext();
if(ctx.name2===name&&ctx.chat?.length){d.articles=parseChat(ctx.chat,'current')}
try{const cfs=await apiP(['/api/characters/chats','/getallchatsofcharacter'],{avatar_url:avatar});
if(cfs&&Array.isArray(cfs)){
const cur=ctx.name2===name&&ctx.chat_metadata?.file_name?ctx.chat_metadata.file_name:'';
for(const cf of cfs){const fn=cf.file_name||cf.fileName;if(!fn)continue;
if(cur&&fn.includes(cur))continue;
try{const ms=await apiP(['/api/chats/get','/getchat'],{ch_name:name,file_name:fn,avatar_url:avatar});
if(ms&&Array.isArray(ms)){d.articles.push(...parseChat(ms,fn))}}catch(e){}}
d.articles.forEach((a,i)=>{a.floor=i+1})}}catch(e){}
d.loaded=true;return d}

function getChars(){try{const ctx=getContext();const cs=ctx.characters||[];const m={};
cs.forEach(c=>{if(c.name&&!m[c.name])m[c.name]=c.avatar||''});
if(ctx.name2&&!m[ctx.name2])m[ctx.name2]='';
return Object.entries(m).map(([n,a])=>({name:n,avatar:a}))}catch(e){return[]}}

// ===== Speech =====
function initV(){if(!window.speechSynthesis)return;const l=()=>{voices=speechSynthesis.getVoices()};
l();if(speechSynthesis.onvoiceschanged!==undefined)speechSynthesis.onvoiceschanged=l;setTimeout(l,2e3)}
function fV(lang){if(!voices.length)voices=speechSynthesis.getVoices();
const p=lang.split('-')[0],m=voices.filter(v=>v.lang===lang||v.lang.startsWith(p));
return m.find(v=>v.localService)||m[0]||null}
function s1(t,l,r){return new Promise(res=>{if(!window.speechSynthesis||!t?.trim()){res();return}
const u=new SpeechSynthesisUtterance(t.trim());u.lang=l;u.rate=Math.max(.1,Math.min(5,r||1));
const v=fV(l);if(v)u.voice=v;let d=false;
const f=()=>{if(!d){d=true;clearTimeout(tm);res()}};
const tm=setTimeout(f,Math.max(6e3,t.length*800));u.onend=f;u.onerror=f;
try{speechSynthesis.speak(u)}catch(e){f()}})}
function cs(){try{speechSynthesis.cancel()}catch(e){}}
function spkW(w){if(!w)return;cs();const u=new SpeechSynthesisUtterance(w);
u.lang='en-US';u.rate=S.set.deRate;const v=fV('en-US');if(v)u.voice=v;
try{speechSynthesis.speak(u)}catch(e){}}
function stopP(){playing=false;clearTimeout(ptimer);cs();sid++;stopKA();updMS(false);updFab()}

// ===== Background =====
function startKA(){if(keepAl)return;try{keepAl=new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=');
keepAl.loop=true;keepAl.volume=0.01;keepAl.play().catch(()=>{})}catch(e){}}
function stopKA(){if(keepAl){keepAl.pause();keepAl=null}}
function updMS(p){if(!('mediaSession' in navigator))return;try{
const a=getArt();navigator.mediaSession.metadata=new MediaMetadata({title:a?a.title:'Chat Reader',artist:selChar||'',album:'English Reading'});
navigator.mediaSession.playbackState=p?'playing':'paused';
navigator.mediaSession.setActionHandler('play',()=>togPlay());
navigator.mediaSession.setActionHandler('pause',()=>{stopP();render()});
navigator.mediaSession.setActionHandler('previoustrack',()=>navS(-1));
navigator.mediaSession.setActionHandler('nexttrack',()=>navS(1))}catch(e){}}

function updFab(){const f=$('cr-fab');if(f)f.classList.toggle('cr-playing-indicator',playing)}

// ===== Words =====
function clnW(w){return(w||'').replace(/^[.,!?;:'"()\-–»«\[\]{}\/\\]+/,'').replace(/[.,!?;:'"()\-–»«…\[\]{}\/\\]+$/,'').trim()}
function rcEN(t){if(!t)return'';return t.replace(/\|/g,'').split(/(\s+)/).map(p=>{
if(!p)return'';if(/^\s+$/.test(p))return' ';
if(/[a-zA-Z]/.test(p)){const m=p.match(/^([^a-zA-Z]*)([a-zA-Z][a-zA-Z'\u2019\-]*[a-zA-Z]|[a-zA-Z])([^a-zA-Z]*)$/);
if(m)return esc(m[1])+`<span class="cr-w" data-w="${escA(clnW(m[2]))}">${esc(m[2])}</span>`+esc(m[3]);
return`<span class="cr-w" data-w="${escA(clnW(p))}">${esc(p)}</span>`}return esc(p)}).join('')}

function hideTip(){if(tipEl){tipEl.remove();tipEl=null}if(tipTm){clearTimeout(tipTm);tipTm=null}}
function showTip(el,text){hideTip();const r=el.getBoundingClientRect();
const t=document.createElement('div');t.className='cr-tip';t.textContent=text;
t.style.left=(r.left+r.width/2)+'px';
if(r.top>55){t.style.top=(r.top-6)+'px';t.style.transform='translateX(-50%) translateY(-100%)'}
else{t.style.top=(r.bottom+6)+'px';t.style.transform='translateX(-50%)'}
document.body.appendChild(t);
requestAnimationFrame(()=>{const tr=t.getBoundingClientRect();
if(tr.right>window.innerWidth-6)t.style.left=(window.innerWidth-tr.width/2-6)+'px';
if(tr.left<6)t.style.left=(tr.width/2+6)+'px';t.classList.add('vis')});
tipEl=t;tipTm=setTimeout(hideTip,3500)}

function clickW(el){const w=clnW(el.dataset.w||el.textContent);if(!w)return;
el.classList.add('spk');setTimeout(()=>el.classList.remove('spk'),1200);
spkW(w);hideTip();let tr='';const arts=cache[selChar]?.articles||[];
if(selArt>=0&&arts[selArt])for(const s of arts[selArt].sentences){if(!s.ww)continue;
const rx=new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\s*\\(([^)]+)\\)','i');
const mm=s.ww.match(rx);if(mm){tr=mm[1];break}}
showTip(el,tr||w)}

// ===== Getters =====
function getArt(){return cache[selChar]?.articles?.[selArt]||null}
function getSent(){return getArt()?.sentences?.[si]||null}

// ===== UI =====
function createUI(){
// FAB
const fab=document.createElement('button');fab.id='cr-fab';fab.textContent='📖';
const dp=S.fabPos||{x:mob()?Math.round(window.innerWidth/2-28):window.innerWidth-80,y:Math.round(window.innerHeight/2-28)};
fab.style.left=dp.x+'px';fab.style.top=dp.y+'px';document.body.appendChild(fab);
initDrag(fab);

// Root
const root=document.createElement('div');root.id='cr-root';
root.innerHTML=`<div id="cr-win">
<div class="cr-hd">
<button class="cr-hd-back" id="cr-back">◀</button>
<span class="cr-hd-t" id="cr-title">📖 Chat Reader</span>
<button class="cr-hb" id="cr-collapse" title="展开/收起侧栏">◧</button>
<button class="cr-hb" id="cr-refresh" title="刷新">🔄</button>
<button class="cr-hb" id="cr-setbtn" title="设置">⚙️</button>
<button class="cr-hb" id="cr-close" title="关闭">✕</button>
</div>
<div class="cr-layout">
<div class="cr-sb" id="cr-sb">
<div class="cr-chars" id="cr-chars"></div>
<div class="cr-alist" id="cr-alist"><div class="cr-sb-empty">选择角色卡加载文章</div></div>
<div class="cr-sb-actions" id="cr-sb-act"></div>
</div>
<div class="cr-mn" id="cr-mn">
<div class="cr-vw on" id="vw-welc"><div class="cr-welc"><div style="font-size:2.5rem">📖</div><h3>Chat Article Reader</h3>
<p>选择左侧角色卡，自动扫描所有聊天记录中的三行格式英语学习内容。<br><br>
点击任意英文单词播放发音并显示翻译。<br>支持循环/顺序/随机播放。<br>支持后台播放。</p></div></div>
<div class="cr-vw" id="vw-read">
<div class="cr-rtbar" id="cr-rtbar"></div>
<div class="cr-pm" id="cr-pm" style="display:none"><span id="cr-pm-t">—</span><button class="cr-pm-x" id="cr-pm-x">✕</button></div>
<div class="cr-rpg"><div class="cr-rpg-bar"><div class="cr-rpg-fill" id="cr-pf"></div></div>
<div class="cr-rpg-info"><span id="cr-pi">0/0</span><span id="cr-pt">—</span></div></div>
<div class="cr-pgr" id="cr-pgr"></div>
<div class="cr-rbody" id="cr-rbody"></div>
<div class="cr-ctrls">
<span class="cr-sp" id="cr-spd">${S.set.deRate.toFixed(1)}x</span>
<button class="cr-ct" id="cr-prev">⏮</button>
<button class="cr-ct play" id="cr-play">▶️</button>
<button class="cr-ct" id="cr-next">⏭</button>
<button class="cr-ct loop" id="cr-loop">🔁</button>
<button class="cr-ct" id="cr-golist">📋</button>
</div></div>
<div class="cr-vw" id="vw-set"><div class="cr-set-body" id="cr-set"></div></div>
</div></div></div>`;
document.body.appendChild(root);
if(!mob())initWinDrag()}

// ===== Drag FAB =====
function initDrag(el){let dr=false,mv=false,sx,sy,ex,ey;
function onS(e){dr=true;mv=false;const t=e.touches?e.touches[0]:e;sx=t.clientX;sy=t.clientY;
ex=parseInt(el.style.left);ey=parseInt(el.style.top);e.preventDefault()}
function onM(e){if(!dr)return;const t=e.touches?e.touches[0]:e;
const dx=t.clientX-sx,dy=t.clientY-sy;if(Math.abs(dx)>4||Math.abs(dy)>4)mv=true;
let nx=ex+dx,ny=ey+dy;nx=Math.max(0,Math.min(window.innerWidth-58,nx));
ny=Math.max(0,Math.min(window.innerHeight-58,ny));el.style.left=nx+'px';el.style.top=ny+'px'}
function onE(){dr=false;S.fabPos={x:parseInt(el.style.left),y:parseInt(el.style.top)};save();if(!mv)togPanel()}
el.addEventListener('mousedown',onS);el.addEventListener('touchstart',onS,{passive:false});
document.addEventListener('mousemove',onM);document.addEventListener('touchmove',onM,{passive:false});
document.addEventListener('mouseup',onE);document.addEventListener('touchend',onE)}

function initWinDrag(){const tb=$('cr-win')?.querySelector('.cr-hd');const win=$('cr-win');if(!tb||!win)return;
let dr=false,sx,sy,ox,oy;
tb.addEventListener('mousedown',e=>{if(e.target.closest('.cr-hb')||e.target.closest('.cr-hd-back'))return;
dr=true;const r=win.getBoundingClientRect();sx=e.clientX;sy=e.clientY;ox=r.left;oy=r.top;
win.style.margin='0';win.style.position='absolute'});
document.addEventListener('mousemove',e=>{if(!dr)return;win.style.left=(ox+e.clientX-sx)+'px';win.style.top=(oy+e.clientY-sy)+'px'});
document.addEventListener('mouseup',()=>{dr=false})}

// ===== Panel =====
function togPanel(){const r=$('cr-root');if(!r)return;
if(r.classList.contains('cr-open'))closePanel();else openPanel()}
function openPanel(){$('cr-root')?.classList.add('cr-open');refreshChars();
if(S.lastChar&&!selChar)selectChar(S.lastChar);
if(mob()){mobView='list';updMobView()}}
function closePanel(){$('cr-root')?.classList.remove('cr-open');if(!playing)stopP()}

// ===== Mobile View =====
function updMobView(){if(!mob())return;
$('cr-sb')?.classList.toggle('mob-hide',mobView!=='list');
$('cr-mn')?.classList.toggle('mob-hide',mobView==='list');
$('cr-back').style.display=mobView==='list'?'none':'flex';
if(mobView==='list')$('cr-title').textContent='📖 Chat Reader'}
function goList(){stopP();if(mob()){mobView='list';updMobView()}showVw('welc')}
function goReader(){if(mob()){mobView='reader';updMobView()}}

// ===== View =====
function showVw(v){['vw-welc','vw-read','vw-set'].forEach(id=>{$(id)?.classList.toggle('on',id===`vw-${v}`)})}

// ===== Characters =====
function refreshChars(){chars=getChars();rChars();if(selChar){delete cache[selChar];cache[selChar]=null;selectChar(selChar)}}
function rChars(){const el=$('cr-chars');if(!el)return;
el.innerHTML=chars.map(c=>`<button class="cr-cht${c.name===selChar?' on':''}" data-ch="${escA(c.name)}" data-av="${escA(c.avatar)}">${esc(c.name)}</button>`).join('')||'<span style="color:#444;font-size:.72rem;padding:8px">无角色卡</span>'}

async function selectChar(name){const ch=chars.find(c=>c.name===name);if(!ch){toast('角色不存在');return}
selChar=name;S.lastChar=name;save();rChars();
$('cr-alist').innerHTML='<div style="padding:30px;text-align:center;color:#666;font-size:.82rem">⏳ 扫描中...</div>';
const d=await loadChar(name,ch.avatar);if(selChar!==name)return;
rArts(d.articles);
const sv=S.positions[name];
if(sv&&sv.ai>=0&&sv.ai<d.articles.length){openArt(sv.ai,sv.si||0)}
else showVw('welc')}

function rArts(arts){const el=$('cr-alist');if(!el)return;
if(!arts.length){el.innerHTML='<div class="cr-sb-empty">此角色无三行格式内容</div>';rSbAct(0);return}
const groups={};arts.forEach((a,i)=>{const g=a.cf||'current';if(!groups[g])groups[g]=[];groups[g].push({a,i})});
const lv=S.lastViewed[selChar];let h='';
for(const[f,items]of Object.entries(groups)){
if(Object.keys(groups).length>1){const lb=f==='current'?'📍 当前聊天':'📄 '+f.substring(0,25);
h+=`<div class="cr-chat-lbl">${esc(lb)}</div>`}
items.forEach(({a,i})=>{const cur=i===selArt,last=i===lv&&!cur;
h+=`<div class="cr-ac${cur?' on':''}${last?' last':''}" data-ai="${i}">
<div class="cr-ac-n">${a.floor}</div>
<div class="cr-ac-i"><div class="cr-ac-t">${esc(a.title)}</div><div class="cr-ac-m">${a.sentences.length}句</div></div>
<span class="cr-ac-b">${a.sentences.length}</span></div>`})}
el.innerHTML=h;rSbAct(arts.length)}

function rSbAct(cnt){const el=$('cr-sb-act');if(!el)return;
if(!cnt){el.innerHTML='';return}
const pm=S.set.playMode;
el.innerHTML=`<button class="cr-sba" id="cr-playall">▶ 连续播放(${cnt})</button>
<button class="cr-sba${pm==='seq'?' on':''}" data-pm="seq">🔢 顺序</button>
<button class="cr-sba${pm==='loop'?' on':''}" data-pm="loop">🔁 循环</button>
<button class="cr-sba${pm==='shuffle'?' on':''}" data-pm="shuffle">🔀 随机</button>`}

// ===== Open Article =====
function openArt(idx,startS){const d=cache[selChar];if(!d||!d.articles[idx])return;
selArt=idx;si=startS||0;pg=Math.floor(si/PGSZ);
S.lastViewed[selChar]=idx;savePos();showVw('read');goReader();render();rArts(d.articles);
if(mob())$('cr-title').textContent=d.articles[idx].title}

// ===== Render =====
function rToolbar(){const tb=$('cr-rtbar');if(!tb)return;const s=S.set;
tb.innerHTML=`<button class="cr-rb${s.audio==='cnenmix'?' on':''}" data-am="cnenmix">🔊中英</button>
<button class="cr-rb${s.audio==='enonly'?' on':''}" data-am="enonly">🔊纯英</button>
<button class="cr-rb${s.audio==='wwonly'?' on':''}" data-am="wwonly">🔊词汇</button>
<span class="cr-rb-sep"></span>
<button class="cr-rb${s.showEN?' on':''}" data-sh="en">📝英文</button>
<button class="cr-rb${s.showCN?' on':''}" data-sh="cn">📝中文</button>
<button class="cr-rb${s.showWW?' on':''}" data-sh="ww">📝词汇</button>`}

function render(){const art=getArt();if(!art)return;
const ss=art.sentences,tp=Math.ceil(ss.length/PGSZ);
const ap=Math.floor(si/PGSZ);if(playing&&pg!==ap)pg=ap;
if(pg>=tp)pg=tp-1;if(pg<0)pg=0;
const ps=pg*PGSZ,pe=Math.min(ps+PGSZ,ss.length);

const pf=$('cr-pf');if(pf)pf.style.width=Math.round((si+1)/ss.length*100)+'%';
$('cr-pi').textContent=`${si+1}/${ss.length}`;
$('cr-pt').textContent=art.title;

// Pager
const pgr=$('cr-pgr');if(pgr){
if(tp>1){let h=`<button class="cr-pg" data-p="0" ${pg===0?'disabled':''}>⏮</button>`;
h+=`<button class="cr-pg" data-p="${pg-1}" ${pg===0?'disabled':''}>◀</button>`;
const mx=5;let sp=Math.max(0,pg-2),ep=Math.min(tp,sp+mx);if(ep-sp<mx)sp=Math.max(0,ep-mx);
for(let p=sp;p<ep;p++)h+=`<button class="cr-pg${p===pg?' on':''}" data-p="${p}">${p+1}</button>`;
h+=`<button class="cr-pg" data-p="${pg+1}" ${pg>=tp-1?'disabled':''}>▶</button>`;
h+=`<button class="cr-pg" data-p="${tp-1}" ${pg>=tp-1?'disabled':''}>⏭</button>`;
h+=`<span class="cr-pg-i">${ps+1}-${pe}/${ss.length}</span>`;
pgr.innerHTML=h;pgr.classList.add('on')}
else{pgr.innerHTML='';pgr.classList.remove('on')}}

// Sentences
const bd=$('cr-rbody');if(bd){const st=S.set;let h='';
for(let i=ps;i<pe;i++){const s=ss[i],ac=i===si,pl=i<si;
let cls='cr-st';if(ac)cls+=' act';if(pl)cls+=' pld';
h+=`<div class="${cls}" data-si="${i}"><span class="cr-st-n">#${i+1}</span>
<div class="cr-en${st.showEN?'':' cr-hid'}">${rcEN((s.en||'').replace(/\|/g,''))}</div>
<div class="cr-cn${st.showCN?'':' cr-hid'}">${esc((s.cn||'').replace(/\|/g,''))}</div>
${s.ww?`<div class="cr-ww${st.showWW?'':' cr-hid'}">${rcEN((s.ww||'').replace(/\|/g,''))}</div>`:''}</div>`}
bd.innerHTML=h;
setTimeout(()=>{const a=bd.querySelector('.act');if(a)a.scrollIntoView({behavior:'smooth',block:'center'})},80)}

$('cr-play').textContent=playing?'⏸':'▶️';$('cr-play').classList.toggle('on',playing);
const lb=$('cr-loop');if(lb){const pm=S.set.playMode;lb.classList.toggle('on',pm==='loop');
lb.textContent=pm==='loop'?'🔁':pm==='shuffle'?'🔀':'🔢'}
$('cr-spd').textContent=S.set.deRate.toFixed(1)+'x';

// Playlist bar
const pmb=$('cr-pm');if(pmb){if(plMode){pmb.style.display='flex';
$('cr-pm-t').textContent=`📋 ${art.title} (${plIdx+1}/${plArts.length})`}
else pmb.style.display='none'}
rToolbar();updFab()}

// ===== Playback =====
function togPlay(){if(playing){stopP();render();return}
if(!getArt()){toast('请先选择文章');return}
playing=true;startKA();updMS(true);playStep()}

async function playStep(){if(!playing)return;
const art=getArt();if(!art||si>=art.sentences.length){handleEnd();return}
const np=Math.floor(si/PGSZ);if(np!==pg)pg=np;render();savePos();
const s=art.sentences[si],en=(s.en||'').replace(/\|/g,''),cn=(s.cn||'').replace(/\|/g,'');
const am=S.set.audio;sid++;const my=sid;cs();await new Promise(r=>setTimeout(r,60));
if(sid!==my||!playing)return;

if(am==='wwonly'&&s.ww){
const pairs=(s.ww||'').match(/([a-zA-Z][a-zA-Z'\u2019\-]*)\s*\(([^)]+)\)/g)||[];
for(const pair of pairs){if(sid!==my||!playing)return;
const mm=pair.match(/([a-zA-Z][a-zA-Z'\u2019\-]*)\s*\(([^)]+)\)/);
if(mm){await s1(mm[1],'en-US',S.set.deRate);if(sid!==my||!playing)return;
await s1(mm[2],'zh-CN',S.set.zhRate);if(sid!==my||!playing)return}}}
else{await s1(en,'en-US',S.set.deRate);if(sid!==my||!playing)return;
if(am==='cnenmix'&&cn){await s1(cn,'zh-CN',S.set.zhRate);if(sid!==my||!playing)return}}

ptimer=setTimeout(()=>{if(!playing)return;si++;
if(si>=art.sentences.length)handleEnd();else playStep()},600)}

function handleEnd(){const d=cache[selChar];if(!d){stopP();render();return}
const pm=S.set.playMode;
if(pm==='loop'){si=0;playStep();return}
if(plMode){
if(pm==='shuffle'){plIdx=Math.floor(Math.random()*plArts.length);
selArt=d.articles.indexOf(plArts[plIdx]);si=0;rArts(d.articles);savePos();playStep();return}
plIdx++;if(plIdx>=plArts.length){plIdx=0;toast('🎉 列表播完');stopP();plMode=false;render();return}
selArt=d.articles.indexOf(plArts[plIdx]);si=0;rArts(d.articles);savePos();playStep();return}
// Sequential: next article
if(pm==='shuffle'&&d.articles.length>1){
let ni;do{ni=Math.floor(Math.random()*d.articles.length)}while(ni===selArt&&d.articles.length>1);
selArt=ni;si=0;rArts(d.articles);savePos();playStep();return}
if(selArt+1<d.articles.length){selArt++;si=0;rArts(d.articles);savePos();playStep();return}
si=0;toast('🎉 全部播完');stopP();render()}

function navS(dir){const art=getArt();if(!art)return;stopP();si+=dir;
if(si<0)si=art.sentences.length-1;if(si>=art.sentences.length)si=0;savePos();render();
const s=art.sentences[si];if(s){cs();s1((s.en||'').replace(/\|/g,''),'en-US',S.set.deRate).then(()=>{
if(S.set.audio==='cnenmix'&&s.cn)s1((s.cn||'').replace(/\|/g,''),'zh-CN',S.set.zhRate)})}}

function startPlayAll(){const d=cache[selChar];if(!d?.articles?.length){toast('无文章');return}
plArts=[...d.articles];plIdx=0;plMode=true;
if(S.set.playMode==='shuffle'){plIdx=Math.floor(Math.random()*plArts.length)}
selArt=plArts===d.articles?plIdx:d.articles.indexOf(plArts[plIdx]);
si=0;showVw('read');goReader();rArts(d.articles);
playing=true;startKA();updMS(true);playStep()}

// ===== Settings =====
function rSettings(){const el=$('cr-set');if(!el)return;const s=S.set;
el.innerHTML=`<div style="font-size:1rem;font-weight:600;color:#ccc;margin-bottom:14px">⚙️ 设置</div>
<div class="cr-sr"><label>英语语速</label><div style="display:flex;align-items:center;gap:8px">
<input type="range" id="cr-dr" min="0.5" max="2.5" step="0.1" value="${s.deRate}">
<span class="v" id="cr-drv">${s.deRate.toFixed(1)}x</span></div></div>
<div class="cr-sr"><label>中文语速</label><div style="display:flex;align-items:center;gap:8px">
<input type="range" id="cr-zr" min="0.5" max="2.5" step="0.1" value="${s.zhRate}">
<span class="v" id="cr-zrv">${s.zhRate.toFixed(1)}x</span></div></div>
<div class="cr-sr"><label>播放模式</label><div style="display:flex;gap:4px">
<button class="cr-rb${s.playMode==='seq'?' on':''}" data-spm="seq" style="font-size:.72rem">🔢 顺序</button>
<button class="cr-rb${s.playMode==='loop'?' on':''}" data-spm="loop" style="font-size:.72rem">🔁 循环</button>
<button class="cr-rb${s.playMode==='shuffle'?' on':''}" data-spm="shuffle" style="font-size:.72rem">🔀 随机</button>
</div></div>
<div class="cr-set-info">
<div style="font-weight:600;color:#777;margin-bottom:6px">📖 使用说明</div>
<div>• 自动扫描所有角色卡的全部聊天记录</div>
<div>• 识别三行格式：英文 + 中文翻译 + 逐词标注</div>
<div>• 点击任意英文单词播放发音+翻译</div>
<div>• 🔢 顺序：依次播放所有文章</div>
<div>• 🔁 循环：当前文章无限循环</div>
<div>• 🔀 随机：随机跳转下一篇</div>
<div>• 切出浏览器后继续后台播放</div>
<div>• 自动记录阅读位置和播放进度</div>
<div>• 悬浮按钮可拖动，单击打开/关闭</div>
<div style="margin-top:8px;color:#444">v3.0.0</div></div>`}

// ===== Events =====
function bind(){
$('cr-close')?.addEventListener('click',closePanel);
$('cr-root')?.addEventListener('click',e=>{if(e.target.id==='cr-root'&&!mob())closePanel()});
$('cr-back')?.addEventListener('click',()=>{
const sv=$('vw-set');if(sv?.classList.contains('on')){showVw(selArt>=0?'read':'welc');
if(mob())$('cr-title').textContent=getArt()?.title||'📖 Chat Reader';return}goList()});
$('cr-refresh')?.addEventListener('click',()=>{cache={};refreshChars();toast('🔄 已刷新')});

// Collapse sidebar (PC)
$('cr-collapse')?.addEventListener('click',()=>{$('cr-sb')?.classList.toggle('cr-collapsed')});

// Settings
$('cr-setbtn')?.addEventListener('click',()=>{const sv=$('vw-set');
if(sv?.classList.contains('on')){showVw(selArt>=0?'read':'welc');return}
rSettings();showVw('set');if(mob()){mobView='reader';updMobView();$('cr-title').textContent='⚙️ 设置'}});

// Char tabs
$('cr-chars')?.addEventListener('click',e=>{const b=e.target.closest('.cr-cht');if(b)selectChar(b.dataset.ch)});

// Art list
$('cr-alist')?.addEventListener('click',e=>{const c=e.target.closest('.cr-ac');if(c){openArt(parseInt(c.dataset.ai));return}});

// Sidebar actions
$('cr-sb-act')?.addEventListener('click',e=>{
if(e.target.id==='cr-playall'||e.target.closest('#cr-playall')){startPlayAll();return}
const pm=e.target.closest('[data-pm]');if(pm){S.set.playMode=pm.dataset.pm;save();
rSbAct(cache[selChar]?.articles?.length||0);if(getArt())render()}});

// Toolbar
$('cr-rtbar')?.addEventListener('click',e=>{const b=e.target.closest('.cr-rb');if(!b)return;
if(b.dataset.am){S.set.audio=b.dataset.am;save();render()}
if(b.dataset.sh==='en'){S.set.showEN=!S.set.showEN;save();render()}
if(b.dataset.sh==='cn'){S.set.showCN=!S.set.showCN;save();render()}
if(b.dataset.sh==='ww'){S.set.showWW=!S.set.showWW;save();render()}});

// Pager
$('cr-pgr')?.addEventListener('click',e=>{const b=e.target.closest('.cr-pg');
if(b&&!b.disabled){pg=parseInt(b.dataset.p);render();$('cr-rbody')?.scrollTo(0,0)}});

// Playlist close
$('cr-pm-x')?.addEventListener('click',()=>{plMode=false;stopP();render()});

// Controls
$('cr-play')?.addEventListener('click',togPlay);
$('cr-prev')?.addEventListener('click',()=>navS(-1));
$('cr-next')?.addEventListener('click',()=>navS(1));
$('cr-loop')?.addEventListener('click',()=>{
const modes=['seq','loop','shuffle'];const ci=modes.indexOf(S.set.playMode);
S.set.playMode=modes[(ci+1)%modes.length];save();render();
rSbAct(cache[selChar]?.articles?.length||0);
toast({seq:'🔢 顺序播放',loop:'🔁 单篇循环',shuffle:'🔀 随机播放'}[S.set.playMode])});
$('cr-spd')?.addEventListener('click',()=>{
const sp=[0.5,0.7,0.8,1.0,1.2,1.5,2.0];const ci=sp.indexOf(S.set.deRate);
S.set.deRate=sp[(ci+1)%sp.length];save();render()});
$('cr-golist')?.addEventListener('click',goList);

// Sentence click
$('cr-rbody')?.addEventListener('click',e=>{
const w=e.target.closest('.cr-w');if(w){e.preventDefault();e.stopPropagation();clickW(w);return}
const st=e.target.closest('.cr-st');if(st){const idx=parseInt(st.dataset.si);if(!isNaN(idx)){
si=idx;savePos();if(!playing)render();const art=getArt();if(art?.sentences[idx]){const s=art.sentences[idx];
cs();s1((s.en||'').replace(/\|/g,''),'en-US',S.set.deRate).then(()=>{
if(S.set.audio==='cnenmix'&&s.cn)s1((s.cn||'').replace(/\|/g,''),'zh-CN',S.set.zhRate)})}}}});

// Settings inputs
$('cr-set')?.addEventListener('input',e=>{
if(e.target.id==='cr-dr'){S.set.deRate=parseFloat(e.target.value);$('cr-drv').textContent=S.set.deRate.toFixed(1)+'x';save()}
if(e.target.id==='cr-zr'){S.set.zhRate=parseFloat(e.target.value);$('cr-zrv').textContent=S.set.zhRate.toFixed(1)+'x';save()}});
$('cr-set')?.addEventListener('click',e=>{const pm=e.target.closest('[data-spm]');if(pm){
S.set.playMode=pm.dataset.spm;save();rSettings();if(getArt())render();
rSbAct(cache[selChar]?.articles?.length||0)}});

// Global
document.addEventListener('click',e=>{if(!e.target.closest('.cr-tip')&&!e.target.closest('.cr-w'))hideTip()});

// Keyboard
document.addEventListener('keydown',e=>{if(!$('cr-root')?.classList.contains('cr-open'))return;
if(!$('vw-read')?.classList.contains('on'))return;
const tag=e.target.tagName;if(tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT')return;
if(e.code==='Space'){e.preventDefault();togPlay()}
if(e.key==='ArrowLeft'){e.preventDefault();navS(-1)}
if(e.key==='ArrowRight'){e.preventDefault();navS(1)}
if(e.key==='Escape'){e.preventDefault();goList()}});

// Resize
window.addEventListener('resize',()=>{const f=$('cr-fab');if(f){
let x=parseInt(f.style.left),y=parseInt(f.style.top);
x=Math.max(0,Math.min(window.innerWidth-58,x));
y=Math.max(0,Math.min(window.innerHeight-58,y));
f.style.left=x+'px';f.style.top=y+'px'}})}

// ===== Init =====
jQuery(async()=>{load();createUI();bind();initV();console.log(`[${NAME}] v3.0 loaded`)});
