import { getContext } from '../../../extensions.js';

const EXT_NAME = 'Chat Article Reader';
const STORE_KEY = 'cr_data_v6';
const PAGE_SIZE = 50;

let state = {
    lastChar: '',
    positions: {},
    lastViewed: {},
    fontSize: 'm',
    playMode: 'seq',
    settings: {
        enRate: 1,
        cnRate: 1,
        audioMode: 'cnenmix',
        showEN: true,
        showCN: true,
        showWW: true
    }
};

let charDataCache = {};
let charList = [];
let selectedChar = '';
let selectedArt = -1;
let sentenceIdx = 0;
let pageIdx = 0;
let isPlaying = false;
let playTimer = null;
let speechId = 0;
let voiceList = [];
let mobileScreen = 'list';
let playlistOn = false;
let playlistIdx = 0;
let playlistArts = [];
let tooltipEl = null;
let tooltipTimer = null;
let keepAliveAudio = null;
let renderPending = false;
let panelCreated = false;

function byId(id) {
    return document.getElementById(id);
}

function escHtml(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(s) {
    if (!s) return '';
    return s.replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function isMobile() {
    return window.innerWidth <= 768;
}

function showToast(msg) {
    let t = byId('cr-toast');
    if (!t) {
        t = document.createElement('div');
        t.id = 'cr-toast';
        t.className = 'cr-toast';
        document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(t._tm);
    t._tm = setTimeout(() => t.classList.remove('on'), 2200);
}

function loadState() {
    try {
        const raw = localStorage.getItem(STORE_KEY);
        if (raw) {
            const d = JSON.parse(raw);
            if (d.lastChar !== undefined) state.lastChar = d.lastChar;
            if (d.positions) state.positions = d.positions;
            if (d.lastViewed) state.lastViewed = d.lastViewed;
            if (d.fontSize) state.fontSize = d.fontSize;
            if (d.playMode) state.playMode = d.playMode;
            if (d.settings) {
                const s = d.settings;
                if (s.enRate !== undefined) state.settings.enRate = s.enRate;
                if (s.cnRate !== undefined) state.settings.cnRate = s.cnRate;
                if (s.audioMode) state.settings.audioMode = s.audioMode;
                if (s.showEN !== undefined) state.settings.showEN = s.showEN;
                if (s.showCN !== undefined) state.settings.showCN = s.showCN;
                if (s.showWW !== undefined) state.settings.showWW = s.showWW;
            }
        }
    } catch (e) {}
}

function saveState() {
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {}
}

function savePos() {
    if (!selectedChar || selectedArt < 0) return;
    if (!state.positions[selectedChar]) state.positions[selectedChar] = {};
    state.positions[selectedChar].a = selectedArt;
    state.positions[selectedChar].s = sentenceIdx;
    state.lastChar = selectedChar;
    state.lastViewed[selectedChar] = selectedArt;
    saveState();
}

function cleanMsg(raw) {
    let t = raw || '';
    t = t.replace(/<prepare>[\s\S]*?<\/prepare>/gi, '');
    t = t.replace(/<details>[\s\S]*?<\/details>/gi, '');
    t = t.replace(/<br\s*\/?>/gi, '\n');
    t = t.replace(/<[^>]+>/g, '');
    const tmp = document.createElement('textarea');
    tmp.innerHTML = t;
    t = tmp.value;
    return t.trim();
}

function isEnLine(line) {
    const en = (line.match(/[a-zA-Z]/g) || []).length;
    const cn = (line.match(/[\u4e00-\u9fff]/g) || []).length;
    return en > cn && en >= 3;
}

function isCnLine(line) {
    return (line.match(/[\u4e00-\u9fff]/g) || []).length >= 2;
}

function isWwLine(line) {
    if (!line) return false;
    const m = line.match(/[a-zA-Z][a-zA-Z'\u2019\-]*\s*\([^)]*[\u4e00-\u9fff][^)]*\)/g);
    return m && m.length >= 2;
}

function parseMessages(messages, chatFile) {
    const articles = [];
    let floor = 0;

    for (let mi = 0; mi < messages.length; mi++) {
        const msg = messages[mi];
        if (!msg || msg.is_user || msg.is_system) continue;
        if (!msg.mes || !msg.mes.trim()) continue;

        const text = cleanMsg(msg.mes);
        if (!text) continue;

        const rawLines = text.split('\n');
        const lines = [];
        for (let li = 0; li < rawLines.length; li++) {
            const trimmed = rawLines[li].trim();
            if (trimmed) lines.push(trimmed);
        }

        const sents = [];
        let i = 0;
        while (i < lines.length) {
            if (i + 2 < lines.length && isEnLine(lines[i]) && isCnLine(lines[i + 1]) && isWwLine(lines[i + 2])) {
                sents.push({ en: lines[i], cn: lines[i + 1], ww: lines[i + 2] });
                i += 3;
            } else if (i + 1 < lines.length && isEnLine(lines[i]) && isCnLine(lines[i + 1])) {
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
            if (messages[pi] && messages[pi].is_user && messages[pi].mes) {
                const ut = cleanMsg(messages[pi].mes);
                if (ut) title = '#' + floor + ' ' + ut.substring(0, 30);
                break;
            }
        }

        articles.push({ title, sentences: sents, floor, chatFile: chatFile || 'current' });
    }

    return articles;
}

async function fetchPost(urls, body) {
    const endpoints = Array.isArray(urls) ? urls : [urls];
    for (const url of endpoints) {
        try {
            const r = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (r.ok) return await r.json();
        } catch (e) {}
    }
    return null;
}

async function loadCharData(name, avatar) {
    if (charDataCache[name] && charDataCache[name].loaded) return charDataCache[name];

    const data = { name, articles: [], loaded: false };
    charDataCache[name] = data;

    try {
        const ctx = getContext();
        if (ctx && ctx.name2 === name && ctx.chat && ctx.chat.length > 0) {
            data.articles = parseMessages(ctx.chat, 'current');
        }
    } catch (e) {}

    try {
        const ctx = getContext();
        const av = avatar || (ctx && ctx.characters ? (ctx.characters.find(c => c.name === name) || {}).avatar : '') || '';
        const chatFiles = await fetchPost(['/api/characters/chats', '/getallchatsofcharacter'], { avatar_url: av });

        if (chatFiles && Array.isArray(chatFiles)) {
            let currentFile = '';
            try {
                const ctx2 = getContext();
                if (ctx2 && ctx2.name2 === name && ctx2.chat_metadata && ctx2.chat_metadata.file_name) {
                    currentFile = ctx2.chat_metadata.file_name;
                }
            } catch (e) {}

            for (const cf of chatFiles) {
                const fn = cf.file_name || cf.fileName;
                if (!fn) continue;
                if (currentFile && fn.indexOf(currentFile) >= 0) continue;

                try {
                    const msgs = await fetchPost(['/api/chats/get', '/getchat'], { ch_name: name, file_name: fn, avatar_url: av });
                    if (msgs && Array.isArray(msgs)) {
                        const arts = parseMessages(msgs, fn);
                        for (const a of arts) data.articles.push(a);
                    }
                } catch (e) {}
            }

            for (let i = 0; i < data.articles.length; i++) {
                data.articles[i].floor = i + 1;
            }
        }
    } catch (e) {}

    data.loaded = true;
    return data;
}

function getCharList() {
    const result = [];
    try {
        const ctx = getContext();
        if (!ctx) return result;
        const seen = {};
        const chars = ctx.characters || [];
        for (const c of chars) {
            if (c && c.name && !seen[c.name]) {
                seen[c.name] = true;
                result.push({ name: c.name, avatar: c.avatar || '' });
            }
        }
        if (ctx.name2 && !seen[ctx.name2]) {
            result.push({ name: ctx.name2, avatar: '' });
        }
    } catch (e) {}
    return result;
}

function initVoices() {
    if (!window.speechSynthesis) return;
    const load = () => { voiceList = speechSynthesis.getVoices(); };
    load();
    if (speechSynthesis.onvoiceschanged !== undefined) speechSynthesis.onvoiceschanged = load;
    setTimeout(load, 2000);
}

function findVoice(lang) {
    if (!voiceList.length) voiceList = speechSynthesis.getVoices();
    const prefix = lang.split('-')[0];
    const matches = voiceList.filter(v => v.lang === lang || v.lang.indexOf(prefix) === 0);
    return matches.find(v => v.localService) || matches[0] || null;
}

function speak(text, lang, rate) {
    return new Promise(resolve => {
        if (!window.speechSynthesis || !text || !text.trim()) { resolve(); return; }
        const u = new SpeechSynthesisUtterance(text.trim());
        u.lang = lang;
        u.rate = Math.max(0.1, Math.min(5, rate || 1));
        const v = findVoice(lang);
        if (v) u.voice = v;
        let done = false;
        const finish = () => { if (!done) { done = true; clearTimeout(tm); resolve(); } };
        const tm = setTimeout(finish, Math.max(8000, text.length * 600));
        u.onend = finish;
        u.onerror = finish;
        try { speechSynthesis.speak(u); } catch (e) { finish(); }
    });
}

function cancelSpeak() {
    try { speechSynthesis.cancel(); } catch (e) {}
}

function speakWord(w) {
    if (!w) return;
    cancelSpeak();
    const u = new SpeechSynthesisUtterance(w);
    u.lang = 'en-US';
    u.rate = state.settings.enRate;
    const v = findVoice('en-US');
    if (v) u.voice = v;
    try { speechSynthesis.speak(u); } catch (e) {}
}

function stopPlay() {
    isPlaying = false;
    clearTimeout(playTimer);
    cancelSpeak();
    speechId++;
    stopKeepAlive();
    updateMS(false);
}

function startKeepAlive() {
    if (keepAliveAudio) return;
    try {
        keepAliveAudio = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=');
        keepAliveAudio.loop = true;
        keepAliveAudio.volume = 0.01;
        keepAliveAudio.play().catch(() => {});
    } catch (e) {}
}

function stopKeepAlive() {
    if (keepAliveAudio) { keepAliveAudio.pause(); keepAliveAudio = null; }
}

function updateMS(playing) {
    if (!('mediaSession' in navigator)) return;
    try {
        const art = getArt();
        navigator.mediaSession.metadata = new MediaMetadata({
            title: art ? art.title : 'Chat Reader',
            artist: selectedChar || '',
            album: 'English'
        });
        navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
        navigator.mediaSession.setActionHandler('play', () => togglePlay());
        navigator.mediaSession.setActionHandler('pause', () => { stopPlay(); schedRender(); });
        navigator.mediaSession.setActionHandler('previoustrack', () => navSent(-1));
        navigator.mediaSession.setActionHandler('nexttrack', () => navSent(1));
    } catch (e) {}
}

function cleanW(w) {
    return (w || '').replace(/^[.,!?;:'"()\-\u2013\u00bb\u00ab\[\]{}\/\\]+/, '').replace(/[.,!?;:'"()\-\u2013\u00bb\u00ab\u2026\[\]{}\/\\]+$/, '').trim();
}

function renderEN(text) {
    if (!text) return '';
    const cleaned = text.replace(/\|/g, '');
    const parts = cleaned.split(/(\s+)/);
    let html = '';
    for (const part of parts) {
        if (!part) continue;
        if (/^\s+$/.test(part)) { html += ' '; continue; }
        if (/[a-zA-Z]/.test(part)) {
            const m = part.match(/^([^a-zA-Z]*)([a-zA-Z][a-zA-Z'\u2019\-]*[a-zA-Z]|[a-zA-Z])([^a-zA-Z]*)$/);
            if (m) {
                html += escHtml(m[1]) + '<span class="cr-word" data-w="' + escAttr(cleanW(m[2])) + '">' + escHtml(m[2]) + '</span>' + escHtml(m[3]);
            } else {
                html += '<span class="cr-word" data-w="' + escAttr(cleanW(part)) + '">' + escHtml(part) + '</span>';
            }
        } else {
            html += escHtml(part);
        }
    }
    return html;
}

function hideTip() {
    if (tooltipEl) { tooltipEl.remove(); tooltipEl = null; }
    if (tooltipTimer) { clearTimeout(tooltipTimer); tooltipTimer = null; }
}

function showTip(el, text) {
    hideTip();
    const r = el.getBoundingClientRect();
    const tip = document.createElement('div');
    tip.className = 'cr-tooltip';
    tip.textContent = text;
    tip.style.left = (r.left + r.width / 2) + 'px';
    if (r.top > 50) {
        tip.style.top = (r.top - 5) + 'px';
        tip.style.transform = 'translateX(-50%) translateY(-100%)';
    } else {
        tip.style.top = (r.bottom + 5) + 'px';
        tip.style.transform = 'translateX(-50%)';
    }
    document.body.appendChild(tip);
    requestAnimationFrame(() => {
        const tr = tip.getBoundingClientRect();
        if (tr.right > window.innerWidth - 4) tip.style.left = (window.innerWidth - tr.width / 2 - 4) + 'px';
        if (tr.left < 4) tip.style.left = (tr.width / 2 + 4) + 'px';
        tip.classList.add('visible');
    });
    tooltipEl = tip;
    tooltipTimer = setTimeout(hideTip, 3000);
}

function onWordClick(el) {
    const w = cleanW(el.dataset.w || el.textContent);
    if (!w) return;
    el.classList.add('speaking');
    setTimeout(() => el.classList.remove('speaking'), 1000);
    speakWord(w);
    hideTip();

    let trans = '';
    const cd = charDataCache[selectedChar];
    if (cd && selectedArt >= 0 && cd.articles[selectedArt]) {
        const sents = cd.articles[selectedArt].sentences;
        for (const s of sents) {
            if (!s.ww) continue;
            const rx = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\(([^)]+)\\)', 'i');
            const found = s.ww.match(rx);
            if (found) { trans = found[1]; break; }
        }
    }
    showTip(el, trans || w);
}

function getArt() {
    const d = charDataCache[selectedChar];
    return (d && d.articles && d.articles[selectedArt]) ? d.articles[selectedArt] : null;
}

function createPanel() {
    if (panelCreated) return;
    panelCreated = true;

    const panel = document.createElement('div');
    panel.id = 'cr-panel';
    panel.innerHTML =
        '<div class="cr-topbar">' +
            '<button class="cr-topbar-back" id="crBack">◀</button>' +
            '<span class="cr-topbar-title" id="crTitle">📖 Chat Reader</span>' +
            '<button class="cr-topbtn" id="crRefresh" title="刷新">♻</button>' +
            '<button class="cr-topbtn" id="crSettings" title="设置">⚙</button>' +
            '<button class="cr-topbtn" id="crClose" title="关闭">✕</button>' +
        '</div>' +
        '<div class="cr-body">' +
            '<div class="cr-sidebar" id="crSidebar">' +
                '<div class="cr-chartabs" id="crChars"></div>' +
                '<div class="cr-artlist" id="crArts"><div class="cr-empty">点击角色卡加载文章</div></div>' +
            '</div>' +
            '<div class="cr-main" id="crMain">' +
                '<div class="cr-view on" id="crVWel">' +
                    '<div class="cr-welcome"><div style="font-size:48px">📖</div><h3>Chat Article Reader</h3><p>选择左侧角色卡，自动扫描聊天记录。<br>点击英文单词播放发音并显示翻译。<br>支持顺序、循环、随机播放。</p></div>' +
                '</div>' +
                '<div class="cr-view" id="crVRead">' +
                    '<div class="cr-toolbar" id="crToolbar"></div>' +
                    '<div class="cr-optbar" id="crFontBar"></div>' +
                    '<div class="cr-optbar" id="crModeBar"></div>' +
                    '<div class="cr-plbar" id="crPL"><span>📋 <b id="crPLName">—</b></span><button class="cr-topbtn" id="crPLClose" style="width:24px;height:24px;font-size:11px">✕</button></div>' +
                    '<div class="cr-progress"><div class="cr-progbar"><div class="cr-progfill" id="crProgFill"></div></div><div class="cr-progmeta"><span id="crProgIdx">0/0</span><span id="crProgTitle">—</span></div></div>' +
                    '<div class="cr-pager" id="crPager"></div>' +
                    '<div class="cr-reader fs-m" id="crReader"></div>' +
                    '<div class="cr-controls">' +
                        '<span class="cr-speedbtn" id="crSpeed">1.0x</span>' +
                        '<button class="cr-ctrl" id="crPrev">⏮</button>' +
                        '<button class="cr-ctrl playbtn" id="crPlay">▶️</button>' +
                        '<button class="cr-ctrl" id="crNext">⏭</button>' +
                        '<button class="cr-ctrl" id="crLoop">🔁</button>' +
                        '<button class="cr-ctrl" id="crGoList">📋</button>' +
                    '</div>' +
                '</div>' +
                '<div class="cr-view" id="crVSet">' +
                    '<div class="cr-setbody" id="crSetBody"></div>' +
                '</div>' +
            '</div>' +
        '</div>';

    document.body.appendChild(panel);
    bindEvents();
}

function addSettingsUI() {
    const settingsHtml = `
    <div id="cr-settings-block" class="extension_block">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>📖 Chat Article Reader</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
            </div>
            <div class="inline-drawer-content">
                <button id="cr-launch-btn" class="cr-open-btn">📖 打开阅读器</button>
                <div class="cr-desc">
                    扫描聊天记录中的英语学习内容。<br>
                    支持三行格式：英文 + 中文 + 逐词标注。
                </div>
            </div>
        </div>
    </div>`;

    const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (container) {
        container.insertAdjacentHTML('beforeend', settingsHtml);
    }

    setTimeout(() => {
        const btn = document.getElementById('cr-launch-btn');
        if (btn) {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                openPanel();
            });
        }
    }, 100);
}

function addWandButton() {
    const wandBtnHtml = `<div id="cr-wand-btn" class="list-group-item flex-container flexGap5" title="Chat Reader">
        <span>📖</span> Reader
    </div>`;

    const addToMenu = () => {
        if (byId('cr-wand-btn')) return;

        const wandMenu = document.getElementById('extensionsMenu');
        if (wandMenu) {
            wandMenu.insertAdjacentHTML('beforeend', wandBtnHtml);
            const btn = byId('cr-wand-btn');
            if (btn) {
                btn.style.cursor = 'pointer';
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    openPanel();
                });
            }
            return;
        }

        const sendForm = document.getElementById('send_form');
        if (sendForm && !byId('cr-float-btn')) {
            const floatBtn = document.createElement('button');
            floatBtn.id = 'cr-float-btn';
            floatBtn.textContent = '📖';
            floatBtn.title = 'Chat Reader';
            floatBtn.style.cssText = 'position:fixed;bottom:80px;right:10px;width:48px;height:48px;border-radius:50%;border:2px solid #000;background:#000;color:#fff;font-size:20px;cursor:pointer;z-index:99990;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 10px rgba(0,0,0,.4);-webkit-tap-highlight-color:transparent;';
            floatBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                openPanel();
            });
            floatBtn.addEventListener('touchend', (e) => {
                e.preventDefault();
                openPanel();
            });
            document.body.appendChild(floatBtn);
        }
    };

    addToMenu();
    setTimeout(addToMenu, 2000);
    setTimeout(addToMenu, 5000);
    setTimeout(addToMenu, 10000);
}

function openPanel() {
    createPanel();
    const panel = byId('cr-panel');
    if (!panel) return;
    if (panel.classList.contains('open')) return;

    panel.classList.add('open');

    if (isMobile()) {
        mobileScreen = 'list';
        const sidebar = byId('crSidebar');
        const main = byId('crMain');
        if (sidebar) sidebar.classList.remove('hide');
        if (main) main.classList.add('hide');
        const back = byId('crBack');
        if (back) back.classList.remove('show');
        byId('crTitle').textContent = '📖 Chat Reader';
    } else {
        byId('crSidebar').classList.remove('hide');
        byId('crMain').classList.remove('hide');
    }

    refreshChars();
    if (state.lastChar && !selectedChar) selectChar(state.lastChar);
}

function closePanel() {
    const panel = byId('cr-panel');
    if (panel) panel.classList.remove('open');
}

function refreshChars() {
    charList = getCharList();
    renderCharTabs();
}

function renderCharTabs() {
    const el = byId('crChars');
    if (!el) return;
    if (!charList.length) {
        el.innerHTML = '<span style="color:#aaa;font-size:11px;padding:6px">无角色卡</span>';
        return;
    }
    let html = '';
    for (const c of charList) {
        html += '<button class="cr-chartab' + (c.name === selectedChar ? ' on' : '') + '" data-name="' + escAttr(c.name) + '" data-avatar="' + escAttr(c.avatar) + '">' + escHtml(c.name) + '</button>';
    }
    el.innerHTML = html;
}

async function selectChar(name) {
    const ch = charList.find(c => c.name === name);
    if (!ch) return;

    selectedChar = name;
    state.lastChar = name;
    saveState();
    renderCharTabs();

    byId('crArts').innerHTML = '<div class="cr-empty">⏳ 扫描中...</div>';

    const data = await loadCharData(name, ch.avatar);
    if (selectedChar !== name) return;

    renderArtList(data.articles);

    if (!data.articles.length) {
        byId('crArts').innerHTML = '<div class="cr-empty">此角色无三行格式内容</div>';
    }

    const saved = state.positions[name];
    if (saved && saved.a >= 0 && saved.a < data.articles.length) {
        openArt(saved.a, saved.s || 0);
    }
}

function renderArtList(articles) {
    const el = byId('crArts');
    if (!el) return;
    if (!articles.length) {
        el.innerHTML = '<div class="cr-empty">此角色无三行格式内容</div>';
        return;
    }

    const groups = {};
    const order = [];
    for (let i = 0; i < articles.length; i++) {
        const g = articles[i].chatFile || 'current';
        if (!groups[g]) { groups[g] = []; order.push(g); }
        groups[g].push({ art: articles[i], idx: i });
    }

    const lv = state.lastViewed[selectedChar];
    let html = '';

    for (const gn of order) {
        const items = groups[gn];
        if (order.length > 1) {
            html += '<div class="cr-chatlabel">' + (gn === 'current' ? '📍 当前聊天' : '📄 ' + escHtml(gn.substring(0, 20))) + '</div>';
        }
        for (const item of items) {
            const isCur = item.idx === selectedArt;
            const isLV = item.idx === lv && !isCur;
            html += '<div class="cr-artcard' + (isCur ? ' playing' : '') + (isLV ? ' lastview' : '') + '" data-idx="' + item.idx + '">' +
                '<div class="cr-artnum">' + item.art.floor + '</div>' +
                '<div class="cr-artinfo"><div class="cr-artname">' + escHtml(item.art.title) + '</div><div class="cr-artmeta">' + item.art.sentences.length + '句</div></div>' +
                '<span class="cr-artbadge">' + item.art.sentences.length + '</span></div>';
        }
    }

    html += '<div class="cr-playallwrap"><button class="cr-playallbtn" id="crPlayAll">▶ 连续播放全部 (' + articles.length + '篇)</button></div>';
    el.innerHTML = html;
}

function openArt(idx, startSent) {
    const data = charDataCache[selectedChar];
    if (!data || !data.articles[idx]) return;

    selectedArt = idx;
    sentenceIdx = startSent || 0;
    pageIdx = Math.floor(sentenceIdx / PAGE_SIZE);
    state.lastViewed[selectedChar] = idx;
    savePos();

    switchView('reader');
    schedRender();

    if (isMobile()) {
        mobileScreen = 'reader';
        byId('crSidebar').classList.add('hide');
        byId('crMain').classList.remove('hide');
        byId('crBack').classList.add('show');
        byId('crTitle').textContent = data.articles[idx].title;
    }

    renderArtList(data.articles);
}

function switchView(v) {
    const wel = byId('crVWel');
    const read = byId('crVRead');
    const set = byId('crVSet');
    if (wel) wel.classList.toggle('on', v === 'welcome');
    if (read) read.classList.toggle('on', v === 'reader');
    if (set) set.classList.toggle('on', v === 'settings');
}

function goBack() {
    stopPlay();
    if (isMobile()) {
        mobileScreen = 'list';
        byId('crSidebar').classList.remove('hide');
        byId('crMain').classList.add('hide');
        byId('crBack').classList.remove('show');
        byId('crTitle').textContent = '📖 Chat Reader';
    }
}

function schedRender() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => { renderPending = false; doRender(); });
}

function doRender() {
    const art = getArt();
    if (!art) return;

    const ss = art.sentences;
    const tp = Math.ceil(ss.length / PAGE_SIZE);
    const ap = Math.floor(sentenceIdx / PAGE_SIZE);
    if (isPlaying && pageIdx !== ap) pageIdx = ap;
    if (pageIdx >= tp) pageIdx = tp - 1;
    if (pageIdx < 0) pageIdx = 0;
    const ps = pageIdx * PAGE_SIZE;
    const pe = Math.min(ps + PAGE_SIZE, ss.length);

    const pf = byId('crProgFill');
    if (pf) pf.style.width = Math.round((sentenceIdx + 1) / ss.length * 100) + '%';
    const pi = byId('crProgIdx');
    if (pi) pi.textContent = (sentenceIdx + 1) + '/' + ss.length;
    const pt = byId('crProgTitle');
    if (pt) pt.textContent = art.title;

    const pgr = byId('crPager');
    if (pgr) {
        if (tp > 1) {
            let h = '<button class="cr-pgbtn" data-p="0"' + (pageIdx === 0 ? ' disabled' : '') + '>⏮</button>';
            h += '<button class="cr-pgbtn" data-p="' + (pageIdx - 1) + '"' + (pageIdx === 0 ? ' disabled' : '') + '>◀</button>';
            let sp = Math.max(0, pageIdx - 2);
            let ep = Math.min(tp, sp + 5);
            if (ep - sp < 5) sp = Math.max(0, ep - 5);
            for (let p = sp; p < ep; p++) {
                h += '<button class="cr-pgbtn' + (p === pageIdx ? ' on' : '') + '" data-p="' + p + '">' + (p + 1) + '</button>';
            }
            h += '<button class="cr-pgbtn" data-p="' + (pageIdx + 1) + '"' + (pageIdx >= tp - 1 ? ' disabled' : '') + '>▶</button>';
            h += '<button class="cr-pgbtn" data-p="' + (tp - 1) + '"' + (pageIdx >= tp - 1 ? ' disabled' : '') + '>⏭</button>';
            h += '<span class="cr-pgmeta">' + (ps + 1) + '-' + pe + '/' + ss.length + '</span>';
            pgr.innerHTML = h;
            pgr.classList.add('on');
        } else {
            pgr.innerHTML = '';
            pgr.classList.remove('on');
        }
    }

    const rd = byId('crReader');
    if (rd) {
        const st = state.settings;
        let html = '';
        for (let i = ps; i < pe; i++) {
            const s = ss[i];
            const act = i === sentenceIdx;
            const dn = i < sentenceIdx;
            const en = (s.en || '').replace(/\|/g, '');
            const cn = (s.cn || '').replace(/\|/g, '');
            const ww = (s.ww || '').replace(/\|/g, '');

            html += '<div class="cr-sent' + (act ? ' active' : '') + (dn ? ' done' : '') + '" data-si="' + i + '">';
            html += '<span class="cr-sentnum">#' + (i + 1) + '</span>';
            html += '<div class="cr-en' + (st.showEN ? '' : ' cr-hidden') + '">' + renderEN(en) + '</div>';
            html += '<div class="cr-cn' + (st.showCN ? '' : ' cr-hidden') + '">' + escHtml(cn) + '</div>';
            if (ww) html += '<div class="cr-ww' + (st.showWW ? '' : ' cr-hidden') + '">' + renderEN(ww) + '</div>';
            html += '</div>';
        }
        rd.innerHTML = html;
        rd.className = 'cr-reader fs-' + (state.fontSize || 'm');
        setTimeout(() => {
            const actEl = rd.querySelector('.active');
            if (actEl) actEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 50);
    }

    const pb = byId('crPlay');
    if (pb) { pb.textContent = isPlaying ? '⏸' : '▶️'; pb.classList.toggle('on', isPlaying); }

    const lb = byId('crLoop');
    if (lb) lb.classList.toggle('loopon', state.playMode === 'loop');

    const sb = byId('crSpeed');
    if (sb) sb.textContent = state.settings.enRate.toFixed(1) + 'x';

    const plBar = byId('crPL');
    if (plBar) {
        if (playlistOn) {
            plBar.classList.add('on');
            const pln = byId('crPLName');
            if (pln) pln.textContent = art.title + ' (' + (playlistIdx + 1) + '/' + playlistArts.length + ')';
        } else {
            plBar.classList.remove('on');
        }
    }

    renderTB();
    renderFB();
    renderMB();
}

function renderTB() {
    const el = byId('crToolbar');
    if (!el) return;
    const s = state.settings;
    el.innerHTML =
        '<button class="cr-tbtn' + (s.audioMode === 'cnenmix' ? ' on' : '') + '" data-am="cnenmix">🔊中英</button>' +
        '<button class="cr-tbtn' + (s.audioMode === 'enonly' ? ' on' : '') + '" data-am="enonly">🔊纯英</button>' +
        '<button class="cr-tbtn' + (s.audioMode === 'wwonly' ? ' on' : '') + '" data-am="wwonly">🔊词汇</button>' +
        '<span class="cr-tsep"></span>' +
        '<button class="cr-tbtn' + (s.showEN ? ' on' : '') + '" data-sh="en">英文</button>' +
        '<button class="cr-tbtn' + (s.showCN ? ' on' : '') + '" data-sh="cn">中文</button>' +
        '<button class="cr-tbtn' + (s.showWW ? ' on' : '') + '" data-sh="ww">词汇</button>';
}

function renderFB() {
    const el = byId('crFontBar');
    if (!el) return;
    const sizes = [['s', '小'], ['m', '中'], ['l', '大'], ['xl', '特大']];
    let h = '<label>字号:</label>';
    for (const sz of sizes) {
        h += '<button class="cr-optbtn' + (state.fontSize === sz[0] ? ' on' : '') + '" data-fs="' + sz[0] + '">' + sz[1] + '</button>';
    }
    el.innerHTML = h;
}

function renderMB() {
    const el = byId('crModeBar');
    if (!el) return;
    const modes = [['seq', '顺序'], ['loop', '单篇循环'], ['shuffle', '随机']];
    let h = '<label>播放:</label>';
    for (const m of modes) {
        h += '<button class="cr-optbtn' + (state.playMode === m[0] ? ' on' : '') + '" data-pm="' + m[0] + '">' + m[1] + '</button>';
    }
    el.innerHTML = h;
}

function togglePlay() {
    if (isPlaying) { stopPlay(); schedRender(); return; }
    if (!getArt()) { showToast('请先选择文章'); return; }
    isPlaying = true;
    startKeepAlive();
    updateMS(true);
    playStep();
}

async function playStep() {
    if (!isPlaying) return;
    const art = getArt();
    if (!art || sentenceIdx >= art.sentences.length) { handleEnd(); return; }

    const np = Math.floor(sentenceIdx / PAGE_SIZE);
    if (np !== pageIdx) pageIdx = np;
    schedRender();
    savePos();

    const s = art.sentences[sentenceIdx];
    const en = (s.en || '').replace(/\|/g, '');
    const cn = (s.cn || '').replace(/\|/g, '');
    const mode = state.settings.audioMode;

    speechId++;
    const myId = speechId;
    cancelSpeak();
    await new Promise(r => setTimeout(r, 40));
    if (speechId !== myId || !isPlaying) return;

    if (mode === 'wwonly' && s.ww) {
        const pairs = (s.ww || '').match(/([a-zA-Z][a-zA-Z'\u2019\-]*)\s*\(([^)]+)\)/g) || [];
        for (const pair of pairs) {
            if (speechId !== myId || !isPlaying) return;
            const mm = pair.match(/([a-zA-Z][a-zA-Z'\u2019\-]*)\s*\(([^)]+)\)/);
            if (mm) {
                await speak(mm[1], 'en-US', state.settings.enRate);
                if (speechId !== myId || !isPlaying) return;
                await speak(mm[2], 'zh-CN', state.settings.cnRate);
                if (speechId !== myId || !isPlaying) return;
            }
        }
    } else {
        await speak(en, 'en-US', state.settings.enRate);
        if (speechId !== myId || !isPlaying) return;
        if (mode === 'cnenmix' && cn) {
            await speak(cn, 'zh-CN', state.settings.cnRate);
            if (speechId !== myId || !isPlaying) return;
        }
    }

    playTimer = setTimeout(() => {
        if (!isPlaying) return;
        sentenceIdx++;
        if (sentenceIdx >= art.sentences.length) handleEnd();
        else playStep();
    }, 400);
}

function handleEnd() {
    const data = charDataCache[selectedChar];
    if (!data) { stopPlay(); schedRender(); return; }

    if (state.playMode === 'loop') { sentenceIdx = 0; playStep(); return; }

    if (playlistOn) {
        playlistIdx++;
        if (playlistIdx >= playlistArts.length) {
            showToast('🎉 列表播放完成');
            stopPlay(); playlistOn = false; schedRender(); return;
        }
        selectedArt = data.articles.indexOf(playlistArts[playlistIdx]);
        sentenceIdx = 0; savePos(); playStep(); return;
    }

    if (state.playMode === 'shuffle' && data.articles.length > 1) {
        let nx = selectedArt;
        while (nx === selectedArt) nx = Math.floor(Math.random() * data.articles.length);
        selectedArt = nx; sentenceIdx = 0; savePos(); renderArtList(data.articles); playStep(); return;
    }

    if (selectedArt + 1 < data.articles.length) {
        selectedArt++; sentenceIdx = 0; savePos(); renderArtList(data.articles); playStep(); return;
    }

    sentenceIdx = 0; showToast('🎉 全部完成'); stopPlay(); schedRender();
}

function navSent(dir) {
    const art = getArt();
    if (!art) return;
    stopPlay();
    sentenceIdx += dir;
    if (sentenceIdx < 0) sentenceIdx = art.sentences.length - 1;
    if (sentenceIdx >= art.sentences.length) sentenceIdx = 0;
    savePos(); schedRender();
    const s = art.sentences[sentenceIdx];
    if (s) {
        cancelSpeak();
        speak((s.en || '').replace(/\|/g, ''), 'en-US', state.settings.enRate).then(() => {
            if (state.settings.audioMode === 'cnenmix' && s.cn) speak((s.cn || '').replace(/\|/g, ''), 'zh-CN', state.settings.cnRate);
        });
    }
}

function startPlayAll() {
    const data = charDataCache[selectedChar];
    if (!data || !data.articles.length) { showToast('无文章'); return; }

    if (state.playMode === 'shuffle') {
        playlistArts = data.articles.slice();
        for (let i = playlistArts.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [playlistArts[i], playlistArts[j]] = [playlistArts[j], playlistArts[i]];
        }
    } else {
        playlistArts = data.articles.slice();
    }

    playlistIdx = 0; playlistOn = true;
    selectedArt = data.articles.indexOf(playlistArts[0]);
    sentenceIdx = 0;
    switchView('reader');

    if (isMobile()) {
        mobileScreen = 'reader';
        byId('crSidebar').classList.add('hide');
        byId('crMain').classList.remove('hide');
        byId('crBack').classList.add('show');
    }

    isPlaying = true; startKeepAlive(); updateMS(true); playStep();
}

function renderSetView() {
    const el = byId('crSetBody');
    if (!el) return;
    const s = state.settings;
    el.innerHTML =
        '<div style="font-size:16px;font-weight:700;color:#000;margin-bottom:12px">⚙ 设置</div>' +
        '<div class="cr-setrow"><label>英语语速</label><div style="display:flex;align-items:center;gap:6px"><input type="range" id="crER" min="0.5" max="2.5" step="0.1" value="' + s.enRate + '"><span class="val" id="crERV">' + s.enRate.toFixed(1) + 'x</span></div></div>' +
        '<div class="cr-setrow"><label>中文语速</label><div style="display:flex;align-items:center;gap:6px"><input type="range" id="crCR" min="0.5" max="2.5" step="0.1" value="' + s.cnRate + '"><span class="val" id="crCRV">' + s.cnRate.toFixed(1) + 'x</span></div></div>' +
        '<div class="cr-setinfo"><div style="font-weight:700;color:#000;margin-bottom:4px">📖 说明</div>' +
        '<div>• 扫描所有角色卡聊天记录</div>' +
        '<div>• 识别三行格式: 英文+中文+逐词</div>' +
        '<div>• 点击单词播放发音显示翻译</div>' +
        '<div>• 顺序/循环/随机播放</div>' +
        '<div>• 后台播放+锁屏控制</div>' +
        '<div>• 自动记录位置</div>' +
        '<div>• 小/中/大/特大字号</div>' +
        '<div style="margin-top:6px;color:#bbb">v6.0.0</div></div>';
}

function bindEvents() {
    byId('crClose').addEventListener('click', e => { e.preventDefault(); closePanel(); });

    byId('crBack').addEventListener('click', e => {
        e.preventDefault();
        if (byId('crVSet').classList.contains('on')) {
            if (selectedArt >= 0) {
                switchView('reader');
                if (isMobile()) byId('crTitle').textContent = getArt() ? getArt().title : '📖';
            } else goBack();
        } else goBack();
    });

    byId('crRefresh').addEventListener('click', e => {
        e.preventDefault();
        charDataCache = {};
        refreshChars();
        if (selectedChar) selectChar(selectedChar);
        showToast('刷新完成');
    });

    byId('crSettings').addEventListener('click', e => {
        e.preventDefault();
        if (byId('crVSet').classList.contains('on')) {
            if (selectedArt >= 0) {
                switchView('reader');
                if (isMobile()) byId('crTitle').textContent = getArt() ? getArt().title : '📖';
            } else { switchView('welcome'); if (isMobile()) goBack(); }
        } else {
            renderSetView(); switchView('settings');
            if (isMobile()) {
                byId('crSidebar').classList.add('hide');
                byId('crMain').classList.remove('hide');
                byId('crBack').classList.add('show');
                byId('crTitle').textContent = '⚙ 设置';
            }
        }
    });

    byId('crChars').addEventListener('click', e => {
        const tab = e.target.closest('.cr-chartab');
        if (tab) { e.preventDefault(); selectChar(tab.dataset.name); }
    });

    byId('crArts').addEventListener('click', e => {
        const card = e.target.closest('.cr-artcard');
        if (card) { e.preventDefault(); openArt(parseInt(card.dataset.idx)); return; }
        const pa = e.target.closest('#crPlayAll');
        if (pa) { e.preventDefault(); startPlayAll(); }
    });

    byId('crToolbar').addEventListener('click', e => {
        const btn = e.target.closest('.cr-tbtn');
        if (!btn) return;
        e.preventDefault();
        if (btn.dataset.am) { state.settings.audioMode = btn.dataset.am; saveState(); schedRender(); }
        if (btn.dataset.sh === 'en') { state.settings.showEN = !state.settings.showEN; saveState(); schedRender(); }
        if (btn.dataset.sh === 'cn') { state.settings.showCN = !state.settings.showCN; saveState(); schedRender(); }
        if (btn.dataset.sh === 'ww') { state.settings.showWW = !state.settings.showWW; saveState(); schedRender(); }
    });

    byId('crFontBar').addEventListener('click', e => {
        const btn = e.target.closest('.cr-optbtn');
        if (btn && btn.dataset.fs) {
            e.preventDefault(); state.fontSize = btn.dataset.fs; saveState(); renderFB();
            const rd = byId('crReader'); if (rd) rd.className = 'cr-reader fs-' + state.fontSize;
        }
    });

    byId('crModeBar').addEventListener('click', e => {
        const btn = e.target.closest('.cr-optbtn');
        if (btn && btn.dataset.pm) { e.preventDefault(); state.playMode = btn.dataset.pm; saveState(); renderMB(); schedRender(); }
    });

    byId('crPager').addEventListener('click', e => {
        const btn = e.target.closest('.cr-pgbtn');
        if (btn && !btn.disabled) { e.preventDefault(); pageIdx = parseInt(btn.dataset.p); schedRender(); byId('crReader').scrollTo(0, 0); }
    });

    byId('crPLClose').addEventListener('click', e => { e.preventDefault(); playlistOn = false; stopPlay(); schedRender(); });

    byId('crPlay').addEventListener('click', e => { e.preventDefault(); togglePlay(); });
    byId('crPrev').addEventListener('click', e => { e.preventDefault(); navSent(-1); });
    byId('crNext').addEventListener('click', e => { e.preventDefault(); navSent(1); });

    byId('crLoop').addEventListener('click', e => {
        e.preventDefault(); state.playMode = state.playMode === 'loop' ? 'seq' : 'loop'; saveState(); schedRender();
    });

    byId('crSpeed').addEventListener('click', e => {
        e.preventDefault();
        const speeds = [0.5, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.5, 2.0];
        let ci = speeds.findIndex(s => Math.abs(s - state.settings.enRate) < 0.05);
        state.settings.enRate = speeds[(ci + 1) % speeds.length];
        saveState(); schedRender();
    });

    byId('crGoList').addEventListener('click', e => { e.preventDefault(); goBack(); });

    byId('crReader').addEventListener('click', e => {
        const w = e.target.closest('.cr-word');
        if (w) { e.preventDefault(); e.stopPropagation(); onWordClick(w); return; }
        const s = e.target.closest('.cr-sent');
        if (s) {
            e.preventDefault();
            const idx = parseInt(s.dataset.si);
            if (!isNaN(idx)) {
                sentenceIdx = idx; savePos(); if (!isPlaying) schedRender();
                const art = getArt();
                if (art && art.sentences[idx]) {
                    const sent = art.sentences[idx];
                    cancelSpeak();
                    speak((sent.en || '').replace(/\|/g, ''), 'en-US', state.settings.enRate).then(() => {
                        if (state.settings.audioMode === 'cnenmix' && sent.cn) speak((sent.cn || '').replace(/\|/g, ''), 'zh-CN', state.settings.cnRate);
                    });
                }
            }
        }
    });

    byId('crSetBody').addEventListener('input', e => {
        if (e.target.id === 'crER') {
            state.settings.enRate = parseFloat(e.target.value);
            const v = byId('crERV'); if (v) v.textContent = state.settings.enRate.toFixed(1) + 'x';
            saveState();
        }
        if (e.target.id === 'crCR') {
            state.settings.cnRate = parseFloat(e.target.value);
            const v = byId('crCRV'); if (v) v.textContent = state.settings.cnRate.toFixed(1) + 'x';
            saveState();
        }
    });

    document.addEventListener('click', e => {
        if (!e.target.closest('.cr-tooltip') && !e.target.closest('.cr-word')) hideTip();
    });

    document.addEventListener('keydown', e => {
        const panel = byId('cr-panel');
        if (!panel || !panel.classList.contains('open')) return;
        if (!byId('crVRead') || !byId('crVRead').classList.contains('on')) return;
        const tag = e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); navSent(-1); }
        if (e.key === 'ArrowRight') { e.preventDefault(); navSent(1); }
        if (e.key === 'Escape') { e.preventDefault(); goBack(); }
    });
}

jQuery(async () => {
    loadState();
    addSettingsUI();
    addWandButton();
    initVoices();
    console.log('[ChatReader] v6.0 loaded');
});
