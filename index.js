/*
 * SillyTavern Chat Article Reader Plugin
 * Reads all chat messages, parses three-line English learning format,
 * displays as articles categorized by character card name.
 */

import { getContext } from '../../../extensions.js';

const EXT_NAME = 'SillyTavern-ChatReader';
const PAGE_SIZE = 50;

// ========== State ==========
let articles = [];
let currentArticleIdx = -1;
let sentIdx = 0;
let pageNum = 0;
let readerPlaying = false;
let readerTimer = null;
let speechId = 0;
let voices = [];
let catFilter = '全部';
let currentView = 'list'; // 'list' | 'reader' | 'settings'

let audioMode = 'cnenmix';   // cnenmix | enonly | wwonly
let showEN = true;
let showCN = true;
let showWW = true;
let loopSingle = false;
let deRate = 1.0;
let zhRate = 1.0;

let playlistMode = false;
let playlistIdx = 0;
let playlistArticles = [];

let tipEl = null;
let tipTimer = null;

// ========== Helpers ==========
function esc(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(s) {
    return (s || '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function crToast(msg) {
    let t = document.getElementById('cr-toast');
    if (!t) {
        t = document.createElement('div');
        t.id = 'cr-toast';
        t.className = 'cr-toast';
        document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('cr-show');
    clearTimeout(t._t);
    t._t = setTimeout(() => t.classList.remove('cr-show'), 2500);
}

// ========== Chat Parsing ==========
function cleanMessageText(raw) {
    let text = raw || '';
    // Remove <prepare></prepare> blocks
    text = text.replace(/<prepare>[\s\S]*?<\/prepare>/gi, '');
    // Remove <details>...</details> blocks
    text = text.replace(/<details>[\s\S]*?<\/details>/gi, '');
    // Replace <br> with newlines
    text = text.replace(/<br\s*\/?>/gi, '\n');
    // Remove remaining HTML tags
    text = text.replace(/<[^>]+>/g, '');
    // Decode HTML entities
    const ta = document.createElement('textarea');
    ta.innerHTML = text;
    text = ta.value;
    // Remove choice blocks at the end
    const choiceIdx = text.search(/>\s*选择[：:]/);
    if (choiceIdx > 0) text = text.substring(0, choiceIdx);
    return text.trim();
}

function isEnglishLine(line) {
    const en = (line.match(/[a-zA-Z]/g) || []).length;
    const cn = (line.match(/[\u4e00-\u9fff]/g) || []).length;
    return en > cn && en >= 3;
}

function isChineseLine(line) {
    return (line.match(/[\u4e00-\u9fff]/g) || []).length >= 2;
}

function isWWLine(line) {
    const matches = line.match(/[a-zA-Z][a-zA-Z''\-]*\s*\([^)]*[\u4e00-\u9fff][^)]*\)/g);
    return matches && matches.length >= 2;
}

function parseSentences(rawText) {
    const text = cleanMessageText(rawText);
    const lines = text.split('\n').map(l => l.trim()).filter(l => l);
    const sentences = [];

    let i = 0;
    while (i < lines.length - 2) {
        const l1 = lines[i];
        const l2 = lines[i + 1];
        const l3 = lines[i + 2];

        if (isEnglishLine(l1) && isChineseLine(l2) && isWWLine(l3)) {
            sentences.push({ en: l1, cn: l2, ww: l3 });
            i += 3;
        } else if (isEnglishLine(l1) && isChineseLine(l2)) {
            sentences.push({ en: l1, cn: l2, ww: '' });
            i += 2;
        } else {
            i++;
        }
    }
    // Handle remaining 2 lines
    if (i < lines.length - 1) {
        const l1 = lines[i], l2 = lines[i + 1];
        if (isEnglishLine(l1) && isChineseLine(l2)) {
            sentences.push({ en: l1, cn: l2, ww: '' });
        }
    }

    return sentences;
}

function loadArticles() {
    const context = getContext();
    const chat = context.chat || [];
    const newArticles = [];
    let floor = 0;

    for (let mi = 0; mi < chat.length; mi++) {
        const msg = chat[mi];
        if (msg.is_user || msg.is_system) continue;
        if (!msg.mes || !msg.mes.trim()) continue;

        const sentences = parseSentences(msg.mes);
        if (sentences.length === 0) continue;

        floor++;
        const charName = msg.name || context.name2 || '未知角色';

        // Try to find a title from the preceding user message
        let title = `#${floor}`;
        for (let pi = mi - 1; pi >= 0; pi--) {
            if (chat[pi].is_user && chat[pi].mes) {
                const userText = cleanMessageText(chat[pi].mes);
                title = `#${floor} ${userText.substring(0, 30)}`;
                break;
            }
        }

        newArticles.push({
            title: title,
            category: charName,
            sentences: sentences,
            msgIndex: mi,
            floor: floor,
        });
    }

    articles = newArticles;
}

// ========== TTS ==========
function initVoices() {
    if (!window.speechSynthesis) return;
    const load = () => { voices = speechSynthesis.getVoices(); };
    load();
    if (speechSynthesis.onvoiceschanged !== undefined) {
        speechSynthesis.onvoiceschanged = load;
    }
    setTimeout(load, 2000);
}

function findVoice(lang) {
    if (!voices.length) voices = speechSynthesis.getVoices();
    const prefix = lang.split('-')[0];
    const matches = voices.filter(v => v.lang === lang || v.lang.startsWith(prefix));
    return matches.find(v => v.localService) || matches[0] || null;
}

function speakOne(text, lang, rate) {
    return new Promise(resolve => {
        if (!window.speechSynthesis || !text?.trim()) { resolve(); return; }
        const u = new SpeechSynthesisUtterance(text.trim());
        u.lang = lang;
        u.rate = Math.max(0.1, Math.min(5, rate || 1));
        const v = findVoice(lang);
        if (v) u.voice = v;
        let done = false;
        const finish = () => { if (!done) { done = true; clearTimeout(tm); resolve(); } };
        const tm = setTimeout(finish, Math.max(5000, text.length * 800));
        u.onend = finish;
        u.onerror = finish;
        try { speechSynthesis.speak(u); } catch (e) { finish(); }
    });
}

function cancelSpeech() {
    try { speechSynthesis.cancel(); } catch (e) { /* ignore */ }
}

function speakWord(word) {
    if (!word) return;
    cancelSpeech();
    const u = new SpeechSynthesisUtterance(word);
    u.lang = 'en-US';
    u.rate = deRate;
    const v = findVoice('en-US');
    if (v) u.voice = v;
    try { speechSynthesis.speak(u); } catch (e) { /* ignore */ }
}

function stopPlayback() {
    readerPlaying = false;
    clearTimeout(readerTimer);
    cancelSpeech();
    speechId++;
}

// ========== Clickable Words ==========
function cleanWord(w) {
    return (w || '').replace(/^[.,!?;:'"()\-–»«\[\]{}\/\\]+/, '').replace(/[.,!?;:'"()\-–»«…\[\]{}\/\\]+$/, '').trim();
}

function renderClickableEN(text) {
    if (!text) return '';
    const clean = (text || '').replace(/\|/g, '');
    return clean.split(/(\s+)/).map(part => {
        if (!part) return '';
        if (/^\s+$/.test(part)) return ' ';
        if (/[a-zA-Z]/.test(part)) {
            const m = part.match(/^([^a-zA-Z]*)([a-zA-Z][a-zA-Z'\-]*[a-zA-Z]|[a-zA-Z])([^a-zA-Z]*)$/);
            if (m) {
                return esc(m[1]) + `<span class="cr-word" data-speak="${escAttr(cleanWord(m[2]))}">${esc(m[2])}</span>` + esc(m[3]);
            }
            return `<span class="cr-word" data-speak="${escAttr(cleanWord(part))}">${esc(part)}</span>`;
        }
        return esc(part);
    }).join('');
}

// ========== Tooltip ==========
function hideTip() {
    if (tipEl) { tipEl.remove(); tipEl = null; }
    if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
}

function showTip(el, text) {
    hideTip();
    const r = el.getBoundingClientRect();
    const tip = document.createElement('div');
    tip.className = 'cr-tip';
    tip.textContent = text;
    tip.style.left = (r.left + r.width / 2) + 'px';
    if (r.top > 60) {
        tip.style.top = (r.top - 8) + 'px';
        tip.style.transform = 'translateX(-50%) translateY(-100%)';
    } else {
        tip.style.top = (r.bottom + 8) + 'px';
        tip.style.transform = 'translateX(-50%)';
    }
    document.body.appendChild(tip);
    requestAnimationFrame(() => {
        const tr = tip.getBoundingClientRect();
        if (tr.right > window.innerWidth - 8) tip.style.left = (window.innerWidth - tr.width / 2 - 8) + 'px';
        if (tr.left < 8) tip.style.left = (tr.width / 2 + 8) + 'px';
        tip.classList.add('cr-visible');
    });
    tipEl = tip;
    tipTimer = setTimeout(hideTip, 3500);
}

async function onClickWord(el) {
    const raw = el.dataset.speak || el.textContent.trim();
    const word = cleanWord(raw);
    if (!word) return;
    el.classList.add('cr-speaking');
    setTimeout(() => el.classList.remove('cr-speaking'), 1200);
    speakWord(word);

    // Search in current article for translation
    hideTip();
    let translation = '';
    if (currentArticleIdx >= 0 && articles[currentArticleIdx]) {
        const art = articles[currentArticleIdx];
        for (const s of art.sentences) {
            if (!s.ww) continue;
            const pattern = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\(([^)]+)\\)', 'i');
            const match = s.ww.match(pattern);
            if (match) { translation = match[1]; break; }
        }
    }
    if (translation) {
        showTip(el, translation);
    } else {
        showTip(el, word);
    }
}

// ========== UI Creation ==========
function createUI() {
    // Floating button
    const btn = document.createElement('button');
    btn.id = 'cr-float-btn';
    btn.textContent = '📖';
    btn.title = 'Chat Reader';
    document.body.appendChild(btn);

    // Panel
    const panel = document.createElement('div');
    panel.id = 'cr-panel';
    panel.innerHTML = buildPanelHTML();
    document.body.appendChild(panel);

    // Toast
    const toast = document.createElement('div');
    toast.id = 'cr-toast';
    toast.className = 'cr-toast';
    document.body.appendChild(toast);
}

function buildPanelHTML() {
    return `
    <!-- Top Bar -->
    <div class="cr-topbar">
        <button class="cr-topbar-btn" id="cr-back" style="display:none">◀</button>
        <div class="cr-topbar-title" id="cr-title">📖 Chat Reader</div>
        <button class="cr-topbar-btn" id="cr-refresh" title="刷新">🔄</button>
        <button class="cr-topbar-btn" id="cr-settings-btn" title="设置">⚙️</button>
        <button class="cr-topbar-btn" id="cr-close" title="关闭">✕</button>
    </div>

    <!-- Category Filter -->
    <div class="cr-cat-bar" id="cr-cat-bar"></div>

    <!-- Views -->
    <div class="cr-views">
        <!-- List View -->
        <div class="cr-list-view" id="cr-list-view"></div>

        <!-- Reader View -->
        <div class="cr-reader-view" id="cr-reader-view">
            <div class="cr-reader-toolbar" id="cr-toolbar"></div>
            <div class="cr-playlist-bar" id="cr-playlist" style="display:none">
                <span>📋 列表播放: <b id="cr-pl-title">—</b></span>
                <button class="cr-topbar-btn" id="cr-pl-close" style="width:28px;height:28px;font-size:.8rem">✕</button>
            </div>
            <div class="cr-reader-progress" id="cr-rprog">
                <div class="cr-progress-bar"><div class="cr-progress-fill" id="cr-prog-fill"></div></div>
                <div class="cr-progress-text"><span id="cr-prog-text">0/0</span><span id="cr-prog-title">—</span></div>
            </div>
            <div class="cr-pager" id="cr-pager"></div>
            <div class="cr-reader-body" id="cr-reader-body"></div>
            <div class="cr-controls" id="cr-ctrls">
                <span class="cr-speed-btn" id="cr-speed">${deRate.toFixed(1)}x</span>
                <button class="cr-ctrl" id="cr-prev">⏮</button>
                <button class="cr-ctrl cr-play-btn" id="cr-play">▶️</button>
                <button class="cr-ctrl" id="cr-next">⏭</button>
                <button class="cr-ctrl" id="cr-loop">🔁</button>
                <button class="cr-ctrl" id="cr-list-btn">📋</button>
            </div>
        </div>

        <!-- Settings View -->
        <div class="cr-reader-view" id="cr-settings-view">
            <div class="cr-settings" id="cr-settings-body"></div>
        </div>
    </div>
    `;
}

// ========== Rendering ==========
function renderCatBar() {
    const cats = ['全部'];
    articles.forEach(a => {
        if (a.category && !cats.includes(a.category)) cats.push(a.category);
    });
    const bar = document.getElementById('cr-cat-bar');
    if (!bar) return;
    bar.innerHTML = cats.map(c =>
        `<button class="cr-cat-btn${c === catFilter ? ' cr-active' : ''}" data-cat="${escAttr(c)}">${esc(c)} (${c === '全部' ? articles.length : articles.filter(a => a.category === c).length})</button>`
    ).join('');
}

function renderListView() {
    const list = document.getElementById('cr-list-view');
    if (!list) return;

    const filtered = catFilter === '全部'
        ? articles
        : articles.filter(a => a.category === catFilter);

    if (!filtered.length) {
        list.innerHTML = `<div class="cr-empty">
            <div style="font-size:2rem;margin-bottom:10px">📭</div>
            <div>暂无可读取的文章</div>
            <div style="font-size:.78rem;margin-top:8px;color:#444">请确保聊天记录中包含三行格式的英语学习内容<br>(英文句 + 中文翻译 + 逐词标注)</div>
        </div>`;
        return;
    }

    let html = '';
    // Group by category
    const groups = {};
    filtered.forEach(a => {
        if (!groups[a.category]) groups[a.category] = [];
        groups[a.category].push(a);
    });

    for (const [cat, arts] of Object.entries(groups)) {
        if (catFilter === '全部' && Object.keys(groups).length > 1) {
            html += `<div style="padding:8px 12px;font-size:.78rem;color:#555;font-weight:600;margin-top:8px">📁 ${esc(cat)} (${arts.length})</div>`;
        }
        arts.forEach(a => {
            const idx = articles.indexOf(a);
            const isPlaying = currentArticleIdx === idx;
            html += `<div class="cr-art-card${isPlaying ? ' cr-playing' : ''}" data-artidx="${idx}">
                <div class="cr-art-num">${a.floor}</div>
                <div class="cr-art-info">
                    <div class="cr-art-title">${esc(a.title)}</div>
                    <div class="cr-art-meta">${a.sentences.length} 句</div>
                </div>
                <span class="cr-art-cat">${esc(a.category)}</span>
            </div>`;
        });
    }

    // Playlist button
    if (filtered.length > 1) {
        html += `<div style="text-align:center;padding:12px">
            <button class="cr-topbar-btn" id="cr-play-all" style="width:auto;padding:8px 20px;font-size:.78rem;border-radius:20px">
                ▶️ 列表播放 (${filtered.length}篇)
            </button>
        </div>`;
    }

    list.innerHTML = html;
}

function renderToolbar() {
    const tb = document.getElementById('cr-toolbar');
    if (!tb) return;
    tb.innerHTML = `
        <button class="cr-rtb${audioMode === 'cnenmix' ? ' cr-active' : ''}" data-audio="cnenmix">🔊中英</button>
        <button class="cr-rtb${audioMode === 'enonly' ? ' cr-active' : ''}" data-audio="enonly">🔊纯英</button>
        <button class="cr-rtb${audioMode === 'wwonly' ? ' cr-active' : ''}" data-audio="wwonly">🔊词汇</button>
        <span class="cr-rtb-sep"></span>
        <button class="cr-rtb${showEN ? ' cr-active' : ''}" data-show="en">📝英文</button>
        <button class="cr-rtb${showCN ? ' cr-active' : ''}" data-show="cn">📝中文</button>
        <button class="cr-rtb${showWW ? ' cr-active' : ''}" data-show="ww">📝词汇</button>
        <span class="cr-rtb-sep"></span>
        <button class="cr-rtb${loopSingle ? ' cr-active' : ''}" data-toggle="loop">🔁循环</button>
    `;
}

function renderReader() {
    if (currentArticleIdx < 0 || !articles[currentArticleIdx]) return;
    const art = articles[currentArticleIdx];
    const sents = art.sentences;
    const totalPages = Math.ceil(sents.length / PAGE_SIZE);

    // Ensure page contains active sentence
    const activePage = Math.floor(sentIdx / PAGE_SIZE);
    if (readerPlaying && pageNum !== activePage) pageNum = activePage;
    if (pageNum >= totalPages) pageNum = totalPages - 1;
    if (pageNum < 0) pageNum = 0;

    const pageStart = pageNum * PAGE_SIZE;
    const pageEnd = Math.min(pageStart + PAGE_SIZE, sents.length);

    // Progress
    const progFill = document.getElementById('cr-prog-fill');
    const progText = document.getElementById('cr-prog-text');
    const progTitle = document.getElementById('cr-prog-title');
    if (progFill) progFill.style.width = Math.round((sentIdx + 1) / sents.length * 100) + '%';
    if (progText) progText.textContent = `${sentIdx + 1}/${sents.length}`;
    if (progTitle) progTitle.textContent = art.title;

    // Pager
    const pager = document.getElementById('cr-pager');
    if (pager) {
        if (totalPages > 1) {
            let ph = `<button class="cr-pg-btn" data-pg="0" ${pageNum === 0 ? 'disabled' : ''}>⏮</button>`;
            ph += `<button class="cr-pg-btn" data-pg="${pageNum - 1}" ${pageNum === 0 ? 'disabled' : ''}>◀</button>`;
            const maxBtns = 5;
            let sp = Math.max(0, pageNum - 2), ep = Math.min(totalPages, sp + maxBtns);
            if (ep - sp < maxBtns) sp = Math.max(0, ep - maxBtns);
            for (let p = sp; p < ep; p++) {
                ph += `<button class="cr-pg-btn${p === pageNum ? ' cr-pg-active' : ''}" data-pg="${p}">${p + 1}</button>`;
            }
            ph += `<button class="cr-pg-btn" data-pg="${pageNum + 1}" ${pageNum >= totalPages - 1 ? 'disabled' : ''}>▶</button>`;
            ph += `<button class="cr-pg-btn" data-pg="${totalPages - 1}" ${pageNum >= totalPages - 1 ? 'disabled' : ''}>⏭</button>`;
            ph += `<span class="cr-pg-info">${pageStart + 1}-${pageEnd}/${sents.length}</span>`;
            pager.innerHTML = ph;
            pager.style.display = '';
        } else {
            pager.innerHTML = '';
            pager.style.display = 'none';
        }
    }

    // Sentences
    const body = document.getElementById('cr-reader-body');
    if (body) {
        let html = '';
        for (let i = pageStart; i < pageEnd; i++) {
            const s = sents[i];
            const isActive = i === sentIdx;
            const isPlayed = i < sentIdx;
            let cls = 'cr-sentence';
            if (isActive) cls += ' cr-active-s';
            if (isPlayed) cls += ' cr-played-s';
            const enText = (s.en || '').replace(/\|/g, '');
            const cnText = (s.cn || '').replace(/\|/g, '');
            const wwText = (s.ww || '').replace(/\|/g, '');

            html += `<div class="${cls}" data-si="${i}">
                <span class="cr-sent-num">#${i + 1}</span>
                <div class="cr-sent-en${showEN ? '' : ' cr-hidden'}">${renderClickableEN(enText)}</div>
                <div class="cr-sent-cn${showCN ? '' : ' cr-hidden'}">${esc(cnText)}</div>
                ${wwText ? `<div class="cr-sent-ww${showWW ? '' : ' cr-hidden'}">${renderClickableEN(wwText)}</div>` : ''}
            </div>`;
        }
        body.innerHTML = html;
        setTimeout(() => {
            const active = body.querySelector('.cr-active-s');
            if (active) active.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 80);
    }

    // Controls state
    const playBtn = document.getElementById('cr-play');
    if (playBtn) {
        playBtn.textContent = readerPlaying ? '⏸' : '▶️';
        playBtn.classList.toggle('cr-playing', readerPlaying);
    }
    const loopBtn = document.getElementById('cr-loop');
    if (loopBtn) loopBtn.classList.toggle('cr-loop-active', loopSingle);
    const speedBtn = document.getElementById('cr-speed');
    if (speedBtn) speedBtn.textContent = deRate.toFixed(1) + 'x';

    // Playlist bar
    const plBar = document.getElementById('cr-playlist');
    if (plBar) {
        if (playlistMode) {
            plBar.style.display = '';
            const plTitle = document.getElementById('cr-pl-title');
            if (plTitle) plTitle.textContent = `${art.title} (${playlistIdx + 1}/${playlistArticles.length})`;
        } else {
            plBar.style.display = 'none';
        }
    }

    renderToolbar();
}

function renderSettings() {
    const body = document.getElementById('cr-settings-body');
    if (!body) return;
    body.innerHTML = `
        <div style="font-size:1rem;font-weight:600;margin-bottom:14px;color:#ddd">⚙️ 设置</div>
        <div class="cr-set-item">
            <span class="cr-set-label">英语语速</span>
            <div style="display:flex;align-items:center;gap:8px">
                <input type="range" id="cr-de-rate" min="0.5" max="2.5" step="0.1" value="${deRate}">
                <span class="cr-set-val" id="cr-de-val">${deRate.toFixed(1)}x</span>
            </div>
        </div>
        <div class="cr-set-item">
            <span class="cr-set-label">中文语速</span>
            <div style="display:flex;align-items:center;gap:8px">
                <input type="range" id="cr-zh-rate" min="0.5" max="2.5" step="0.1" value="${zhRate}">
                <span class="cr-set-val" id="cr-zh-val">${zhRate.toFixed(1)}x</span>
            </div>
        </div>
        <div class="cr-set-item">
            <span class="cr-set-label">每页句数</span>
            <span class="cr-set-val">${PAGE_SIZE}</span>
        </div>
        <div style="margin-top:20px;padding:14px;background:#1a1a28;border-radius:10px;font-size:.78rem;color:#666;line-height:1.8">
            <div style="font-weight:600;color:#888;margin-bottom:6px">📖 使用说明</div>
            <div>• 本插件读取当前聊天中所有AI回复</div>
            <div>• 自动解析三行格式：英文 + 中文翻译 + 逐词标注</div>
            <div>• 点击任意英文单词可播放发音并显示翻译</div>
            <div>• 文章分类按角色卡名称自动归类</div>
            <div>• 在酒馆中删除消息后刷新即可同步</div>
            <div>• 支持配音播放、单句循环、列表播放</div>
            <div style="margin-top:8px;color:#555">版本 1.0.0</div>
        </div>
    `;
}

// ========== View Switching ==========
function switchToView(view) {
    currentView = view;
    const listView = document.getElementById('cr-list-view');
    const readerView = document.getElementById('cr-reader-view');
    const settingsView = document.getElementById('cr-settings-view');
    const backBtn = document.getElementById('cr-back');
    const catBar = document.getElementById('cr-cat-bar');
    const titleEl = document.getElementById('cr-title');

    if (listView) listView.classList.toggle('cr-slide-out', view !== 'list');
    if (readerView) readerView.classList.toggle('cr-slide-in', view === 'reader');
    if (settingsView) settingsView.classList.toggle('cr-slide-in', view === 'settings');
    if (backBtn) backBtn.style.display = view === 'list' ? 'none' : '';
    if (catBar) catBar.style.display = view === 'list' ? '' : 'none';

    if (view === 'list') {
        if (titleEl) titleEl.textContent = '📖 Chat Reader';
        stopPlayback();
        renderListView();
    } else if (view === 'reader') {
        if (titleEl && currentArticleIdx >= 0 && articles[currentArticleIdx]) {
            titleEl.textContent = articles[currentArticleIdx].title;
        }
        renderReader();
    } else if (view === 'settings') {
        if (titleEl) titleEl.textContent = '⚙️ 设置';
        renderSettings();
    }
}

function openArticle(idx) {
    if (idx < 0 || idx >= articles.length) return;
    currentArticleIdx = idx;
    sentIdx = 0;
    pageNum = 0;
    switchToView('reader');
}

// ========== Playback ==========
function togglePlay() {
    if (readerPlaying) {
        stopPlayback();
        renderReader();
        return;
    }
    if (currentArticleIdx < 0 || !articles[currentArticleIdx]) return;
    readerPlaying = true;
    playStep();
}

async function playStep() {
    if (!readerPlaying || currentArticleIdx < 0) return;
    const art = articles[currentArticleIdx];
    if (!art || sentIdx >= art.sentences.length) {
        handleArticleEnd();
        return;
    }

    // Auto-page
    const neededPage = Math.floor(sentIdx / PAGE_SIZE);
    if (neededPage !== pageNum) pageNum = neededPage;
    renderReader();

    const s = art.sentences[sentIdx];
    const en = (s.en || '').replace(/\|/g, '');
    const cn = (s.cn || '').replace(/\|/g, '');

    speechId++;
    const myId = speechId;
    cancelSpeech();
    await new Promise(r => setTimeout(r, 80));
    if (speechId !== myId || !readerPlaying) return;

    if (audioMode === 'wwonly' && s.ww) {
        // Play word-by-word pairs
        const pairs = (s.ww || '').match(/([a-zA-Z][a-zA-Z'\-]*)\s*\(([^)]+)\)/g) || [];
        for (const pair of pairs) {
            if (speechId !== myId || !readerPlaying) return;
            const mm = pair.match(/([a-zA-Z][a-zA-Z'\-]*)\s*\(([^)]+)\)/);
            if (mm) {
                await speakOne(mm[1], 'en-US', deRate);
                if (speechId !== myId || !readerPlaying) return;
                await speakOne(mm[2], 'zh-CN', zhRate);
                if (speechId !== myId || !readerPlaying) return;
            }
        }
    } else {
        await speakOne(en, 'en-US', deRate);
        if (speechId !== myId || !readerPlaying) return;
        if (audioMode === 'cnenmix' && cn) {
            await speakOne(cn, 'zh-CN', zhRate);
            if (speechId !== myId || !readerPlaying) return;
        }
    }

    readerTimer = setTimeout(() => {
        if (!readerPlaying) return;
        sentIdx++;
        if (sentIdx >= art.sentences.length) {
            handleArticleEnd();
        } else {
            playStep();
        }
    }, 600);
}

function handleArticleEnd() {
    if (loopSingle) {
        sentIdx = 0;
        playStep();
    } else if (playlistMode) {
        playlistIdx++;
        if (playlistIdx >= playlistArticles.length) {
            playlistIdx = 0;
            crToast('🎉 列表播放完成');
            stopPlayback();
            renderReader();
            return;
        }
        currentArticleIdx = articles.indexOf(playlistArticles[playlistIdx]);
        sentIdx = 0;
        playStep();
    } else {
        sentIdx = 0;
        crToast('🎉 播放完成');
        stopPlayback();
        renderReader();
    }
}

function navSentence(dir) {
    if (currentArticleIdx < 0 || !articles[currentArticleIdx]) return;
    stopPlayback();
    const art = articles[currentArticleIdx];
    sentIdx += dir;
    if (sentIdx < 0) sentIdx = art.sentences.length - 1;
    if (sentIdx >= art.sentences.length) sentIdx = 0;
    renderReader();
}

function startPlaylist() {
    const filtered = catFilter === '全部'
        ? [...articles]
        : articles.filter(a => a.category === catFilter);
    if (!filtered.length) { crToast('无文章'); return; }
    playlistArticles = filtered;
    playlistIdx = 0;
    playlistMode = true;
    currentArticleIdx = articles.indexOf(filtered[0]);
    sentIdx = 0;
    switchToView('reader');
    readerPlaying = true;
    playStep();
}

function stopPlaylistMode() {
    playlistMode = false;
    stopPlayback();
    renderReader();
}

// ========== Events ==========
function bindEvents() {
    // Float button
    document.getElementById('cr-float-btn')?.addEventListener('click', () => {
        const panel = document.getElementById('cr-panel');
        if (!panel) return;
        if (panel.classList.contains('cr-open')) {
            panel.classList.remove('cr-open');
        } else {
            loadArticles();
            renderCatBar();
            switchToView('list');
            panel.classList.add('cr-open');
        }
    });

    // Close
    document.getElementById('cr-close')?.addEventListener('click', () => {
        stopPlayback();
        document.getElementById('cr-panel')?.classList.remove('cr-open');
    });

    // Back
    document.getElementById('cr-back')?.addEventListener('click', () => {
        stopPlayback();
        switchToView('list');
    });

    // Refresh
    document.getElementById('cr-refresh')?.addEventListener('click', () => {
        loadArticles();
        renderCatBar();
        if (currentView === 'list') renderListView();
        crToast(`🔄 已刷新: ${articles.length} 篇`);
    });

    // Settings
    document.getElementById('cr-settings-btn')?.addEventListener('click', () => {
        if (currentView === 'settings') {
            switchToView('list');
        } else {
            switchToView('settings');
        }
    });

    // Category filter
    document.getElementById('cr-cat-bar')?.addEventListener('click', e => {
        const btn = e.target.closest('.cr-cat-btn');
        if (!btn) return;
        catFilter = btn.dataset.cat;
        renderCatBar();
        renderListView();
    });

    // Article list clicks
    document.getElementById('cr-list-view')?.addEventListener('click', e => {
        const card = e.target.closest('.cr-art-card');
        if (card) {
            openArticle(parseInt(card.dataset.artidx));
            return;
        }
        if (e.target.id === 'cr-play-all' || e.target.closest('#cr-play-all')) {
            startPlaylist();
        }
    });

    // Reader toolbar
    document.getElementById('cr-toolbar')?.addEventListener('click', e => {
        const btn = e.target.closest('.cr-rtb');
        if (!btn) return;
        if (btn.dataset.audio) {
            audioMode = btn.dataset.audio;
            renderReader();
        }
        if (btn.dataset.show === 'en') { showEN = !showEN; renderReader(); }
        if (btn.dataset.show === 'cn') { showCN = !showCN; renderReader(); }
        if (btn.dataset.show === 'ww') { showWW = !showWW; renderReader(); }
        if (btn.dataset.toggle === 'loop') { loopSingle = !loopSingle; renderReader(); }
    });

    // Reader controls
    document.getElementById('cr-play')?.addEventListener('click', togglePlay);
    document.getElementById('cr-prev')?.addEventListener('click', () => navSentence(-1));
    document.getElementById('cr-next')?.addEventListener('click', () => navSentence(1));
    document.getElementById('cr-loop')?.addEventListener('click', () => { loopSingle = !loopSingle; renderReader(); });
    document.getElementById('cr-list-btn')?.addEventListener('click', () => { stopPlayback(); switchToView('list'); });
    document.getElementById('cr-speed')?.addEventListener('click', () => {
        const speeds = [0.5, 0.7, 0.8, 1.0, 1.2, 1.5, 2.0];
        const ci = speeds.indexOf(deRate);
        deRate = speeds[(ci + 1) % speeds.length];
        renderReader();
    });

    // Pager
    document.getElementById('cr-pager')?.addEventListener('click', e => {
        const btn = e.target.closest('.cr-pg-btn');
        if (btn && !btn.disabled) {
            pageNum = parseInt(btn.dataset.pg);
            renderReader();
            document.getElementById('cr-reader-body')?.scrollTo(0, 0);
        }
    });

    // Playlist close
    document.getElementById('cr-pl-close')?.addEventListener('click', stopPlaylistMode);

    // Sentence click (play + read aloud)
    document.getElementById('cr-reader-body')?.addEventListener('click', e => {
        // Word click
        const word = e.target.closest('.cr-word');
        if (word) {
            e.preventDefault();
            e.stopPropagation();
            onClickWord(word);
            return;
        }
        // Sentence click
        const sent = e.target.closest('.cr-sentence');
        if (sent) {
            const idx = parseInt(sent.dataset.si);
            if (!isNaN(idx)) {
                sentIdx = idx;
                if (!readerPlaying) renderReader();
                const art = articles[currentArticleIdx];
                if (art && art.sentences[idx]) {
                    const s = art.sentences[idx];
                    const en = (s.en || '').replace(/\|/g, '');
                    const cn = audioMode === 'cnenmix' ? (s.cn || '').replace(/\|/g, '') : '';
                    cancelSpeech();
                    speakOne(en, 'en-US', deRate).then(() => {
                        if (cn) speakOne(cn, 'zh-CN', zhRate);
                    });
                }
            }
        }
    });

    // Settings inputs
    document.getElementById('cr-settings-body')?.addEventListener('input', e => {
        if (e.target.id === 'cr-de-rate') {
            deRate = parseFloat(e.target.value);
            const val = document.getElementById('cr-de-val');
            if (val) val.textContent = deRate.toFixed(1) + 'x';
        }
        if (e.target.id === 'cr-zh-rate') {
            zhRate = parseFloat(e.target.value);
            const val = document.getElementById('cr-zh-val');
            if (val) val.textContent = zhRate.toFixed(1) + 'x';
        }
    });

    // Global word clicks (for tips)
    document.addEventListener('click', e => {
        if (!e.target.closest('.cr-tip') && !e.target.closest('.cr-word')) {
            hideTip();
        }
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', e => {
        const panel = document.getElementById('cr-panel');
        if (!panel || !panel.classList.contains('cr-open')) return;
        if (currentView !== 'reader') return;
        const tag = e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

        if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); navSentence(-1); }
        if (e.key === 'ArrowRight') { e.preventDefault(); navSentence(1); }
        if (e.key === 'Escape') { e.preventDefault(); switchToView('list'); }
    });
}

// ========== Initialization ==========
jQuery(async () => {
    createUI();
    bindEvents();
    initVoices();
    console.log(`[${EXT_NAME}] Loaded successfully`);
});
