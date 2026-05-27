import { getContext } from '../../../extensions.js';

const NAME = 'ChatReader';
const STORE = 'cr_state_v2';
const PGSZ = 50;

// ===== State =====
let S = {
    lastChar: '',
    positions: {},
    lastViewed: {},
    settings: { deRate: 1, zhRate: 1, audioMode: 'cnenmix', showEN: true, showCN: true, showWW: true, loop: false },
    fabPos: null,
};
let charCache = {};
let charList = [];
let selChar = '';
let selArtIdx = -1;
let sentIdx = 0;
let pageNum = 0;
let playing = false;
let playTimer = null;
let spkId = 0;
let voices = [];
let mobileView = 'list';
let playlistMode = false;
let playlistIdx = 0;
let playlistArts = [];
let tipEl = null;
let tipTm = null;
let keepAlive = null;

// ===== Helpers =====
const $ = id => document.getElementById(id);
const esc = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const escA = s => (s||'').replace(/"/g,'&quot;').replace(/</g,'&lt;');
const isMob = () => window.innerWidth <= 768;

function toast(m) {
    let t = $('cr-toast');
    if (!t) { t = document.createElement('div'); t.id = 'cr-toast'; t.className = 'cr-toast'; document.body.appendChild(t); }
    t.textContent = m; t.classList.add('cr-show');
    clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('cr-show'), 2500);
}

// ===== Persistence =====
function loadState() { try { const d = JSON.parse(localStorage.getItem(STORE)); if (d) Object.assign(S, d); } catch(e) {} }
function saveState() { try { localStorage.setItem(STORE, JSON.stringify(S)); } catch(e) {} }
function savePosition() {
    if (!selChar || selArtIdx < 0) return;
    if (!S.positions[selChar]) S.positions[selChar] = {};
    S.positions[selChar].articleIdx = selArtIdx;
    S.positions[selChar].sentIdx = sentIdx;
    S.lastChar = selChar;
    S.lastViewed[selChar] = selArtIdx;
    saveState();
}

// ===== Chat Parsing =====
function cleanMsg(raw) {
    let t = raw || '';
    t = t.replace(/<prepare>[\s\S]*?<\/prepare>/gi, '');
    t = t.replace(/<details>[\s\S]*?<\/details>/gi, '');
    t = t.replace(/<br\s*\/?>/gi, '\n');
    t = t.replace(/<[^>]+>/g, '');
    const ta = document.createElement('textarea'); ta.innerHTML = t; t = ta.value;
    const ci = t.search(/>\s*选择[：:]/);
    if (ci > 0) t = t.substring(0, ci);
    return t.trim();
}
function isEN(l) { const e = (l.match(/[a-zA-Z]/g)||[]).length, c = (l.match(/[\u4e00-\u9fff]/g)||[]).length; return e > c && e >= 3; }
function isCN(l) { return (l.match(/[\u4e00-\u9fff]/g)||[]).length >= 2; }
function isWW(l) { return ((l||'').match(/[a-zA-Z][a-zA-Z'\-]*\s*\([^)]*[\u4e00-\u9fff][^)]*\)/g)||[]).length >= 2; }

function parseChat(messages, charName, chatFile) {
    const arts = [];
    let floor = 0;
    for (let mi = 0; mi < messages.length; mi++) {
        const msg = messages[mi];
        if (msg.is_user || msg.is_system) continue;
        if (!msg.mes || !msg.mes.trim()) continue;
        const text = cleanMsg(msg.mes);
        const lines = text.split('\n').map(l => l.trim()).filter(l => l);
        const sents = [];
        let i = 0;
        while (i < lines.length) {
            if (i + 2 < lines.length && isEN(lines[i]) && isCN(lines[i+1]) && isWW(lines[i+2])) {
                sents.push({ en: lines[i], cn: lines[i+1], ww: lines[i+2] }); i += 3;
            } else if (i + 1 < lines.length && isEN(lines[i]) && isCN(lines[i+1])) {
                sents.push({ en: lines[i], cn: lines[i+1], ww: '' }); i += 2;
            } else { i++; }
        }
        if (!sents.length) continue;
        floor++;
        let title = `#${floor}`;
        for (let pi = mi - 1; pi >= 0; pi--) {
            if (messages[pi].is_user && messages[pi].mes) {
                title = `#${floor} ${cleanMsg(messages[pi].mes).substring(0, 40)}`;
                break;
            }
        }
        arts.push({ title, sentences: sents, floor, chatFile: chatFile || 'current', msgIndex: mi });
    }
    return arts;
}

// ===== API =====
async function apiPost(urls, body) {
    const endpoints = Array.isArray(urls) ? urls : [urls];
    for (const url of endpoints) {
        try {
            const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            if (r.ok) return await r.json();
        } catch(e) {}
    }
    return null;
}

async function loadCharData(name, avatar) {
    if (charCache[name]?.loaded) return charCache[name];
    const data = { name, avatar, articles: [], loaded: false };
    charCache[name] = data;

    // Current chat first
    const ctx = getContext();
    if (ctx.name2 === name && ctx.chat?.length) {
        data.articles = parseChat(ctx.chat, name, 'current');
    }

    // Try loading all chat files via API
    try {
        const chatFiles = await apiPost(['/api/characters/chats', '/getallchatsofcharacter'], { avatar_url: avatar });
        if (chatFiles && Array.isArray(chatFiles)) {
            const currentFileName = ctx.name2 === name && ctx.chat_metadata?.file_name ? ctx.chat_metadata.file_name : '';
            for (const cf of chatFiles) {
                const fn = cf.file_name || cf.fileName;
                if (!fn) continue;
                // Skip current chat if already loaded
                if (currentFileName && fn.includes(currentFileName)) continue;
                try {
                    const msgs = await apiPost(['/api/chats/get', '/getchat'], { ch_name: name, file_name: fn, avatar_url: avatar });
                    if (msgs && Array.isArray(msgs)) {
                        const arts = parseChat(msgs, name, fn);
                        data.articles.push(...arts);
                    }
                } catch(e) {}
            }
            // Re-number floors
            data.articles.forEach((a, i) => { a.floor = i + 1; });
        }
    } catch(e) {}

    data.loaded = true;
    return data;
}

function getCharList() {
    try {
        const ctx = getContext();
        const chars = ctx.characters || [];
        const map = {};
        chars.forEach(c => {
            if (c.name && !map[c.name]) map[c.name] = c.avatar || '';
        });
        if (ctx.name2 && !map[ctx.name2]) map[ctx.name2] = '';
        return Object.entries(map).map(([name, avatar]) => ({ name, avatar }));
    } catch(e) { return []; }
}

// ===== Speech =====
function initVoices() {
    if (!window.speechSynthesis) return;
    const l = () => { voices = speechSynthesis.getVoices(); };
    l(); if (speechSynthesis.onvoiceschanged !== undefined) speechSynthesis.onvoiceschanged = l;
    setTimeout(l, 2000);
}
function findV(lang) {
    if (!voices.length) voices = speechSynthesis.getVoices();
    const p = lang.split('-')[0];
    const m = voices.filter(v => v.lang === lang || v.lang.startsWith(p));
    return m.find(v => v.localService) || m[0] || null;
}
function s1(text, lang, rate) {
    return new Promise(res => {
        if (!window.speechSynthesis || !text?.trim()) { res(); return; }
        const u = new SpeechSynthesisUtterance(text.trim());
        u.lang = lang; u.rate = Math.max(.1, Math.min(5, rate||1));
        const v = findV(lang); if (v) u.voice = v;
        let d = false;
        const f = () => { if (!d) { d = true; clearTimeout(tm); res(); } };
        const tm = setTimeout(f, Math.max(6000, text.length * 800));
        u.onend = f; u.onerror = f;
        try { speechSynthesis.speak(u); } catch(e) { f(); }
    });
}
function cs() { try { speechSynthesis.cancel(); } catch(e) {} }
function spkWord(w) {
    if (!w) return; cs();
    const u = new SpeechSynthesisUtterance(w);
    u.lang = 'en-US'; u.rate = S.settings.deRate;
    const v = findV('en-US'); if (v) u.voice = v;
    try { speechSynthesis.speak(u); } catch(e) {}
}
function stopPlay() { playing = false; clearTimeout(playTimer); cs(); spkId++; stopKeepAlive(); updateMediaSession(false); }

// ===== Background Keep-Alive =====
function startKeepAlive() {
    if (keepAlive) return;
    try {
        keepAlive = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=');
        keepAlive.loop = true; keepAlive.volume = 0.01;
        keepAlive.play().catch(() => {});
    } catch(e) {}
}
function stopKeepAlive() { if (keepAlive) { keepAlive.pause(); keepAlive = null; } }
function updateMediaSession(isPlaying) {
    if (!('mediaSession' in navigator)) return;
    try {
        const art = getArt();
        navigator.mediaSession.metadata = new MediaMetadata({ title: art ? art.title : 'Chat Reader', artist: selChar || '', album: 'English Reading' });
        navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
        navigator.mediaSession.setActionHandler('play', () => togglePlay());
        navigator.mediaSession.setActionHandler('pause', () => { stopPlay(); render(); });
        navigator.mediaSession.setActionHandler('previoustrack', () => navSent(-1));
        navigator.mediaSession.setActionHandler('nexttrack', () => navSent(1));
    } catch(e) {}
}

// ===== Clickable Words =====
function cleanW(w) { return (w||'').replace(/^[.,!?;:'"()\-–»«\[\]{}\/\\]+/,'').replace(/[.,!?;:'"()\-–»«…\[\]{}\/\\]+$/,'').trim(); }
function rcEN(text) {
    if (!text) return '';
    return text.replace(/\|/g, '').split(/(\s+)/).map(p => {
        if (!p) return '';
        if (/^\s+$/.test(p)) return ' ';
        if (/[a-zA-Z]/.test(p)) {
            const m = p.match(/^([^a-zA-Z]*)([a-zA-Z][a-zA-Z'\u2019\-]*[a-zA-Z]|[a-zA-Z])([^a-zA-Z]*)$/);
            if (m) return esc(m[1]) + `<span class="cr-w" data-w="${escA(cleanW(m[2]))}">${esc(m[2])}</span>` + esc(m[3]);
            return `<span class="cr-w" data-w="${escA(cleanW(p))}">${esc(p)}</span>`;
        }
        return esc(p);
    }).join('');
}

function hideTip() { if (tipEl) { tipEl.remove(); tipEl = null; } if (tipTm) { clearTimeout(tipTm); tipTm = null; } }
function showTip(el, text) {
    hideTip();
    const r = el.getBoundingClientRect();
    const t = document.createElement('div'); t.className = 'cr-tip'; t.textContent = text;
    t.style.left = (r.left + r.width/2) + 'px';
    if (r.top > 55) { t.style.top = (r.top - 6) + 'px'; t.style.transform = 'translateX(-50%) translateY(-100%)'; }
    else { t.style.top = (r.bottom + 6) + 'px'; t.style.transform = 'translateX(-50%)'; }
    document.body.appendChild(t);
    requestAnimationFrame(() => {
        const tr = t.getBoundingClientRect();
        if (tr.right > window.innerWidth - 6) t.style.left = (window.innerWidth - tr.width/2 - 6) + 'px';
        if (tr.left < 6) t.style.left = (tr.width/2 + 6) + 'px';
        t.classList.add('cr-vis');
    });
    tipEl = t; tipTm = setTimeout(hideTip, 3500);
}
function onClickW(el) {
    const w = cleanW(el.dataset.w || el.textContent);
    if (!w) return;
    el.classList.add('cr-speaking'); setTimeout(() => el.classList.remove('cr-speaking'), 1200);
    spkWord(w);
    hideTip();
    // Search WW lines for translation
    let trans = '';
    const arts = charCache[selChar]?.articles || [];
    if (selArtIdx >= 0 && arts[selArtIdx]) {
        for (const s of arts[selArtIdx].sentences) {
            if (!s.ww) continue;
            const rx = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\(([^)]+)\\)', 'i');
            const mm = s.ww.match(rx);
            if (mm) { trans = mm[1]; break; }
        }
    }
    showTip(el, trans || w);
}

// ===== Getters =====
function getArt() { const d = charCache[selChar]; return d?.articles?.[selArtIdx] || null; }
function getSent() { const a = getArt(); return a?.sentences?.[sentIdx] || null; }

// ===== UI Creation =====
function createUI() {
    // FAB
    const fab = document.createElement('button');
    fab.id = 'cr-fab'; fab.textContent = '📖';
    const pos = S.fabPos || { x: isMob() ? Math.round(window.innerWidth/2 - 28) : window.innerWidth - 70, y: Math.round(window.innerHeight/2 - 28) };
    fab.style.left = pos.x + 'px'; fab.style.top = pos.y + 'px';
    document.body.appendChild(fab);
    initDragFab(fab);

    // Overlay + Window
    const ov = document.createElement('div'); ov.id = 'cr-overlay';
    ov.innerHTML = `<div id="cr-window">
<div class="cr-titlebar" id="cr-titlebar">
    <div class="cr-titlebar-left">
        <button class="cr-titlebar-back" id="cr-back">◀</button>
        <span class="cr-title-text" id="cr-title">📖 Chat Reader</span>
    </div>
    <div class="cr-titlebar-spacer"></div>
    <button class="cr-tb" id="cr-btn-refresh" title="刷新">🔄</button>
    <button class="cr-tb" id="cr-btn-set" title="设置">⚙️</button>
    <button class="cr-tb" id="cr-btn-close" title="关闭">✕</button>
</div>
<div class="cr-body">
    <div class="cr-sidebar" id="cr-sidebar">
        <div class="cr-char-section"><div class="cr-char-tabs" id="cr-chars"></div></div>
        <div class="cr-art-section" id="cr-arts"><div class="cr-sidebar-empty">点击角色卡加载文章</div></div>
    </div>
    <div class="cr-main" id="cr-main">
        <div class="cr-view cr-active" id="cr-v-welcome">
            <div class="cr-welcome"><div class="cr-welcome-icon">📖</div><h3>Chat Article Reader</h3>
            <p>选择左侧角色卡，自动扫描所有聊天记录中的三行格式英语学习内容。<br><br>
            点击任意英文单词可播放发音并显示翻译。<br>支持配音播放、列表播放、后台播放。</p></div>
        </div>
        <div class="cr-view" id="cr-v-reader">
            <div class="cr-reader-toolbar" id="cr-toolbar"></div>
            <div class="cr-playlist-bar" id="cr-pl"><span>📋 <b id="cr-pl-name">—</b></span><button class="cr-tb" id="cr-pl-x" style="width:26px;height:26px;font-size:.75rem">✕</button></div>
            <div class="cr-reader-prog"><div class="cr-prog-bar"><div class="cr-prog-fill" id="cr-pf"></div></div><div class="cr-prog-info"><span id="cr-pi">0/0</span><span id="cr-pt">—</span></div></div>
            <div class="cr-pager" id="cr-pager"></div>
            <div class="cr-reader-body" id="cr-rbody"></div>
            <div class="cr-controls">
                <span class="cr-speed" id="cr-spd">${S.settings.deRate.toFixed(1)}x</span>
                <button class="cr-ctrl" id="cr-prev">⏮</button>
                <button class="cr-ctrl cr-play-main" id="cr-play">▶️</button>
                <button class="cr-ctrl" id="cr-next">⏭</button>
                <button class="cr-ctrl" id="cr-loop">🔁</button>
                <button class="cr-ctrl" id="cr-golist">📋</button>
            </div>
        </div>
        <div class="cr-view" id="cr-v-set">
            <div class="cr-settings-body" id="cr-set"></div>
        </div>
    </div>
</div>
</div>`;
    document.body.appendChild(ov);
    if (!isMob()) initDragWindow();
}

// ===== Drag FAB =====
function initDragFab(el) {
    let dragging = false, moved = false, sx, sy, ex, ey;
    function onS(e) {
        dragging = true; moved = false;
        const t = e.touches ? e.touches[0] : e;
        sx = t.clientX; sy = t.clientY;
        ex = parseInt(el.style.left); ey = parseInt(el.style.top);
        e.preventDefault();
    }
    function onM(e) {
        if (!dragging) return;
        const t = e.touches ? e.touches[0] : e;
        const dx = t.clientX - sx, dy = t.clientY - sy;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
        let nx = ex + dx, ny = ey + dy;
        nx = Math.max(0, Math.min(window.innerWidth - 56, nx));
        ny = Math.max(0, Math.min(window.innerHeight - 56, ny));
        el.style.left = nx + 'px'; el.style.top = ny + 'px';
    }
    function onE() {
        dragging = false;
        S.fabPos = { x: parseInt(el.style.left), y: parseInt(el.style.top) };
        saveState();
        if (!moved) togglePanel();
    }
    el.addEventListener('mousedown', onS);
    el.addEventListener('touchstart', onS, { passive: false });
    document.addEventListener('mousemove', onM);
    document.addEventListener('touchmove', onM, { passive: false });
    document.addEventListener('mouseup', onE);
    document.addEventListener('touchend', onE);
}

// ===== Drag Window (PC) =====
function initDragWindow() {
    const tb = $('cr-titlebar');
    const win = $('cr-window');
    if (!tb || !win) return;
    let dragging = false, sx, sy, ox, oy;
    tb.addEventListener('mousedown', e => {
        if (e.target.closest('.cr-tb') || e.target.closest('.cr-titlebar-back')) return;
        dragging = true;
        const r = win.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY;
        ox = r.left; oy = r.top;
        win.style.margin = '0'; win.style.position = 'absolute';
    });
    document.addEventListener('mousemove', e => {
        if (!dragging) return;
        win.style.left = (ox + e.clientX - sx) + 'px';
        win.style.top = (oy + e.clientY - sy) + 'px';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
}

// ===== Panel Open/Close =====
function togglePanel() {
    const ov = $('cr-overlay');
    if (!ov) return;
    if (ov.classList.contains('cr-open')) { closePanel(); } else { openPanel(); }
}
function openPanel() {
    const ov = $('cr-overlay');
    if (!ov) return;
    ov.classList.add('cr-open');
    refreshCharList();
    // Restore last state
    if (S.lastChar && !selChar) {
        selectChar(S.lastChar);
    }
}
function closePanel() {
    $('cr-overlay')?.classList.remove('cr-open');
    if (!playing) stopPlay();
}

// ===== Char List =====
function refreshCharList() {
    charList = getCharList();
    renderChars();
    // Also refresh current char data
    if (selChar) {
        delete charCache[selChar]?.loaded;
        charCache[selChar] = null;
        selectChar(selChar);
    }
}

function renderChars() {
    const el = $('cr-chars');
    if (!el) return;
    el.innerHTML = charList.map(c =>
        `<button class="cr-char-tab${c.name === selChar ? ' cr-on' : ''}" data-ch="${escA(c.name)}" data-av="${escA(c.avatar)}">${esc(c.name)}</button>`
    ).join('') || '<span style="color:#444;font-size:.75rem;padding:8px">无角色卡</span>';
}

async function selectChar(name) {
    const ch = charList.find(c => c.name === name);
    if (!ch) { toast('角色不存在'); return; }
    selChar = name;
    S.lastChar = name; saveState();
    renderChars();
    $('cr-arts').innerHTML = '<div class="cr-sidebar-loading">⏳ 扫描聊天记录...</div>';

    const data = await loadCharData(name, ch.avatar);
    if (selChar !== name) return; // User switched

    renderArts(data.articles);
    if (data.articles.length === 0) {
        $('cr-arts').innerHTML = '<div class="cr-sidebar-empty">此角色无三行格式内容</div>';
    }

    // Restore position
    const saved = S.positions[name];
    if (saved && saved.articleIdx >= 0 && saved.articleIdx < data.articles.length) {
        openArt(saved.articleIdx, saved.sentIdx || 0);
    }
}

function renderArts(articles) {
    const el = $('cr-arts');
    if (!el) return;
    if (!articles.length) {
        el.innerHTML = '<div class="cr-sidebar-empty">此角色无三行格式内容</div>';
        return;
    }

    // Group by chatFile
    const groups = {};
    articles.forEach((a, i) => {
        const g = a.chatFile || 'current';
        if (!groups[g]) groups[g] = [];
        groups[g].push({ art: a, idx: i });
    });

    const lastViewed = S.lastViewed[selChar];
    let html = '';
    for (const [file, items] of Object.entries(groups)) {
        if (Object.keys(groups).length > 1) {
            const label = file === 'current' ? '📍 当前聊天' : `📄 ${file.substring(0, 25)}`;
            html += `<div class="cr-art-chat-label">${esc(label)}</div>`;
        }
        items.forEach(({ art, idx }) => {
            const isCur = idx === selArtIdx;
            const isLast = idx === lastViewed && !isCur;
            html += `<div class="cr-art-card${isCur ? ' cr-playing' : ''}${isLast ? ' cr-last-viewed' : ''}" data-ai="${idx}">
                <div class="cr-art-num">${art.floor}</div>
                <div class="cr-art-info"><div class="cr-art-name">${esc(art.title)}</div><div class="cr-art-meta">${art.sentences.length}句</div></div>
                <span class="cr-art-badge">${art.sentences.length}</span>
            </div>`;
        });
    }

    // Continuous play button
    html += `<div style="text-align:center;padding:14px">
        <button class="cr-tb" id="cr-playall" style="width:auto;padding:8px 20px;border-radius:20px;font-size:.75rem">
            ▶️ 连续播放全部 (${articles.length}篇)
        </button>
    </div>`;

    el.innerHTML = html;
}

// ===== Open Article =====
function openArt(idx, startSent) {
    const data = charCache[selChar];
    if (!data || !data.articles[idx]) return;
    selArtIdx = idx;
    sentIdx = startSent || 0;
    pageNum = Math.floor(sentIdx / PGSZ);

    S.lastViewed[selChar] = idx;
    savePosition();

    showView('reader');
    render();

    // On mobile, switch to reader
    if (isMob()) {
        mobileView = 'reader';
        $('cr-sidebar')?.classList.add('cr-mob-hide');
        $('cr-main')?.classList.remove('cr-mob-hide');
        $('cr-back').style.display = 'flex';
        $('cr-title').textContent = data.articles[idx].title;
    }

    // Refresh art list to show active
    renderArts(data.articles);
}

// ===== View Switching =====
function showView(v) {
    ['cr-v-welcome', 'cr-v-reader', 'cr-v-set'].forEach(id => {
        $(id)?.classList.toggle('cr-active', id === `cr-v-${v === 'reader' ? 'reader' : v === 'settings' ? 'set' : 'welcome'}`);
    });
}

function goBackToList() {
    stopPlay();
    if (isMob()) {
        mobileView = 'list';
        $('cr-sidebar')?.classList.remove('cr-mob-hide');
        $('cr-main')?.classList.add('cr-mob-hide');
        $('cr-back').style.display = 'none';
        $('cr-title').textContent = '📖 Chat Reader';
    }
}

// ===== Render Reader =====
function renderToolbar() {
    const tb = $('cr-toolbar');
    if (!tb) return;
    const s = S.settings;
    tb.innerHTML = `
        <button class="cr-rtb${s.audioMode==='cnenmix'?' cr-on':''}" data-am="cnenmix">🔊中英</button>
        <button class="cr-rtb${s.audioMode==='enonly'?' cr-on':''}" data-am="enonly">🔊纯英</button>
        <button class="cr-rtb${s.audioMode==='wwonly'?' cr-on':''}" data-am="wwonly">🔊词汇</button>
        <span class="cr-rtb-sep"></span>
        <button class="cr-rtb${s.showEN?' cr-on':''}" data-sh="en">📝英文</button>
        <button class="cr-rtb${s.showCN?' cr-on':''}" data-sh="cn">📝中文</button>
        <button class="cr-rtb${s.showWW?' cr-on':''}" data-sh="ww">📝词汇</button>
        <span class="cr-rtb-sep"></span>
        <button class="cr-rtb${s.loop?' cr-on':''}" data-tog="loop">🔁循环</button>
    `;
}

function render() {
    const art = getArt();
    if (!art) return;
    const ss = art.sentences;
    const tp = Math.ceil(ss.length / PGSZ);
    const ap = Math.floor(sentIdx / PGSZ);
    if (playing && pageNum !== ap) pageNum = ap;
    if (pageNum >= tp) pageNum = tp - 1;
    if (pageNum < 0) pageNum = 0;
    const ps = pageNum * PGSZ, pe = Math.min(ps + PGSZ, ss.length);

    // Progress
    const pf = $('cr-pf'); if (pf) pf.style.width = Math.round((sentIdx+1)/ss.length*100)+'%';
    const pi = $('cr-pi'); if (pi) pi.textContent = `${sentIdx+1}/${ss.length}`;
    const pt = $('cr-pt'); if (pt) pt.textContent = art.title;

    // Pager
    const pg = $('cr-pager');
    if (pg) {
        if (tp > 1) {
            let h = `<button class="cr-pg" data-p="0" ${pageNum===0?'disabled':''}>⏮</button>`;
            h += `<button class="cr-pg" data-p="${pageNum-1}" ${pageNum===0?'disabled':''}>◀</button>`;
            const mx = 5; let sp = Math.max(0, pageNum-2), ep = Math.min(tp, sp+mx);
            if (ep-sp < mx) sp = Math.max(0, ep-mx);
            for (let p = sp; p < ep; p++) h += `<button class="cr-pg${p===pageNum?' cr-on':''}" data-p="${p}">${p+1}</button>`;
            h += `<button class="cr-pg" data-p="${pageNum+1}" ${pageNum>=tp-1?'disabled':''}>▶</button>`;
            h += `<button class="cr-pg" data-p="${tp-1}" ${pageNum>=tp-1?'disabled':''}>⏭</button>`;
            h += `<span class="cr-pg-info">${ps+1}-${pe}/${ss.length}</span>`;
            pg.innerHTML = h; pg.classList.add('cr-show');
        } else { pg.innerHTML = ''; pg.classList.remove('cr-show'); }
    }

    // Sentences
    const bd = $('cr-rbody');
    if (bd) {
        const stg = S.settings;
        let h = '';
        for (let i = ps; i < pe; i++) {
            const s = ss[i];
            const ac = i === sentIdx, pl = i < sentIdx;
            let cls = 'cr-sent'; if (ac) cls += ' cr-active-s'; if (pl) cls += ' cr-played-s';
            h += `<div class="${cls}" data-si="${i}"><span class="cr-sent-n">#${i+1}</span>
                <div class="cr-s-en${stg.showEN?'':' cr-hide'}">${rcEN((s.en||'').replace(/\|/g,''))}</div>
                <div class="cr-s-cn${stg.showCN?'':' cr-hide'}">${esc((s.cn||'').replace(/\|/g,''))}</div>
                ${s.ww ? `<div class="cr-s-ww${stg.showWW?'':' cr-hide'}">${rcEN((s.ww||'').replace(/\|/g,''))}</div>` : ''}
            </div>`;
        }
        bd.innerHTML = h;
        setTimeout(() => {
            const ac = bd.querySelector('.cr-active-s');
            if (ac) ac.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 80);
    }

    // Controls
    const pb = $('cr-play');
    if (pb) { pb.textContent = playing ? '⏸' : '▶️'; pb.classList.toggle('cr-on', playing); }
    const lb = $('cr-loop');
    if (lb) lb.classList.toggle('cr-loop-on', S.settings.loop);
    const sp = $('cr-spd');
    if (sp) sp.textContent = S.settings.deRate.toFixed(1) + 'x';

    // Playlist bar
    const plb = $('cr-pl');
    if (plb) {
        if (playlistMode) {
            plb.classList.add('cr-show');
            const pln = $('cr-pl-name');
            if (pln) pln.textContent = `${art.title} (${playlistIdx+1}/${playlistArts.length})`;
        } else {
            plb.classList.remove('cr-show');
        }
    }

    renderToolbar();
}

// ===== Playback =====
function togglePlay() {
    if (playing) { stopPlay(); render(); return; }
    const art = getArt();
    if (!art) { toast('请先选择文章'); return; }
    playing = true;
    startKeepAlive();
    updateMediaSession(true);
    playStep();
}

async function playStep() {
    if (!playing) return;
    const art = getArt();
    if (!art || sentIdx >= art.sentences.length) { handleEnd(); return; }

    const np = Math.floor(sentIdx / PGSZ);
    if (np !== pageNum) pageNum = np;
    render();
    savePosition();

    const s = art.sentences[sentIdx];
    const en = (s.en||'').replace(/\|/g,'');
    const cn = (s.cn||'').replace(/\|/g,'');
    const am = S.settings.audioMode;

    spkId++; const myId = spkId;
    cs(); await new Promise(r => setTimeout(r, 60));
    if (spkId !== myId || !playing) return;

    if (am === 'wwonly' && s.ww) {
        const pairs = (s.ww||'').match(/([a-zA-Z][a-zA-Z'\u2019\-]*)\s*\(([^)]+)\)/g) || [];
        for (const pair of pairs) {
            if (spkId !== myId || !playing) return;
            const mm = pair.match(/([a-zA-Z][a-zA-Z'\u2019\-]*)\s*\(([^)]+)\)/);
            if (mm) {
                await s1(mm[1], 'en-US', S.settings.deRate);
                if (spkId !== myId || !playing) return;
                await s1(mm[2], 'zh-CN', S.settings.zhRate);
                if (spkId !== myId || !playing) return;
            }
        }
    } else {
        await s1(en, 'en-US', S.settings.deRate);
        if (spkId !== myId || !playing) return;
        if (am === 'cnenmix' && cn) {
            await s1(cn, 'zh-CN', S.settings.zhRate);
            if (spkId !== myId || !playing) return;
        }
    }

    playTimer = setTimeout(() => {
        if (!playing) return;
        sentIdx++;
        if (sentIdx >= art.sentences.length) handleEnd();
        else playStep();
    }, 600);
}

function handleEnd() {
    const data = charCache[selChar];
    if (!data) { stopPlay(); render(); return; }

    if (S.settings.loop) {
        sentIdx = 0; playStep(); return;
    }

    if (playlistMode) {
        playlistIdx++;
        if (playlistIdx >= playlistArts.length) {
            playlistIdx = 0; toast('🎉 列表播放完成');
            stopPlay(); playlistMode = false; render(); return;
        }
        selArtIdx = data.articles.indexOf(playlistArts[playlistIdx]);
        sentIdx = 0;
        savePosition();
        playStep(); return;
    }

    // Continuous play: go to next article of same character
    if (selArtIdx + 1 < data.articles.length) {
        selArtIdx++;
        sentIdx = 0;
        savePosition();
        renderArts(data.articles);
        playStep(); return;
    }

    sentIdx = 0; toast('🎉 全部播放完成');
    stopPlay(); render();
}

function navSent(dir) {
    const art = getArt(); if (!art) return;
    stopPlay();
    sentIdx += dir;
    if (sentIdx < 0) sentIdx = art.sentences.length - 1;
    if (sentIdx >= art.sentences.length) sentIdx = 0;
    savePosition();
    render();
    // Speak current sentence
    const s = art.sentences[sentIdx];
    if (s) {
        cs();
        s1((s.en||'').replace(/\|/g,''), 'en-US', S.settings.deRate).then(() => {
            if (S.settings.audioMode === 'cnenmix' && s.cn) s1((s.cn||'').replace(/\|/g,''), 'zh-CN', S.settings.zhRate);
        });
    }
}

function startPlaylistAll() {
    const data = charCache[selChar];
    if (!data || !data.articles.length) { toast('无文章'); return; }
    playlistArts = [...data.articles];
    playlistIdx = 0;
    playlistMode = true;
    selArtIdx = 0;
    sentIdx = 0;
    showView('reader');
    if (isMob()) {
        mobileView = 'reader';
        $('cr-sidebar')?.classList.add('cr-mob-hide');
        $('cr-main')?.classList.remove('cr-mob-hide');
        $('cr-back').style.display = 'flex';
    }
    playing = true;
    startKeepAlive();
    updateMediaSession(true);
    playStep();
}

// ===== Settings =====
function renderSettings() {
    const el = $('cr-set');
    if (!el) return;
    const s = S.settings;
    el.innerHTML = `
        <div style="font-size:1rem;font-weight:600;color:#ccc;margin-bottom:14px">⚙️ 设置</div>
        <div class="cr-set-row"><label>英语语速</label><div style="display:flex;align-items:center;gap:8px"><input type="range" id="cr-s-dr" min="0.5" max="2.5" step="0.1" value="${s.deRate}"><span class="cr-val" id="cr-v-dr">${s.deRate.toFixed(1)}x</span></div></div>
        <div class="cr-set-row"><label>中文语速</label><div style="display:flex;align-items:center;gap:8px"><input type="range" id="cr-s-zr" min="0.5" max="2.5" step="0.1" value="${s.zhRate}"><span class="cr-val" id="cr-v-zr">${s.zhRate.toFixed(1)}x</span></div></div>
        <div class="cr-set-info">
            <div style="font-weight:600;color:#777;margin-bottom:6px">📖 使用说明</div>
            <div>• 自动扫描所有角色卡的聊天记录</div>
            <div>• 识别三行格式：英文 + 中文翻译 + 逐词标注</div>
            <div>• 点击任意英文单词播放发音并显示翻译</div>
            <div>• 支持连续播放同一角色的所有文章</div>
            <div>• 切出浏览器后继续后台播放</div>
            <div>• 自动记录阅读位置和播放进度</div>
            <div>• 浮动按钮可拖动到任意位置</div>
            <div style="margin-top:8px;color:#444">v2.0.0</div>
        </div>
    `;
}

// ===== Events =====
function bindEvents() {
    // Close
    $('cr-btn-close')?.addEventListener('click', closePanel);
    $('cr-overlay')?.addEventListener('click', e => { if (e.target.id === 'cr-overlay') closePanel(); });

    // Back
    $('cr-back')?.addEventListener('click', goBackToList);

    // Refresh
    $('cr-btn-refresh')?.addEventListener('click', () => {
        charCache = {};
        refreshCharList();
        if (selChar) selectChar(selChar);
        toast('🔄 已刷新');
    });

    // Settings
    $('cr-btn-set')?.addEventListener('click', () => {
        const sv = $('cr-v-set');
        if (sv?.classList.contains('cr-active')) {
            showView(selArtIdx >= 0 ? 'reader' : 'welcome');
        } else {
            renderSettings();
            showView('settings');
            if (isMob()) {
                $('cr-sidebar')?.classList.add('cr-mob-hide');
                $('cr-main')?.classList.remove('cr-mob-hide');
                $('cr-back').style.display = 'flex';
                $('cr-title').textContent = '⚙️ 设置';
            }
        }
    });

    // Character tabs
    $('cr-chars')?.addEventListener('click', e => {
        const btn = e.target.closest('.cr-char-tab');
        if (btn) selectChar(btn.dataset.ch);
    });

    // Article list
    $('cr-arts')?.addEventListener('click', e => {
        const card = e.target.closest('.cr-art-card');
        if (card) { openArt(parseInt(card.dataset.ai)); return; }
        if (e.target.id === 'cr-playall' || e.target.closest('#cr-playall')) { startPlaylistAll(); }
    });

    // Toolbar
    $('cr-toolbar')?.addEventListener('click', e => {
        const btn = e.target.closest('.cr-rtb');
        if (!btn) return;
        if (btn.dataset.am) { S.settings.audioMode = btn.dataset.am; saveState(); render(); }
        if (btn.dataset.sh === 'en') { S.settings.showEN = !S.settings.showEN; saveState(); render(); }
        if (btn.dataset.sh === 'cn') { S.settings.showCN = !S.settings.showCN; saveState(); render(); }
        if (btn.dataset.sh === 'ww') { S.settings.showWW = !S.settings.showWW; saveState(); render(); }
        if (btn.dataset.tog === 'loop') { S.settings.loop = !S.settings.loop; saveState(); render(); }
    });

    // Pager
    $('cr-pager')?.addEventListener('click', e => {
        const btn = e.target.closest('.cr-pg');
        if (btn && !btn.disabled) {
            pageNum = parseInt(btn.dataset.p);
            render();
            $('cr-rbody')?.scrollTo(0, 0);
        }
    });

    // Playlist close
    $('cr-pl-x')?.addEventListener('click', () => {
        playlistMode = false;
        stopPlay();
        render();
    });

    // Controls
    $('cr-play')?.addEventListener('click', togglePlay);
    $('cr-prev')?.addEventListener('click', () => navSent(-1));
    $('cr-next')?.addEventListener('click', () => navSent(1));
    $('cr-loop')?.addEventListener('click', () => { S.settings.loop = !S.settings.loop; saveState(); render(); });
    $('cr-spd')?.addEventListener('click', () => {
        const sp = [0.5, 0.7, 0.8, 1.0, 1.2, 1.5, 2.0];
        const ci = sp.indexOf(S.settings.deRate);
        S.settings.deRate = sp[(ci + 1) % sp.length];
        saveState(); render();
    });
    $('cr-golist')?.addEventListener('click', goBackToList);

    // Sentence click
    $('cr-rbody')?.addEventListener('click', e => {
        const w = e.target.closest('.cr-w');
        if (w) { e.preventDefault(); e.stopPropagation(); onClickW(w); return; }
        const sent = e.target.closest('.cr-sent');
        if (sent) {
            const idx = parseInt(sent.dataset.si);
            if (!isNaN(idx)) {
                sentIdx = idx; savePosition();
                if (!playing) render();
                const art = getArt();
                if (art?.sentences[idx]) {
                    const s = art.sentences[idx];
                    cs();
                    s1((s.en||'').replace(/\|/g,''), 'en-US', S.settings.deRate).then(() => {
                        if (S.settings.audioMode === 'cnenmix' && s.cn) s1((s.cn||'').replace(/\|/g,''), 'zh-CN', S.settings.zhRate);
                    });
                }
            }
        }
    });

    // Settings inputs
    $('cr-set')?.addEventListener('input', e => {
        if (e.target.id === 'cr-s-dr') {
            S.settings.deRate = parseFloat(e.target.value);
            const v = $('cr-v-dr'); if (v) v.textContent = S.settings.deRate.toFixed(1) + 'x';
            saveState();
        }
        if (e.target.id === 'cr-s-zr') {
            S.settings.zhRate = parseFloat(e.target.value);
            const v = $('cr-v-zr'); if (v) v.textContent = S.settings.zhRate.toFixed(1) + 'x';
            saveState();
        }
    });

    // Global tooltip dismiss
    document.addEventListener('click', e => {
        if (!e.target.closest('.cr-tip') && !e.target.closest('.cr-w')) hideTip();
    });

    // Keyboard
    document.addEventListener('keydown', e => {
        const ov = $('cr-overlay');
        if (!ov || !ov.classList.contains('cr-open')) return;
        if ($('cr-v-reader')?.classList.contains('cr-active') === false) return;
        const tag = e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); navSent(-1); }
        if (e.key === 'ArrowRight') { e.preventDefault(); navSent(1); }
        if (e.key === 'Escape') { e.preventDefault(); goBackToList(); }
    });

    // Visibility change for background playback
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && playing) {
            // Page became visible again - speech might have been interrupted
            // The playStep timeout should still be running
        }
    });

    // Window resize - fix FAB position
    window.addEventListener('resize', () => {
        const fab = $('cr-fab');
        if (fab) {
            let x = parseInt(fab.style.left), y = parseInt(fab.style.top);
            x = Math.max(0, Math.min(window.innerWidth - 56, x));
            y = Math.max(0, Math.min(window.innerHeight - 56, y));
            fab.style.left = x + 'px'; fab.style.top = y + 'px';
        }
    });
}

// ===== Init =====
jQuery(async () => {
    loadState();
    createUI();
    bindEvents();
    initVoices();
    console.log(`[${NAME}] v2.0 loaded`);
});
