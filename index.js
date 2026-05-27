import { getContext } from '../../../extensions.js';

const NAME = 'ChatReader';
const STORE = 'cr_state_v3';
const PGSZ = 50;

let S = {
    lastChar: '',
    positions: {},
    lastViewed: {},
    fabPos: null,
    fontSize: 'm',
    playMode: 'seq',
    settings: { deRate: 1, zhRate: 1, audioMode: 'cnenmix', showEN: true, showCN: true, showWW: true, loop: false },
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

const $ = id => document.getElementById(id);
const esc = s => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escA = s => (s || '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const isMob = () => window.innerWidth <= 768;

function toast(m) {
    let t = $('cr-toast');
    if (!t) {
        t = document.createElement('div');
        t.id = 'cr-toast';
        t.className = 'cr-toast';
        document.body.appendChild(t);
    }
    t.textContent = m;
    t.classList.add('cr-show');
    clearTimeout(t._t);
    t._t = setTimeout(() => t.classList.remove('cr-show'), 2500);
}

function loadSt() {
    try {
        const d = JSON.parse(localStorage.getItem(STORE));
        if (d) Object.assign(S, d);
    } catch (e) { /* ignore */ }
}

function saveSt() {
    try {
        localStorage.setItem(STORE, JSON.stringify(S));
    } catch (e) { /* ignore */ }
}

function savePos() {
    if (!selChar || selArtIdx < 0) return;
    if (!S.positions[selChar]) S.positions[selChar] = {};
    S.positions[selChar].articleIdx = selArtIdx;
    S.positions[selChar].sentIdx = sentIdx;
    S.lastChar = selChar;
    S.lastViewed[selChar] = selArtIdx;
    saveSt();
}

function cleanMsg(raw) {
    let t = raw || '';
    t = t.replace(/<prepare>[\s\S]*?<\/prepare>/gi, '');
    t = t.replace(/<details>[\s\S]*?<\/details>/gi, '');
    t = t.replace(/<br\s*\/?>/gi, '\n');
    t = t.replace(/<[^>]+>/g, '');
    const ta = document.createElement('textarea');
    ta.innerHTML = t;
    t = ta.value;
    const ci = t.search(/>\s*选择[：:]/);
    if (ci > 0) t = t.substring(0, ci);
    return t.trim();
}

function isEN(l) {
    const e = (l.match(/[a-zA-Z]/g) || []).length;
    const c = (l.match(/[\u4e00-\u9fff]/g) || []).length;
    return e > c && e >= 3;
}

function isCN(l) {
    return (l.match(/[\u4e00-\u9fff]/g) || []).length >= 2;
}

function isWW(l) {
    return ((l || '').match(/[a-zA-Z][a-zA-Z'\u2019\-]*\s*\([^)]*[\u4e00-\u9fff][^)]*\)/g) || []).length >= 2;
}

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
            if (i + 2 < lines.length && isEN(lines[i]) && isCN(lines[i + 1]) && isWW(lines[i + 2])) {
                sents.push({ en: lines[i], cn: lines[i + 1], ww: lines[i + 2] });
                i += 3;
            } else if (i + 1 < lines.length && isEN(lines[i]) && isCN(lines[i + 1])) {
                sents.push({ en: lines[i], cn: lines[i + 1], ww: '' });
                i += 2;
            } else {
                i++;
            }
        }
        if (!sents.length) continue;
        floor++;
        let title = '#' + floor;
        for (let pi = mi - 1; pi >= 0; pi--) {
            if (messages[pi].is_user && messages[pi].mes) {
                title = '#' + floor + ' ' + cleanMsg(messages[pi].mes).substring(0, 40);
                break;
            }
        }
        arts.push({ title: title, sentences: sents, floor: floor, chatFile: chatFile || 'current', msgIndex: mi });
    }
    return arts;
}

async function apiPost(urls, body) {
    const endpoints = Array.isArray(urls) ? urls : [urls];
    for (const url of endpoints) {
        try {
            const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            if (r.ok) return await r.json();
        } catch (e) { /* ignore */ }
    }
    return null;
}

async function loadCharData(name, avatar) {
    if (charCache[name] && charCache[name].loaded) return charCache[name];
    const data = { name: name, avatar: avatar, articles: [], loaded: false };
    charCache[name] = data;
    const ctx = getContext();
    if (ctx.name2 === name && ctx.chat && ctx.chat.length) {
        data.articles = parseChat(ctx.chat, name, 'current');
    }
    try {
        const chatFiles = await apiPost(['/api/characters/chats', '/getallchatsofcharacter'], { avatar_url: avatar });
        if (chatFiles && Array.isArray(chatFiles)) {
            const currentFileName = (ctx.name2 === name && ctx.chat_metadata && ctx.chat_metadata.file_name) ? ctx.chat_metadata.file_name : '';
            for (const cf of chatFiles) {
                const fn = cf.file_name || cf.fileName;
                if (!fn) continue;
                if (currentFileName && fn.includes(currentFileName)) continue;
                try {
                    const msgs = await apiPost(['/api/chats/get', '/getchat'], { ch_name: name, file_name: fn, avatar_url: avatar });
                    if (msgs && Array.isArray(msgs)) {
                        const arts = parseChat(msgs, name, fn);
                        data.articles.push.apply(data.articles, arts);
                    }
                } catch (e) { /* ignore */ }
            }
            data.articles.forEach(function (a, i) { a.floor = i + 1; });
        }
    } catch (e) { /* ignore */ }
    data.loaded = true;
    return data;
}

function getCharList() {
    try {
        const ctx = getContext();
        const chars = ctx.characters || [];
        const map = {};
        chars.forEach(function (c) {
            if (c.name && !map[c.name]) map[c.name] = c.avatar || '';
        });
        if (ctx.name2 && !map[ctx.name2]) map[ctx.name2] = '';
        return Object.entries(map).map(function (entry) { return { name: entry[0], avatar: entry[1] }; });
    } catch (e) { return []; }
}

function initVoices() {
    if (!window.speechSynthesis) return;
    var l = function () { voices = speechSynthesis.getVoices(); };
    l();
    if (speechSynthesis.onvoiceschanged !== undefined) speechSynthesis.onvoiceschanged = l;
    setTimeout(l, 2000);
}

function findV(lang) {
    if (!voices.length) voices = speechSynthesis.getVoices();
    var p = lang.split('-')[0];
    var m = voices.filter(function (v) { return v.lang === lang || v.lang.startsWith(p); });
    return m.find(function (v) { return v.localService; }) || m[0] || null;
}

function s1(text, lang, rate) {
    return new Promise(function (res) {
        if (!window.speechSynthesis || !text || !text.trim()) { res(); return; }
        var u = new SpeechSynthesisUtterance(text.trim());
        u.lang = lang;
        u.rate = Math.max(0.1, Math.min(5, rate || 1));
        var v = findV(lang);
        if (v) u.voice = v;
        var d = false;
        var f = function () { if (!d) { d = true; clearTimeout(tm); res(); } };
        var tm = setTimeout(f, Math.max(6000, text.length * 800));
        u.onend = f;
        u.onerror = f;
        try { speechSynthesis.speak(u); } catch (e) { f(); }
    });
}

function cs() {
    try { speechSynthesis.cancel(); } catch (e) { /* ignore */ }
}

function spkWord(w) {
    if (!w) return;
    cs();
    var u = new SpeechSynthesisUtterance(w);
    u.lang = 'en-US';
    u.rate = S.settings.deRate;
    var v = findV('en-US');
    if (v) u.voice = v;
    try { speechSynthesis.speak(u); } catch (e) { /* ignore */ }
}

function stopPlay() {
    playing = false;
    clearTimeout(playTimer);
    cs();
    spkId++;
    stopKeepAlive();
    updateMS(false);
}

function startKeepAlive() {
    if (keepAlive) return;
    try {
        keepAlive = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=');
        keepAlive.loop = true;
        keepAlive.volume = 0.01;
        keepAlive.play().catch(function () { /* ignore */ });
    } catch (e) { /* ignore */ }
}

function stopKeepAlive() {
    if (keepAlive) { keepAlive.pause(); keepAlive = null; }
}

function updateMS(isPlaying) {
    if (!('mediaSession' in navigator)) return;
    try {
        var art = getArt();
        navigator.mediaSession.metadata = new MediaMetadata({
            title: art ? art.title : 'Chat Reader',
            artist: selChar || '',
            album: 'English Reading'
        });
        navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
        navigator.mediaSession.setActionHandler('play', function () { togglePlay(); });
        navigator.mediaSession.setActionHandler('pause', function () { stopPlay(); render(); });
        navigator.mediaSession.setActionHandler('previoustrack', function () { navSent(-1); });
        navigator.mediaSession.setActionHandler('nexttrack', function () { navSent(1); });
    } catch (e) { /* ignore */ }
}

function cleanW(w) {
    return (w || '').replace(/^[.,!?;:'"()\-\u2013\u00bb\u00ab\[\]{}\/\\]+/, '').replace(/[.,!?;:'"()\-\u2013\u00bb\u00ab\u2026\[\]{}\/\\]+$/, '').trim();
}

function rcEN(text) {
    if (!text) return '';
    return text.replace(/\|/g, '').split(/(\s+)/).map(function (p) {
        if (!p) return '';
        if (/^\s+$/.test(p)) return ' ';
        if (/[a-zA-Z]/.test(p)) {
            var m = p.match(/^([^a-zA-Z]*)([a-zA-Z][a-zA-Z'\u2019\-]*[a-zA-Z]|[a-zA-Z])([^a-zA-Z]*)$/);
            if (m) return esc(m[1]) + '<span class="cr-w" data-w="' + escA(cleanW(m[2])) + '">' + esc(m[2]) + '</span>' + esc(m[3]);
            return '<span class="cr-w" data-w="' + escA(cleanW(p)) + '">' + esc(p) + '</span>';
        }
        return esc(p);
    }).join('');
}

function hideTip() {
    if (tipEl) { tipEl.remove(); tipEl = null; }
    if (tipTm) { clearTimeout(tipTm); tipTm = null; }
}

function showTip(el, text) {
    hideTip();
    var r = el.getBoundingClientRect();
    var t = document.createElement('div');
    t.className = 'cr-tip';
    t.textContent = text;
    t.style.left = (r.left + r.width / 2) + 'px';
    if (r.top > 55) {
        t.style.top = (r.top - 6) + 'px';
        t.style.transform = 'translateX(-50%) translateY(-100%)';
    } else {
        t.style.top = (r.bottom + 6) + 'px';
        t.style.transform = 'translateX(-50%)';
    }
    document.body.appendChild(t);
    requestAnimationFrame(function () {
        var tr = t.getBoundingClientRect();
        if (tr.right > window.innerWidth - 6) t.style.left = (window.innerWidth - tr.width / 2 - 6) + 'px';
        if (tr.left < 6) t.style.left = (tr.width / 2 + 6) + 'px';
        t.classList.add('cr-vis');
    });
    tipEl = t;
    tipTm = setTimeout(hideTip, 3500);
}

function onClickW(el) {
    var w = cleanW(el.dataset.w || el.textContent);
    if (!w) return;
    el.classList.add('cr-spk');
    setTimeout(function () { el.classList.remove('cr-spk'); }, 1200);
    spkWord(w);
    hideTip();
    var trans = '';
    var arts = charCache[selChar] ? charCache[selChar].articles : [];
    if (selArtIdx >= 0 && arts[selArtIdx]) {
        for (var si = 0; si < arts[selArtIdx].sentences.length; si++) {
            var s = arts[selArtIdx].sentences[si];
            if (!s.ww) continue;
            var rx = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\(([^)]+)\\)', 'i');
            var mm = s.ww.match(rx);
            if (mm) { trans = mm[1]; break; }
        }
    }
    showTip(el, trans || w);
}

function getArt() {
    var d = charCache[selChar];
    return (d && d.articles && d.articles[selArtIdx]) ? d.articles[selArtIdx] : null;
}

function getSent() {
    var a = getArt();
    return (a && a.sentences && a.sentences[sentIdx]) ? a.sentences[sentIdx] : null;
}

function shuf(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
}

function createUI() {
    var fab = document.createElement('button');
    fab.id = 'cr-fab';
    fab.textContent = '\uD83D\uDCD6';
    var pos = S.fabPos || { x: isMob() ? Math.round(window.innerWidth / 2 - 25) : (window.innerWidth - 70), y: Math.round(window.innerHeight / 2 - 25) };
    fab.style.left = pos.x + 'px';
    fab.style.top = pos.y + 'px';
    document.body.appendChild(fab);
    initDragFab(fab);

    var ov = document.createElement('div');
    ov.id = 'cr-overlay';
    ov.innerHTML = '<div id="cr-win">' +
        '<div class="cr-bar" id="cr-bar">' +
            '<button class="cr-bb" id="cr-back" style="display:none">\u25C0</button>' +
            '<span class="cr-bar-title" id="cr-title">\uD83D\uDCD6 Chat Reader</span>' +
            '<button class="cr-bb" id="cr-bref" title="\u5237\u65B0">\uD83D\uDD04</button>' +
            '<button class="cr-bb" id="cr-bset" title="\u8BBE\u7F6E">\u2699\uFE0F</button>' +
            '<button class="cr-bb" id="cr-bclose" title="\u5173\u95ED">\u2715</button>' +
        '</div>' +
        '<div class="cr-body">' +
            '<div class="cr-side" id="cr-side">' +
                '<div class="cr-chars-wrap" id="cr-chars"></div>' +
                '<div class="cr-arts-wrap" id="cr-arts"><div class="cr-side-empty">\u70B9\u51FB\u89D2\u8272\u5361\u52A0\u8F7D\u6587\u7AE0</div></div>' +
            '</div>' +
            '<div class="cr-main" id="cr-main">' +
                '<div class="cr-view cr-active" id="cr-vwel">' +
                    '<div class="cr-welcome"><div class="cr-welcome-icon">\uD83D\uDCD6</div>' +
                    '<h3>Chat Article Reader</h3>' +
                    '<p>\u9009\u62E9\u5DE6\u4FA7\u89D2\u8272\u5361\uFF0C\u81EA\u52A8\u626B\u63CF\u6240\u6709\u804A\u5929\u8BB0\u5F55\u4E2D\u7684\u4E09\u884C\u683C\u5F0F\u82F1\u8BED\u5B66\u4E60\u5185\u5BB9\u3002<br><br>\u70B9\u51FB\u4EFB\u610F\u82F1\u6587\u5355\u8BCD\u53EF\u64AD\u653E\u53D1\u97F3\u5E76\u663E\u793A\u7FFB\u8BD1\u3002<br>\u652F\u6301\u914D\u97F3\u64AD\u653E\u3001\u5217\u8868\u64AD\u653E\u3001\u540E\u53F0\u64AD\u653E\u3002</p>' +
                    '</div>' +
                '</div>' +
                '<div class="cr-view" id="cr-vread">' +
                    '<div class="cr-rtbar" id="cr-toolbar"></div>' +
                    '<div class="cr-fontbar" id="cr-fontbar"></div>' +
                    '<div class="cr-modebar" id="cr-modebar"></div>' +
                    '<div class="cr-plbar" id="cr-pl"><span>\uD83D\uDCCB <b id="cr-plname">\u2014</b></span><button class="cr-bb" id="cr-plx" style="width:26px;height:26px;font-size:.75rem">\u2715</button></div>' +
                    '<div class="cr-prog"><div class="cr-progbar"><div class="cr-progfill" id="cr-pf"></div></div><div class="cr-proginfo"><span id="cr-pi">0/0</span><span id="cr-pt">\u2014</span></div></div>' +
                    '<div class="cr-pager" id="cr-pager"></div>' +
                    '<div class="cr-rbody cr-fs-m" id="cr-rbody"></div>' +
                    '<div class="cr-ctrls">' +
                        '<span class="cr-spd" id="cr-spd">' + S.settings.deRate.toFixed(1) + 'x</span>' +
                        '<button class="cr-c" id="cr-prev">\u23EE</button>' +
                        '<button class="cr-c cr-cplay" id="cr-play">\u25B6\uFE0F</button>' +
                        '<button class="cr-c" id="cr-next">\u23ED</button>' +
                        '<button class="cr-c" id="cr-loop">\uD83D\uDD01</button>' +
                        '<button class="cr-c" id="cr-golist">\uD83D\uDCCB</button>' +
                    '</div>' +
                '</div>' +
                '<div class="cr-view" id="cr-vset">' +
                    '<div class="cr-setbody" id="cr-set"></div>' +
                '</div>' +
            '</div>' +
        '</div>' +
    '</div>';
    document.body.appendChild(ov);
}

function initDragFab(el) {
    var dragging = false;
    var moved = false;
    var sx, sy, ex, ey;
    function onS(e) {
        dragging = true;
        moved = false;
        var t = e.touches ? e.touches[0] : e;
        sx = t.clientX;
        sy = t.clientY;
        ex = parseInt(el.style.left);
        ey = parseInt(el.style.top);
        e.preventDefault();
    }
    function onM(e) {
        if (!dragging) return;
        var t = e.touches ? e.touches[0] : e;
        var dx = t.clientX - sx;
        var dy = t.clientY - sy;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
        var nx = Math.max(0, Math.min(window.innerWidth - 56, ex + dx));
        var ny = Math.max(0, Math.min(window.innerHeight - 56, ey + dy));
        el.style.left = nx + 'px';
        el.style.top = ny + 'px';
    }
    function onE() {
        dragging = false;
        S.fabPos = { x: parseInt(el.style.left), y: parseInt(el.style.top) };
        saveSt();
        if (!moved) togglePanel();
    }
    el.addEventListener('mousedown', onS);
    el.addEventListener('touchstart', onS, { passive: false });
    document.addEventListener('mousemove', onM);
    document.addEventListener('touchmove', onM, { passive: false });
    document.addEventListener('mouseup', onE);
    document.addEventListener('touchend', onE);
}

function togglePanel() {
    var ov = $('cr-overlay');
    if (!ov) return;
    if (ov.classList.contains('cr-open')) {
        closePanel();
    } else {
        openPanel();
    }
}

function openPanel() {
    var ov = $('cr-overlay');
    if (!ov) return;
    ov.classList.add('cr-open');
    if (isMob()) {
        mobileView = 'list';
        $('cr-side').classList.remove('cr-mhide');
        $('cr-main').classList.add('cr-mhide');
        $('cr-back').style.display = 'none';
        $('cr-title').textContent = '\uD83D\uDCD6 Chat Reader';
    }
    refreshCharList();
    if (S.lastChar && !selChar) {
        selectChar(S.lastChar);
    }
}

function closePanel() {
    var ov = $('cr-overlay');
    if (ov) ov.classList.remove('cr-open');
}

function refreshCharList() {
    charList = getCharList();
    renderChars();
}

function renderChars() {
    var el = $('cr-chars');
    if (!el) return;
    if (!charList.length) {
        el.innerHTML = '<span style="color:#aaa;font-size:.75rem;padding:8px">\u65E0\u89D2\u8272\u5361</span>';
        return;
    }
    var h = '';
    for (var i = 0; i < charList.length; i++) {
        var c = charList[i];
        h += '<button class="cr-chtab' + (c.name === selChar ? ' cr-on' : '') + '" data-ch="' + escA(c.name) + '" data-av="' + escA(c.avatar) + '">' + esc(c.name) + '</button>';
    }
    el.innerHTML = h;
}

async function selectChar(name) {
    var ch = charList.find(function (c) { return c.name === name; });
    if (!ch) { toast('\u89D2\u8272\u4E0D\u5B58\u5728'); return; }
    selChar = name;
    S.lastChar = name;
    saveSt();
    renderChars();
    $('cr-arts').innerHTML = '<div class="cr-side-loading">\u23F3 \u626B\u63CF\u804A\u5929\u8BB0\u5F55...</div>';
    var data = await loadCharData(name, ch.avatar);
    if (selChar !== name) return;
    renderArts(data.articles);
    if (data.articles.length === 0) {
        $('cr-arts').innerHTML = '<div class="cr-side-empty">\u6B64\u89D2\u8272\u65E0\u4E09\u884C\u683C\u5F0F\u5185\u5BB9</div>';
    }
    var saved = S.positions[name];
    if (saved && saved.articleIdx >= 0 && saved.articleIdx < data.articles.length) {
        openArt(saved.articleIdx, saved.sentIdx || 0);
    }
}

function renderArts(articles) {
    var el = $('cr-arts');
    if (!el) return;
    if (!articles.length) {
        el.innerHTML = '<div class="cr-side-empty">\u6B64\u89D2\u8272\u65E0\u4E09\u884C\u683C\u5F0F\u5185\u5BB9</div>';
        return;
    }
    var groups = {};
    var groupOrder = [];
    for (var ai = 0; ai < articles.length; ai++) {
        var a = articles[ai];
        var g = a.chatFile || 'current';
        if (!groups[g]) { groups[g] = []; groupOrder.push(g); }
        groups[g].push({ art: a, idx: ai });
    }
    var lastViewed = S.lastViewed[selChar];
    var h = '';
    for (var gi = 0; gi < groupOrder.length; gi++) {
        var file = groupOrder[gi];
        var items = groups[file];
        if (groupOrder.length > 1) {
            var label = file === 'current' ? '\uD83D\uDCCD \u5F53\u524D\u804A\u5929' : '\uD83D\uDCC4 ' + file.substring(0, 25);
            h += '<div class="cr-chat-label">' + esc(label) + '</div>';
        }
        for (var ii = 0; ii < items.length; ii++) {
            var item = items[ii];
            var isCur = item.idx === selArtIdx;
            var isLast = item.idx === lastViewed && !isCur;
            h += '<div class="cr-acard' + (isCur ? ' cr-playing' : '') + (isLast ? ' cr-lastv' : '') + '" data-ai="' + item.idx + '">' +
                '<div class="cr-anum">' + item.art.floor + '</div>' +
                '<div class="cr-ainfo"><div class="cr-aname">' + esc(item.art.title) + '</div><div class="cr-ameta">' + item.art.sentences.length + '\u53E5</div></div>' +
                '<span class="cr-abadge">' + item.art.sentences.length + '</span>' +
            '</div>';
        }
    }
    h += '<div class="cr-playall-wrap"><button class="cr-playall-btn" id="cr-playall">\u25B6\uFE0F \u8FDE\u7EED\u64AD\u653E\u5168\u90E8 (' + articles.length + '\u7BC7)</button></div>';
    el.innerHTML = h;
}

function openArt(idx, startSent) {
    var data = charCache[selChar];
    if (!data || !data.articles[idx]) return;
    selArtIdx = idx;
    sentIdx = startSent || 0;
    pageNum = Math.floor(sentIdx / PGSZ);
    S.lastViewed[selChar] = idx;
    savePos();
    showView('reader');
    render();
    if (isMob()) {
        mobileView = 'reader';
        $('cr-side').classList.add('cr-mhide');
        $('cr-main').classList.remove('cr-mhide');
        $('cr-back').style.display = '';
        $('cr-title').textContent = data.articles[idx].title;
    }
    renderArts(data.articles);
}

function showView(v) {
    var wel = $('cr-vwel');
    var read = $('cr-vread');
    var set = $('cr-vset');
    if (wel) wel.classList.toggle('cr-active', v === 'welcome');
    if (read) read.classList.toggle('cr-active', v === 'reader');
    if (set) set.classList.toggle('cr-active', v === 'settings');
}

function goBackToList() {
    stopPlay();
    if (isMob()) {
        mobileView = 'list';
        $('cr-side').classList.remove('cr-mhide');
        $('cr-main').classList.add('cr-mhide');
        $('cr-back').style.display = 'none';
        $('cr-title').textContent = '\uD83D\uDCD6 Chat Reader';
    }
}

function renderToolbar() {
    var tb = $('cr-toolbar');
    if (!tb) return;
    var s = S.settings;
    tb.innerHTML =
        '<button class="cr-rt' + (s.audioMode === 'cnenmix' ? ' cr-on' : '') + '" data-am="cnenmix">\uD83D\uDD0A\u4E2D\u82F1</button>' +
        '<button class="cr-rt' + (s.audioMode === 'enonly' ? ' cr-on' : '') + '" data-am="enonly">\uD83D\uDD0A\u7EAF\u82F1</button>' +
        '<button class="cr-rt' + (s.audioMode === 'wwonly' ? ' cr-on' : '') + '" data-am="wwonly">\uD83D\uDD0A\u8BCD\u6C47</button>' +
        '<span class="cr-rtsep"></span>' +
        '<button class="cr-rt' + (s.showEN ? ' cr-on' : '') + '" data-sh="en">\uD83D\uDCDD\u82F1\u6587</button>' +
        '<button class="cr-rt' + (s.showCN ? ' cr-on' : '') + '" data-sh="cn">\uD83D\uDCDD\u4E2D\u6587</button>' +
        '<button class="cr-rt' + (s.showWW ? ' cr-on' : '') + '" data-sh="ww">\uD83D\uDCDD\u8BCD\u6C47</button>';
}

function renderFontBar() {
    var fb = $('cr-fontbar');
    if (!fb) return;
    var sizes = [['s', '\u5C0F'], ['m', '\u4E2D'], ['l', '\u5927'], ['xl', '\u7279\u5927']];
    var h = '<label>\u5B57\u53F7:</label>';
    for (var i = 0; i < sizes.length; i++) {
        h += '<button class="cr-fontbtn' + (S.fontSize === sizes[i][0] ? ' cr-on' : '') + '" data-fs="' + sizes[i][0] + '">' + sizes[i][1] + '</button>';
    }
    fb.innerHTML = h;
}

function renderModeBar() {
    var mb = $('cr-modebar');
    if (!mb) return;
    var modes = [['seq', '\u987A\u5E8F'], ['loop', '\u5355\u7BC7\u5FAA\u73AF'], ['shuffle', '\u968F\u673A']];
    var h = '<label>\u64AD\u653E:</label>';
    for (var i = 0; i < modes.length; i++) {
        h += '<button class="cr-modebtn' + (S.playMode === modes[i][0] ? ' cr-on' : '') + '" data-pm="' + modes[i][0] + '">' + modes[i][1] + '</button>';
    }
    mb.innerHTML = h;
}

function applyFontSize() {
    var bd = $('cr-rbody');
    if (!bd) return;
    bd.className = 'cr-rbody cr-fs-' + (S.fontSize || 'm');
}

function render() {
    var art = getArt();
    if (!art) return;
    var ss = art.sentences;
    var tp = Math.ceil(ss.length / PGSZ);
    var ap = Math.floor(sentIdx / PGSZ);
    if (playing && pageNum !== ap) pageNum = ap;
    if (pageNum >= tp) pageNum = tp - 1;
    if (pageNum < 0) pageNum = 0;
    var ps = pageNum * PGSZ;
    var pe = Math.min(ps + PGSZ, ss.length);

    var pf = $('cr-pf');
    if (pf) pf.style.width = Math.round((sentIdx + 1) / ss.length * 100) + '%';
    var pi = $('cr-pi');
    if (pi) pi.textContent = (sentIdx + 1) + '/' + ss.length;
    var pt = $('cr-pt');
    if (pt) pt.textContent = art.title;

    var pg = $('cr-pager');
    if (pg) {
        if (tp > 1) {
            var h = '<button class="cr-pg" data-p="0"' + (pageNum === 0 ? ' disabled' : '') + '>\u23EE</button>';
            h += '<button class="cr-pg" data-p="' + (pageNum - 1) + '"' + (pageNum === 0 ? ' disabled' : '') + '>\u25C0</button>';
            var mx = 5;
            var sp = Math.max(0, pageNum - 2);
            var ep = Math.min(tp, sp + mx);
            if (ep - sp < mx) sp = Math.max(0, ep - mx);
            for (var p = sp; p < ep; p++) {
                h += '<button class="cr-pg' + (p === pageNum ? ' cr-on' : '') + '" data-p="' + p + '">' + (p + 1) + '</button>';
            }
            h += '<button class="cr-pg" data-p="' + (pageNum + 1) + '"' + (pageNum >= tp - 1 ? ' disabled' : '') + '>\u25B6</button>';
            h += '<button class="cr-pg" data-p="' + (tp - 1) + '"' + (pageNum >= tp - 1 ? ' disabled' : '') + '>\u23ED</button>';
            h += '<span class="cr-pginfo">' + (ps + 1) + '-' + pe + '/' + ss.length + '</span>';
            pg.innerHTML = h;
            pg.classList.add('cr-show');
        } else {
            pg.innerHTML = '';
            pg.classList.remove('cr-show');
        }
    }

    var bd = $('cr-rbody');
    if (bd) {
        var stg = S.settings;
        var bh = '';
        for (var i = ps; i < pe; i++) {
            var s = ss[i];
            var ac = i === sentIdx;
            var dn = i < sentIdx;
            var cls = 'cr-sent';
            if (ac) cls += ' cr-act';
            if (dn) cls += ' cr-done';
            bh += '<div class="' + cls + '" data-si="' + i + '">' +
                '<span class="cr-sn">#' + (i + 1) + '</span>' +
                '<div class="cr-en' + (stg.showEN ? '' : ' cr-hide') + '">' + rcEN((s.en || '').replace(/\|/g, '')) + '</div>' +
                '<div class="cr-cn' + (stg.showCN ? '' : ' cr-hide') + '">' + esc((s.cn || '').replace(/\|/g, '')) + '</div>' +
                (s.ww ? '<div class="cr-ww' + (stg.showWW ? '' : ' cr-hide') + '">' + rcEN((s.ww || '').replace(/\|/g, '')) + '</div>' : '') +
            '</div>';
        }
        bd.innerHTML = bh;
        applyFontSize();
        setTimeout(function () {
            var active = bd.querySelector('.cr-act');
            if (active) active.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 80);
    }

    var pb = $('cr-play');
    if (pb) {
        pb.textContent = playing ? '\u23F8' : '\u25B6\uFE0F';
        pb.classList.toggle('cr-on', playing);
    }
    var lb = $('cr-loop');
    if (lb) lb.classList.toggle('cr-loop-on', S.playMode === 'loop');
    var sp = $('cr-spd');
    if (sp) sp.textContent = S.settings.deRate.toFixed(1) + 'x';

    var plb = $('cr-pl');
    if (plb) {
        if (playlistMode) {
            plb.classList.add('cr-show');
            var pln = $('cr-plname');
            if (pln) pln.textContent = art.title + ' (' + (playlistIdx + 1) + '/' + playlistArts.length + ')';
        } else {
            plb.classList.remove('cr-show');
        }
    }

    renderToolbar();
    renderFontBar();
    renderModeBar();
}

function togglePlay() {
    if (playing) {
        stopPlay();
        render();
        return;
    }
    var art = getArt();
    if (!art) { toast('\u8BF7\u5148\u9009\u62E9\u6587\u7AE0'); return; }
    playing = true;
    startKeepAlive();
    updateMS(true);
    playStep();
}

async function playStep() {
    if (!playing) return;
    var art = getArt();
    if (!art || sentIdx >= art.sentences.length) {
        handleEnd();
        return;
    }
    var np = Math.floor(sentIdx / PGSZ);
    if (np !== pageNum) pageNum = np;
    render();
    savePos();

    var s = art.sentences[sentIdx];
    var en = (s.en || '').replace(/\|/g, '');
    var cn = (s.cn || '').replace(/\|/g, '');
    var am = S.settings.audioMode;

    spkId++;
    var myId = spkId;
    cs();
    await new Promise(function (r) { setTimeout(r, 60); });
    if (spkId !== myId || !playing) return;

    if (am === 'wwonly' && s.ww) {
        var pairs = (s.ww || '').match(/([a-zA-Z][a-zA-Z'\u2019\-]*)\s*\(([^)]+)\)/g) || [];
        for (var pi = 0; pi < pairs.length; pi++) {
            if (spkId !== myId || !playing) return;
            var mm = pairs[pi].match(/([a-zA-Z][a-zA-Z'\u2019\-]*)\s*\(([^)]+)\)/);
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

    playTimer = setTimeout(function () {
        if (!playing) return;
        sentIdx++;
        if (sentIdx >= art.sentences.length) {
            handleEnd();
        } else {
            playStep();
        }
    }, 600);
}

function handleEnd() {
    var data = charCache[selChar];
    if (!data) { stopPlay(); render(); return; }

    if (S.playMode === 'loop') {
        sentIdx = 0;
        playStep();
        return;
    }

    if (playlistMode) {
        playlistIdx++;
        if (playlistIdx >= playlistArts.length) {
            playlistIdx = 0;
            toast('\uD83C\uDF89 \u5217\u8868\u64AD\u653E\u5B8C\u6210');
            stopPlay();
            playlistMode = false;
            render();
            return;
        }
        selArtIdx = data.articles.indexOf(playlistArts[playlistIdx]);
        sentIdx = 0;
        savePos();
        playStep();
        return;
    }

    if (S.playMode === 'shuffle') {
        var total = data.articles.length;
        if (total > 1) {
            var next = selArtIdx;
            while (next === selArtIdx) { next = Math.floor(Math.random() * total); }
            selArtIdx = next;
        }
        sentIdx = 0;
        savePos();
        renderArts(data.articles);
        playStep();
        return;
    }

    if (S.playMode === 'seq') {
        if (selArtIdx + 1 < data.articles.length) {
            selArtIdx++;
            sentIdx = 0;
            savePos();
            renderArts(data.articles);
            playStep();
            return;
        }
        sentIdx = 0;
        toast('\uD83C\uDF89 \u5168\u90E8\u64AD\u653E\u5B8C\u6210');
        stopPlay();
        render();
        return;
    }

    sentIdx = 0;
    stopPlay();
    render();
}

function navSent(dir) {
    var art = getArt();
    if (!art) return;
    stopPlay();
    sentIdx += dir;
    if (sentIdx < 0) sentIdx = art.sentences.length - 1;
    if (sentIdx >= art.sentences.length) sentIdx = 0;
    savePos();
    render();
    var s = art.sentences[sentIdx];
    if (s) {
        cs();
        s1((s.en || '').replace(/\|/g, ''), 'en-US', S.settings.deRate).then(function () {
            if (S.settings.audioMode === 'cnenmix' && s.cn) {
                s1((s.cn || '').replace(/\|/g, ''), 'zh-CN', S.settings.zhRate);
            }
        });
    }
}

function startPlaylistAll() {
    var data = charCache[selChar];
    if (!data || !data.articles.length) { toast('\u65E0\u6587\u7AE0'); return; }
    if (S.playMode === 'shuffle') {
        playlistArts = shuf(data.articles);
    } else {
        playlistArts = data.articles.slice();
    }
    playlistIdx = 0;
    playlistMode = true;
    selArtIdx = data.articles.indexOf(playlistArts[0]);
    sentIdx = 0;
    showView('reader');
    if (isMob()) {
        mobileView = 'reader';
        $('cr-side').classList.add('cr-mhide');
        $('cr-main').classList.remove('cr-mhide');
        $('cr-back').style.display = '';
    }
    playing = true;
    startKeepAlive();
    updateMS(true);
    playStep();
}

function renderSettings() {
    var el = $('cr-set');
    if (!el) return;
    var s = S.settings;
    el.innerHTML =
        '<div style="font-size:1rem;font-weight:600;color:#333;margin-bottom:14px">\u2699\uFE0F \u8BBE\u7F6E</div>' +
        '<div class="cr-setrow"><label>\u82F1\u8BED\u8BED\u901F</label><div style="display:flex;align-items:center;gap:8px"><input type="range" id="cr-sdr" min="0.5" max="2.5" step="0.1" value="' + s.deRate + '"><span class="cr-val" id="cr-vdr">' + s.deRate.toFixed(1) + 'x</span></div></div>' +
        '<div class="cr-setrow"><label>\u4E2D\u6587\u8BED\u901F</label><div style="display:flex;align-items:center;gap:8px"><input type="range" id="cr-szr" min="0.5" max="2.5" step="0.1" value="' + s.zhRate + '"><span class="cr-val" id="cr-vzr">' + s.zhRate.toFixed(1) + 'x</span></div></div>' +
        '<div class="cr-setinfo">' +
            '<div style="font-weight:600;color:#555;margin-bottom:6px">\uD83D\uDCD6 \u4F7F\u7528\u8BF4\u660E</div>' +
            '<div>\u2022 \u81EA\u52A8\u626B\u63CF\u6240\u6709\u89D2\u8272\u5361\u7684\u804A\u5929\u8BB0\u5F55</div>' +
            '<div>\u2022 \u8BC6\u522B\u4E09\u884C\u683C\u5F0F\uFF1A\u82F1\u6587 + \u4E2D\u6587\u7FFB\u8BD1 + \u9010\u8BCD\u6807\u6CE8</div>' +
            '<div>\u2022 \u70B9\u51FB\u4EFB\u610F\u82F1\u6587\u5355\u8BCD\u64AD\u653E\u53D1\u97F3\u5E76\u663E\u793A\u7FFB\u8BD1</div>' +
            '<div>\u2022 \u652F\u6301\u987A\u5E8F\u64AD\u653E\u3001\u5355\u7BC7\u5FAA\u73AF\u3001\u968F\u673A\u64AD\u653E</div>' +
            '<div>\u2022 \u5207\u51FA\u6D4F\u89C8\u5668\u540E\u7EE7\u7EED\u540E\u53F0\u64AD\u653E</div>' +
            '<div>\u2022 \u81EA\u52A8\u8BB0\u5F55\u9605\u8BFB\u4F4D\u7F6E\u548C\u64AD\u653E\u8FDB\u5EA6</div>' +
            '<div>\u2022 \u6D6E\u52A8\u6309\u94AE\u53EF\u62D6\u52A8\u5230\u4EFB\u610F\u4F4D\u7F6E</div>' +
            '<div>\u2022 \u652F\u6301\u5C0F/\u4E2D/\u5927/\u7279\u5927\u56DB\u79CD\u5B57\u53F7</div>' +
            '<div style="margin-top:8px;color:#bbb">v3.0.0</div>' +
        '</div>';
}

function bindEvents() {
    $('cr-bclose').addEventListener('click', closePanel);

    $('cr-overlay').addEventListener('click', function (e) {
        if (e.target.id === 'cr-overlay') closePanel();
    });

    $('cr-back').addEventListener('click', function () {
        var sv = $('cr-vset');
        if (sv && sv.classList.contains('cr-active')) {
            if (selArtIdx >= 0) {
                showView('reader');
                if (isMob()) {
                    $('cr-title').textContent = getArt() ? getArt().title : '\uD83D\uDCD6 Chat Reader';
                }
            } else {
                goBackToList();
            }
            return;
        }
        goBackToList();
    });

    $('cr-bref').addEventListener('click', function () {
        charCache = {};
        refreshCharList();
        if (selChar) {
            delete charCache[selChar];
            selectChar(selChar);
        }
        toast('\uD83D\uDD04 \u5DF2\u5237\u65B0');
    });

    $('cr-bset').addEventListener('click', function () {
        var sv = $('cr-vset');
        if (sv && sv.classList.contains('cr-active')) {
            if (selArtIdx >= 0) {
                showView('reader');
                if (isMob()) {
                    $('cr-title').textContent = getArt() ? getArt().title : '\uD83D\uDCD6 Chat Reader';
                }
            } else {
                showView('welcome');
                if (isMob()) goBackToList();
            }
        } else {
            renderSettings();
            showView('settings');
            if (isMob()) {
                $('cr-side').classList.add('cr-mhide');
                $('cr-main').classList.remove('cr-mhide');
                $('cr-back').style.display = '';
                $('cr-title').textContent = '\u2699\uFE0F \u8BBE\u7F6E';
            }
        }
    });

    $('cr-chars').addEventListener('click', function (e) {
        var btn = e.target.closest('.cr-chtab');
        if (btn) selectChar(btn.dataset.ch);
    });

    $('cr-arts').addEventListener('click', function (e) {
        var card = e.target.closest('.cr-acard');
        if (card) {
            openArt(parseInt(card.dataset.ai));
            return;
        }
        if (e.target.id === 'cr-playall' || e.target.closest('#cr-playall')) {
            startPlaylistAll();
        }
    });

    $('cr-toolbar').addEventListener('click', function (e) {
        var btn = e.target.closest('.cr-rt');
        if (!btn) return;
        if (btn.dataset.am) { S.settings.audioMode = btn.dataset.am; saveSt(); render(); }
        if (btn.dataset.sh === 'en') { S.settings.showEN = !S.settings.showEN; saveSt(); render(); }
        if (btn.dataset.sh === 'cn') { S.settings.showCN = !S.settings.showCN; saveSt(); render(); }
        if (btn.dataset.sh === 'ww') { S.settings.showWW = !S.settings.showWW; saveSt(); render(); }
    });

    $('cr-fontbar').addEventListener('click', function (e) {
        var btn = e.target.closest('.cr-fontbtn');
        if (btn) {
            S.fontSize = btn.dataset.fs;
            saveSt();
            renderFontBar();
            applyFontSize();
        }
    });

    $('cr-modebar').addEventListener('click', function (e) {
        var btn = e.target.closest('.cr-modebtn');
        if (btn) {
            S.playMode = btn.dataset.pm;
            saveSt();
            renderModeBar();
            render();
        }
    });

    $('cr-pager').addEventListener('click', function (e) {
        var btn = e.target.closest('.cr-pg');
        if (btn && !btn.disabled) {
            pageNum = parseInt(btn.dataset.p);
            render();
            var bd = $('cr-rbody');
            if (bd) bd.scrollTo(0, 0);
        }
    });

    $('cr-plx').addEventListener('click', function () {
        playlistMode = false;
        stopPlay();
        render();
    });

    $('cr-play').addEventListener('click', togglePlay);
    $('cr-prev').addEventListener('click', function () { navSent(-1); });
    $('cr-next').addEventListener('click', function () { navSent(1); });

    $('cr-loop').addEventListener('click', function () {
        if (S.playMode === 'loop') {
            S.playMode = 'seq';
        } else {
            S.playMode = 'loop';
        }
        saveSt();
        render();
    });

    $('cr-spd').addEventListener('click', function () {
        var sp = [0.5, 0.7, 0.8, 1.0, 1.2, 1.5, 2.0];
        var ci = sp.indexOf(S.settings.deRate);
        S.settings.deRate = sp[(ci + 1) % sp.length];
        saveSt();
        render();
    });

    $('cr-golist').addEventListener('click', goBackToList);

    $('cr-rbody').addEventListener('click', function (e) {
        var w = e.target.closest('.cr-w');
        if (w) {
            e.preventDefault();
            e.stopPropagation();
            onClickW(w);
            return;
        }
        var sent = e.target.closest('.cr-sent');
        if (sent) {
            var idx = parseInt(sent.dataset.si);
            if (!isNaN(idx)) {
                sentIdx = idx;
                savePos();
                if (!playing) render();
                var art = getArt();
                if (art && art.sentences[idx]) {
                    var s = art.sentences[idx];
                    cs();
                    s1((s.en || '').replace(/\|/g, ''), 'en-US', S.settings.deRate).then(function () {
                        if (S.settings.audioMode === 'cnenmix' && s.cn) {
                            s1((s.cn || '').replace(/\|/g, ''), 'zh-CN', S.settings.zhRate);
                        }
                    });
                }
            }
        }
    });

    $('cr-set').addEventListener('input', function (e) {
        if (e.target.id === 'cr-sdr') {
            S.settings.deRate = parseFloat(e.target.value);
            var v = $('cr-vdr');
            if (v) v.textContent = S.settings.deRate.toFixed(1) + 'x';
            saveSt();
        }
        if (e.target.id === 'cr-szr') {
            S.settings.zhRate = parseFloat(e.target.value);
            var v2 = $('cr-vzr');
            if (v2) v2.textContent = S.settings.zhRate.toFixed(1) + 'x';
            saveSt();
        }
    });

    document.addEventListener('click', function (e) {
        if (!e.target.closest('.cr-tip') && !e.target.closest('.cr-w')) {
            hideTip();
        }
    });

    document.addEventListener('keydown', function (e) {
        var ov = $('cr-overlay');
        if (!ov || !ov.classList.contains('cr-open')) return;
        var vr = $('cr-vread');
        if (!vr || !vr.classList.contains('cr-active')) return;
        var tag = e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); navSent(-1); }
        if (e.key === 'ArrowRight') { e.preventDefault(); navSent(1); }
        if (e.key === 'Escape') { e.preventDefault(); goBackToList(); }
    });

    window.addEventListener('resize', function () {
        var fab = $('cr-fab');
        if (fab) {
            var x = parseInt(fab.style.left);
            var y = parseInt(fab.style.top);
            x = Math.max(0, Math.min(window.innerWidth - 56, x));
            y = Math.max(0, Math.min(window.innerHeight - 56, y));
            fab.style.left = x + 'px';
            fab.style.top = y + 'px';
        }
    });
}

jQuery(async function () {
    loadSt();
    createUI();
    bindEvents();
    initVoices();
    console.log('[' + NAME + '] v3.0 loaded');
});
