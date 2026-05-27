/*
 * EnglishMaster Pro - SillyTavern Extension
 * A comprehensive English learning plugin using SillyTavern's configured API.
 * Features: Vocabulary browsing, writing practice, dictation, article reading with TTS,
 *           AI tutoring, phonics, and more.
 *
 * TTS uses the browser's Web Speech API with reliability improvements.
 * LLM calls use SillyTavern's currently configured API backend.
 */

import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced, getRequestHeaders } from '../../../../script.js';

const extensionName = 'englishmaster-pro';
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

// ============================================================
// DEFAULT SETTINGS & STATE
// ============================================================
const defaultSettings = {
    deRate: 1.0,
    zhRate: 1.0,
    autoSpeak: true,
    voiceAll: true,
    browseExVoice: true,
    copyWord: 3,
    copyEx: 2,
    copyArt: 2,
    showForms: true,
    showExample: true,
    skipMastered: true,
    concurrency: 6,
};

const defaultState = {
    imported: [],
    articles: [],
    mastery: {},
    mastered: [],
    stats: { today: 0, total: 0, correct: 0, streak: 0, lastDate: '' },
    selectedLibs: [],
    mode: 'browse',
    order: 'seq',
    artSubMode: 'reader',
    kiConversations: [],
    kiActiveConvId: null,
    artPositions: {},
};

// ============================================================
// RELIABLE TTS ENGINE
// ============================================================
class ReliableTTS {
    constructor() {
        this.voices = [];
        this.initialized = false;
        this.speechId = 0;
        this._keepAlive = null;
    }

    async init() {
        if (typeof speechSynthesis === 'undefined') return false;
        return new Promise(resolve => {
            const load = () => {
                this.voices = speechSynthesis.getVoices();
                if (this.voices.length > 0) {
                    this.initialized = true;
                    resolve(true);
                }
            };
            load();
            if (speechSynthesis.onvoiceschanged !== undefined) {
                speechSynthesis.onvoiceschanged = load;
            }
            setTimeout(() => { load(); resolve(this.voices.length > 0); }, 3000);
        });
    }

    findVoice(lang) {
        if (!this.voices.length) this.voices = speechSynthesis.getVoices();
        const prefix = lang.split('-')[0];
        const candidates = this.voices.filter(
            v => v.lang === lang || v.lang.startsWith(prefix)
        );
        return candidates.find(v => v.localService) || candidates[0] || null;
    }

    /**
     * Speak a single piece of text. Returns a promise.
     * Includes Chrome timeout workaround and robust error handling.
     */
    speakOne(text, lang, rate) {
        return new Promise(resolve => {
            if (!this.initialized || !text?.trim()) { resolve(); return; }

            const utterance = new SpeechSynthesisUtterance(text.trim());
            utterance.lang = lang;
            utterance.rate = Math.max(0.1, Math.min(5, rate || 1));
            const voice = this.findVoice(lang);
            if (voice) utterance.voice = voice;

            let done = false;
            const finish = () => {
                if (!done) {
                    done = true;
                    clearTimeout(timeout);
                    clearInterval(keepAlive);
                    resolve();
                }
            };

            // Generous timeout based on text length
            const maxMs = Math.max(8000, text.length * 600 / (rate || 1));
            const timeout = setTimeout(finish, maxMs);

            // Chrome workaround: periodic pause/resume prevents 15s cutoff
            const keepAlive = setInterval(() => {
                if (speechSynthesis.speaking && !speechSynthesis.paused) {
                    try {
                        speechSynthesis.pause();
                        speechSynthesis.resume();
                    } catch (e) { /* ignore */ }
                }
            }, 10000);

            utterance.onend = finish;
            utterance.onerror = (e) => {
                console.warn('[EMP TTS] error:', e?.error || e);
                finish();
            };

            try {
                speechSynthesis.speak(utterance);
            } catch (e) {
                console.warn('[EMP TTS] speak exception:', e);
                finish();
            }

            // Safety: if speaking hasn't started after 2s, resolve
            setTimeout(() => {
                if (!done && !speechSynthesis.speaking) {
                    console.warn('[EMP TTS] speech never started, resolving');
                    finish();
                }
            }, 2000);
        });
    }

    /**
     * Cancel + delay + speak. Tracks speech ID so new calls cancel old ones.
     */
    async speak(text, lang, rate) {
        this.speechId++;
        const myId = this.speechId;
        this.cancel();
        await this._delay(100);
        if (this.speechId !== myId) return;
        await this.speakOne(text, lang, rate);
    }

    /**
     * Speak English then optionally Chinese.
     * Returns early if a newer speech call has been made.
     */
    async speakEnCn(en, cn, deRate, zhRate, speakCn) {
        this.speechId++;
        const myId = this.speechId;
        this.cancel();
        await this._delay(100);
        if (this.speechId !== myId) return;
        if (en?.trim()) {
            await this.speakOne(en.trim(), 'en-US', deRate);
            if (this.speechId !== myId) return;
        }
        if (speakCn && cn?.trim()) {
            await this._delay(200);
            if (this.speechId !== myId) return;
            await this.speakOne(cn.trim(), 'zh-CN', zhRate);
        }
    }

    /** Quick speak a single English word. */
    speakWord(word) {
        if (!word || !this.initialized) return;
        this.cancel();
        const u = new SpeechSynthesisUtterance(word);
        u.lang = 'en-US';
        u.rate = 1.0;
        const v = this.findVoice('en-US');
        if (v) u.voice = v;
        try { speechSynthesis.speak(u); } catch (e) { /* ignore */ }
    }

    cancel() {
        this.speechId++;
        try { speechSynthesis.cancel(); } catch (e) { /* ignore */ }
    }

    _delay(ms) {
        return new Promise(r => setTimeout(r, ms));
    }
}

// ============================================================
// GLOBAL VARIABLES
// ============================================================
let tts = new ReliableTTS();
let state = {};
let words = [];
let curIdx = 0;
let isPlaying = false;
let autoPlayTimer = null;
let copyInput = '';
let copyPhase = 'word';
let copyRound = 1;
let dictHintCount = 0;
let curArticle = null;
let curArticleIdx = -1;
let artSentIdx = 0;
let artRound = 1;
let artDictHint = 0;
let artCatFilter = '全部';
let artSubMode = 'reader';
let readerDisplayMode = 'bilingual';
let readerAudioMode = 'cnenmix';
let readerShowEN = true, readerShowCN = true, readerShowWW = true;
let browseVoiceMode = 'wordCnEn';
let readerLoopSingle = false;
let readerPlaying = false;
let readerPageNum = 0;
let readerTimer = null;
let playlistMode = false;
let playlistIdx = 0;
let playlistArticles = [];
const READER_PAGE_SIZE = 100;
const transCache = {};
let activeTipEl = null;
let tipHideTimer = null;
const inputSessionData = {
    copy: { total: 0, correct: 0, streak: 0 },
    easy: { total: 0, correct: 0, streak: 0 },
    dict: { total: 0, correct: 0, streak: 0 },
    art:  { total: 0, correct: 0, streak: 0 },
};
let kbShift = { copy: false, easy: false, dict: false, art: false };
let activeKBTab = { copy: 'qwerty', easy: 'qwerty', dict: 'qwerty', art: 'qwerty' };
let panelOpen = false;

// ============================================================
// UTILITY FUNCTIONS
// ============================================================
const eH = s => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const eA = s => (s || '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const hasChinese = s => /[\u4e00-\u9fff]/.test(s);
const cleanEnWord = w => (w || '').replace(/^[.,!?;:'"()\-–»«\[\]{}\/\\]+/, '').replace(/[.,!?;:'"()\-–»«…\[\]{}\/\\]+$/, '').trim();

function empToast(msg) {
    const t = document.getElementById('emp-toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._t);
    t._t = setTimeout(() => t.classList.remove('show'), 2500);
}

function shuf(a) {
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function isWWValid(ww) {
    return ((ww || '').match(/[a-zA-Z]+'?[a-zA-Z]*\s*\([^)]*[\u4e00-\u9fff][^)]*\)/g) || []).length >= 2;
}

// ============================================================
// DATA PERSISTENCE (localStorage)
// ============================================================
const STORAGE_KEY = 'emp_learning_data';

function loadState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            state = { ...defaultState, ...parsed };
        } else {
            state = { ...defaultState };
        }
    } catch (e) {
        console.warn('[EMP] Failed to load state:', e);
        state = { ...defaultState };
    }
}

let _saveTimer = null;
function saveState() {
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (e) {
            console.error('[EMP] Failed to save state:', e);
        }
    }, 1000);
}

function forceSaveState() {
    clearTimeout(_saveTimer);
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
        console.error('[EMP] Failed to save state:', e);
    }
}

// ============================================================
// SETTINGS (SillyTavern extension_settings)
// ============================================================
function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    const s = extension_settings[extensionName];
    for (const [k, v] of Object.entries(defaultSettings)) {
        if (s[k] === undefined) s[k] = v;
    }
}

function getS() {
    return extension_settings[extensionName] || defaultSettings;
}

function setS(key, val) {
    if (!extension_settings[extensionName]) extension_settings[extensionName] = {};
    extension_settings[extensionName][key] = val;
    saveSettingsDebounced();
}

// ============================================================
// LLM API (uses SillyTavern's configured API)
// ============================================================
async function callLLM(systemPrompt, userPrompt, temperature = 0.3, maxTokens = 4000) {
    try {
        // Method 1: Use SillyTavern's generate endpoint
        const response = await fetch('/api/backends/chat/completions', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ],
                temperature,
                max_tokens: maxTokens,
            }),
        });

        if (response.ok) {
            const data = await response.json();
            const content = data?.choices?.[0]?.message?.content
                || data?.content?.[0]?.text
                || data?.response
                || '';
            return content;
        }

        // Method 2: Fallback - try the text completions generate endpoint
        const response2 = await fetch('/api/backends/text/completions', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                prompt: `${systemPrompt}\n\nUser: ${userPrompt}\n\nAssistant:`,
                max_tokens: maxTokens,
                temperature,
            }),
        });

        if (response2.ok) {
            const data2 = await response2.json();
            return data2?.choices?.[0]?.text || data2?.results?.[0]?.text || '';
        }

        console.warn('[EMP] API call failed:', response.status);
        return null;
    } catch (e) {
        console.error('[EMP] API error:', e);
        return null;
    }
}

async function callLLMWithRetry(sys, usr, temp = 0.3, maxTokens = 4000, retries = 2) {
    for (let i = 0; i <= retries; i++) {
        const result = await callLLM(sys, usr, temp, maxTokens);
        if (result && result.trim()) return result;
        if (i < retries) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
    return null;
}

// ============================================================
// TRANSLATION
// ============================================================
async function translateEN(word) {
    if (!word) return '—';
    const clean = cleanEnWord(word);
    if (!clean) return '—';
    const lower = clean.toLowerCase();
    if (transCache[lower] && hasChinese(transCache[lower])) return transCache[lower];

    // Search imported vocabulary
    for (const lib of (state.imported || [])) {
        for (const e of (lib.data || [])) {
            if (cleanEnWord(e[0]).toLowerCase() === lower && e[2] && hasChinese(e[2])) {
                transCache[lower] = e[2];
                return e[2];
            }
        }
    }

    // Use LLM for translation
    const result = await callLLM(
        '你是翻译引擎。只输出中文翻译，不要解释。',
        `翻译这个英语单词/短语为中文: ${clean}`,
        0.1, 100
    );
    if (result && hasChinese(result)) {
        transCache[lower] = result.trim();
        return result.trim();
    }
    return '[' + clean + ']';
}

// ============================================================
// CLICKABLE WORD RENDERING
// ============================================================
function renderClickableEN(text) {
    if (!text) return '';
    const clean = (text || '').replace(/\|/g, '');
    return clean.split(/(\s+)/).map(part => {
        if (!part) return '';
        if (/^\s+$/.test(part)) return ' ';
        if (/[a-zA-Z]/.test(part)) {
            const m = part.match(/^([^a-zA-Z]*)([a-zA-Z][a-zA-Z'\-]*[a-zA-Z]|[a-zA-Z])([^a-zA-Z]*)$/);
            if (m) {
                return eH(m[1]) +
                    `<span class="emp-clickable-word" data-speak="${eA(cleanEnWord(m[2]))}">${eH(m[2])}</span>` +
                    eH(m[3]);
            }
            return `<span class="emp-clickable-word" data-speak="${eA(cleanEnWord(part))}">${eH(part)}</span>`;
        }
        return eH(part);
    }).join('');
}

function renderAIText(text) {
    if (!text) return '';
    return text.split('\n').map(line => {
        if (!line.trim()) return '<br>';
        return line.split(/(\s+)/).map(tk => {
            if (/^\s+$/.test(tk)) return tk;
            if (!tk) return '';
            if (/[a-zA-Z]/.test(tk) && !/[\u4e00-\u9fff]/.test(tk)) {
                const c = cleanEnWord(tk);
                return c ? `<span class="emp-clickable-word" data-speak="${eA(c)}">${eH(tk)}</span>` : eH(tk);
            }
            return eH(tk);
        }).join('');
    }).join('<br>');
}

// ============================================================
// TOOLTIP
// ============================================================
function hideTip() {
    if (activeTipEl) { activeTipEl.remove(); activeTipEl = null; }
    if (tipHideTimer) { clearTimeout(tipHideTimer); tipHideTimer = null; }
}

function showTip(el, text) {
    hideTip();
    const r = el.getBoundingClientRect();
    const panel = document.getElementById('emp-panel');
    if (!panel) return;
    const tip = document.createElement('div');
    tip.className = 'emp-trans-tip';
    tip.textContent = text;
    let top = r.top - 8;
    if (top < 60) {
        tip.classList.add('emp-show-below');
        tip.style.top = (r.bottom + 8) + 'px';
    } else {
        tip.style.top = top + 'px';
        tip.style.transform = 'translateX(-50%) translateY(-100%)';
    }
    tip.style.left = (r.left + r.width / 2) + 'px';
    if (!tip.style.transform) tip.style.transform = 'translateX(-50%)';
    document.body.appendChild(tip);
    requestAnimationFrame(() => {
        const tr = tip.getBoundingClientRect();
        if (tr.right > window.innerWidth - 8) tip.style.left = (window.innerWidth - tr.width / 2 - 8) + 'px';
        if (tr.left < 8) tip.style.left = (tr.width / 2 + 8) + 'px';
        tip.classList.add('emp-visible');
    });
    activeTipEl = tip;
    tipHideTimer = setTimeout(hideTip, 4000);
}

async function onClickWord(el) {
    const raw = el.dataset.speak || el.textContent.trim();
    const clean = cleanEnWord(raw);
    if (!clean) return;
    el.classList.add('emp-speaking');
    setTimeout(() => el.classList.remove('emp-speaking'), 1200);
    tts.speakWord(clean);
    hideTip();
    showTip(el, '翻译中');
    const trans = await translateEN(clean);
    if (activeTipEl) activeTipEl.textContent = trans;
}

// ============================================================
// DATE & STATS
// ============================================================
function checkDate() {
    const td = new Date().toISOString().split('T')[0];
    if (state.stats.lastDate && state.stats.lastDate !== td) {
        if (Math.floor((new Date(td) - new Date(state.stats.lastDate)) / 864e5) > 1) {
            state.stats.streak = 0;
        }
        state.stats.today = 0;
    }
    state.stats.lastDate = td;
}

function recordToday() {
    checkDate();
    if (state.stats.today === 0) state.stats.streak++;
    state.stats.today++;
    updateStats();
    saveState();
}

function updateStats() {
    const el = (id) => document.getElementById(id);
    el('emp-statToday') && (el('emp-statToday').textContent = state.stats.today);
    el('emp-statStreak') && (el('emp-statStreak').textContent = state.stats.streak);
    el('emp-statMaster') && (el('emp-statMaster').textContent = state.mastered.length);
    const acc = state.stats.total ? Math.round(state.stats.correct / state.stats.total * 100) : 0;
    el('emp-statAcc') && (el('emp-statAcc').textContent = acc + '%');
}

// ============================================================
// VOCABULARY MANAGEMENT
// ============================================================
function getAllLibs() {
    return (state.imported || []).map((l, i) => ({
        id: 'enimp_' + i, name: l.name, count: l.data.length, impIdx: i,
    }));
}

function buildWordList() {
    let w = [];
    (state.selectedLibs || []).forEach(id => {
        if (id.startsWith('enimp_')) {
            const idx = parseInt(id.split('_')[1]);
            if (state.imported[idx]) {
                state.imported[idx].data.forEach(d => {
                    w.push([d[0]||'', d[1]||'', d[2]||'', d[3]||'', d[4]||'', d[5]||'', state.imported[idx].name]);
                });
            }
        }
    });
    if (getS().skipMastered) w = w.filter(d => !state.mastered.includes(d[0]));
    if (state.order === 'rand') shuf(w);
    words = w;
    curIdx = 0;
    if (isPlaying) stopAutoPlay();
    renderWordList();
    updateProgress();
    if (w.length) empToast(w.length + ' 词');
    onWordChange();
}

function renderWordList() {
    const el = document.getElementById('emp-wordList');
    if (!el) return;
    const mx = Math.min(words.length, 50);
    let h = '';
    for (let i = 0; i < mx; i++) {
        const w = words[i];
        h += `<div class="emp-word-item${i === curIdx ? ' emp-current' : ''}" data-widx="${i}">
            <span class="emp-wi-char">${i === curIdx ? '▸ ' : ''}${eH(w[0])}</span>
            <span class="emp-wi-mean">${eH(w[2] || '')}</span>
        </div>`;
    }
    if (!words.length) h = '<div class="emp-empty-sm">无词汇 — 请先导入词库</div>';
    el.innerHTML = h;
}

function updateProgress() {
    const t = words.length || 1;
    const p = Math.round((curIdx + 1) / t * 100);
    const el = document.getElementById('emp-progressText');
    const bar = document.getElementById('emp-progressFill');
    if (el) el.textContent = words.length ? `${curIdx + 1}/${words.length}` : '0/0';
    if (bar) bar.style.width = (words.length ? p : 0) + '%';
}

function onWordChange() {
    renderWordList();
    updateProgress();
    const m = state.mode;
    if (m === 'browse') renderBrowse();
    else if (m === 'copy') { copyRound = 1; copyInput = ''; copyPhase = 'word'; renderCopy(); }
    else if (m === 'easyCopy') { copyRound = 1; copyInput = ''; copyPhase = 'word'; renderEasy(); }
    else if (m === 'dictation') { copyRound = 1; copyInput = ''; copyPhase = 'word'; dictHintCount = 0; renderDict(); }
}

function nav(dir) {
    if (!words.length) return;
    if (isPlaying) stopAutoPlay();
    curIdx += dir;
    if (curIdx < 0) curIdx = words.length - 1;
    if (curIdx >= words.length) curIdx = 0;
    onWordChange();
}

// ============================================================
// BROWSE MODE
// ============================================================
function renderBrowse() {
    const card = document.getElementById('emp-browseCard');
    const empty = document.getElementById('emp-browseEmpty');
    const ctrls = document.getElementById('emp-browseControls');
    if (!card || !empty || !ctrls) return;
    if (!words.length) {
        card.style.display = 'none'; ctrls.style.display = 'none'; empty.style.display = '';
        return;
    }
    card.style.display = ''; ctrls.style.display = ''; empty.style.display = 'none';
    const w = words[curIdx];
    const s = getS();

    document.getElementById('emp-browseType').textContent = w[6] || '-';
    document.getElementById('emp-browseMain').textContent = w[0];
    const formsEl = document.getElementById('emp-browseForms');
    formsEl.textContent = w[1] || '';
    formsEl.style.display = s.showForms && w[1] ? '' : 'none';
    document.getElementById('emp-browseMeaning').textContent = w[2] || '';

    const gramEl = document.getElementById('emp-browseGrammar');
    gramEl.textContent = w[5] || '';
    gramEl.style.display = w[5] ? 'inline-block' : 'none';

    // Mastery badge
    const ch = w[0];
    const ms = state.mastered.includes(ch);
    const badge = document.getElementById('emp-browseMastery');
    const ml = state.mastery[ch] || 0;
    if (ms) { badge.className = 'emp-mastery-badge emp-m-mastered'; badge.textContent = 'Mastered'; }
    else if (ml >= 5) { badge.className = 'emp-mastery-badge emp-m-familiar'; badge.textContent = 'Familiar'; }
    else if (ml >= 1) { badge.className = 'emp-mastery-badge emp-m-learning'; badge.textContent = 'Learning'; }
    else { badge.className = 'emp-mastery-badge emp-m-new'; badge.textContent = 'New'; }

    // Example
    const exBox = document.getElementById('emp-browseExample');
    if (s.showExample && w[3]) {
        exBox.style.display = '';
        document.getElementById('emp-browseExDe').innerHTML = renderClickableEN(w[3]);
        document.getElementById('emp-browseExCn').textContent = w[4] || '';
    } else {
        exBox.style.display = 'none';
    }

    document.getElementById('emp-aiResult').style.display = 'none';

    // Auto speak
    if (s.autoSpeak && !isPlaying) {
        tts.speakEnCn(w[0], w[2] || '', s.deRate, s.zhRate, s.voiceAll);
    }
}

// ============================================================
// AUTO PLAY (Browse mode continuous playback)
// ============================================================
function toggleAutoPlay() { if (isPlaying) stopAutoPlay(); else startAutoPlay(); }

function startAutoPlay() {
    if (!words.length) return;
    isPlaying = true;
    const btn = document.getElementById('emp-btnPlay');
    if (btn) btn.textContent = '⏸️';
    autoPlayStep();
}

function stopAutoPlay() {
    isPlaying = false;
    const btn = document.getElementById('emp-btnPlay');
    if (btn) btn.textContent = '▶️';
    clearTimeout(autoPlayTimer);
    tts.cancel();
}

async function autoPlayStep() {
    if (!isPlaying || !words.length) return;
    renderBrowse();
    updateProgress();
    renderWordList();
    const w = words[curIdx];
    const s = getS();
    const vm = browseVoiceMode;

    tts.speechId++;
    const myId = tts.speechId;
    tts.cancel();
    await new Promise(r => setTimeout(r, 100));
    if (tts.speechId !== myId || !isPlaying) return;

    // Speak based on voice mode
    if (vm !== 'exCnEn') {
        await tts.speakOne(w[0], 'en-US', s.deRate);
        if (tts.speechId !== myId || !isPlaying) return;
        if (vm !== 'allEn' && w[2]) {
            await tts.speakOne(w[2], 'zh-CN', s.zhRate);
            if (tts.speechId !== myId || !isPlaying) return;
        }
    }
    if (vm !== 'wordCnEn') {
        const ex = w[3] ? w[3].replace(/\|/g, '') : w[0];
        const ec = w[4] || w[2] || '';
        await tts.speakOne(ex, 'en-US', s.deRate);
        if (tts.speechId !== myId || !isPlaying) return;
        if (vm !== 'allEn' && ec) {
            await tts.speakOne(ec, 'zh-CN', s.zhRate);
            if (tts.speechId !== myId || !isPlaying) return;
        }
    }

    autoPlayTimer = setTimeout(() => {
        if (!isPlaying) return;
        curIdx++;
        if (curIdx >= words.length) { curIdx = 0; shuf(words); empToast('🎉 一轮完成'); }
        recordToday();
        autoPlayStep();
    }, 2000);
}

// ============================================================
// COPY TARGET / ROUNDS HELPERS
// ============================================================
function getCopyTarget() {
    if (!words.length) return '';
    const w = words[curIdx];
    return copyPhase === 'word' ? w[0] : (w[3] ? w[3].replace(/\|/g, '') : w[0]);
}

function getMaxRound() {
    const s = getS();
    return copyPhase === 'word' ? s.copyWord : s.copyEx;
}

function renderDots(round, max) {
    let d = '';
    for (let i = 1; i <= max; i++) d += `<span class="emp-dot${i < round ? ' emp-filled' : ''}"></span>`;
    return `<div>${round}/${max}</div><div class="emp-dots">${d}</div>`;
}

function renderCopyInput(id) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = eH(copyInput) + '<span class="emp-cursor"></span>';
}

function renderInputStats(mode, id) {
    const el = document.getElementById(id);
    if (!el) return;
    const s = inputSessionData[mode];
    const p = s.total ? Math.round(s.correct / s.total * 100) : 0;
    el.innerHTML = `
        <div class="emp-is"><div class="emp-is-val">${s.total}</div><div class="emp-is-lbl">总数</div></div>
        <div class="emp-is"><div class="emp-is-val">${s.correct}</div><div class="emp-is-lbl">正确</div></div>
        <div class="emp-is"><div class="emp-is-val">${p}%</div><div class="emp-is-lbl">率</div></div>
        <div class="emp-is"><div class="emp-is-val">${s.streak}</div><div class="emp-is-lbl">连对</div></div>`;
}

function advanceCopy(inputBoxId, renderFn) {
    copyRound++;
    const mx = getMaxRound();
    if (copyRound > mx) {
        const w = words[curIdx];
        if (copyPhase === 'word' && w[3]) {
            copyPhase = 'ex'; copyRound = 1;
        } else {
            curIdx++;
            if (curIdx >= words.length) { curIdx = 0; empToast('🎉!'); }
            copyPhase = 'word'; copyRound = 1;
        }
        recordToday();
    }
    setTimeout(() => {
        const ib = document.getElementById(inputBoxId);
        if (ib) ib.classList.remove('emp-correct');
        copyInput = '';
        renderFn();
    }, 600);
}

// ============================================================
// COPY MODE
// ============================================================
function renderCopy() {
    if (!words.length) return;
    const w = words[curIdx];
    const tgt = getCopyTarget();
    const mx = getMaxRound();
    const progEl = document.getElementById('emp-copyProgress');
    if (progEl) progEl.innerHTML = renderDots(copyRound, mx);
    const refEl = document.getElementById('emp-copyRefText');
    if (refEl) {
        refEl.innerHTML = renderClickableEN(tgt);
        refEl.style.fontSize = tgt.length > 12 ? '1.1rem' : '1.6rem';
    }
    const detEl = document.getElementById('emp-copyRefDetail');
    if (detEl) detEl.textContent = copyPhase === 'word' ? ((w[1] || '') + ' — ' + (w[2] || '')) : (w[4] || w[2] || '');
    renderCopyInput('emp-copyInputBox');
    const ans = document.getElementById('emp-copyAnswer');
    if (ans) { ans.className = 'emp-answer'; ans.style.display = 'none'; }
    renderInputStats('copy', 'emp-copyStats');
    // Update tabs
    document.querySelectorAll('#emp-copyTabs .emp-tab-btn').forEach(t =>
        t.classList.toggle('emp-active', t.dataset.phase === copyPhase));
}

function confirmCopy() {
    if (!words.length) return;
    const tgt = getCopyTarget();
    const s = inputSessionData.copy;
    s.total++; state.stats.total++;
    if (copyInput === tgt) {
        s.correct++; s.streak++; state.stats.correct++;
        const ib = document.getElementById('emp-copyInputBox');
        if (ib) ib.classList.add('emp-correct');
        const ans = document.getElementById('emp-copyAnswer');
        if (ans) { ans.className = 'emp-answer emp-show emp-ok'; ans.textContent = '✅'; }
        advanceCopy('emp-copyInputBox', renderCopy);
    } else {
        s.streak = 0;
        const ib = document.getElementById('emp-copyInputBox');
        if (ib) { ib.classList.add('emp-wrong', 'emp-shake'); setTimeout(() => ib.classList.remove('emp-wrong', 'emp-shake'), 500); }
        const ans = document.getElementById('emp-copyAnswer');
        if (ans) { ans.className = 'emp-answer emp-show emp-ng'; ans.textContent = '❌ ' + tgt; }
    }
    renderInputStats('copy', 'emp-copyStats');
}

// ============================================================
// EASY COPY MODE
// ============================================================
function renderEasy() {
    if (!words.length) return;
    const w = words[curIdx];
    const mx = getMaxRound();
    const progEl = document.getElementById('emp-easyProgress');
    if (progEl) progEl.innerHTML = renderDots(copyRound, mx);
    document.querySelectorAll('#emp-easyTabs .emp-tab-btn').forEach(t =>
        t.classList.toggle('emp-active', t.dataset.phase === copyPhase));

    const de = copyPhase === 'word' ? w[0] : (w[3] || w[0]);
    const cn = copyPhase === 'word' ? w[2] : (w[4] || w[2]);
    renderEasySegments(de, cn, 'emp-easySegments', copyInput.length);
    renderCopyInput('emp-easyInputBox');
    const ans = document.getElementById('emp-easyAnswer');
    if (ans) { ans.className = 'emp-answer'; ans.style.display = 'none'; }
    renderInputStats('easy', 'emp-easyStats');
}

function renderEasySegments(de, cn, containerId, charIdx) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const t = (de || '').replace(/\|/g, '');
    let h = '<div class="emp-seg-row">';
    t.split(/(\s+)/).forEach(p => {
        if (!p) return;
        if (/^\s+$/.test(p)) { h += ' '; return; }
        if (/[a-zA-Z]/.test(p)) {
            h += `<span class="emp-clickable-word" data-speak="${eA(cleanEnWord(p))}">${eH(p)}</span>`;
        } else {
            h += eH(p);
        }
    });
    h += '</div>';
    if (cn) h += `<div class="emp-seg-cn">${eH((cn || '').replace(/\|/g, ' '))}</div>`;
    if (charIdx >= 0 && t.length > 0) {
        const pct = Math.round(charIdx / t.length * 100);
        h += `<div class="emp-prog-mini"><div class="emp-prog-mini-fill" style="width:${pct}%"></div></div>`;
    }
    el.innerHTML = h;
}

function checkEasyChar() {
    const tgt = getCopyTarget();
    const li = copyInput.length - 1;
    if (li < 0) return;
    const s = inputSessionData.easy;
    s.total++; state.stats.total++;
    if (copyInput[li] === tgt[li]) {
        s.correct++; s.streak++; state.stats.correct++;
        if (copyInput === tgt) {
            const ib = document.getElementById('emp-easyInputBox');
            if (ib) ib.classList.add('emp-correct');
            advanceCopy('emp-easyInputBox', renderEasy);
        }
    } else {
        s.streak = 0;
        copyInput = copyInput.slice(0, -1);
        const ib = document.getElementById('emp-easyInputBox');
        if (ib) { ib.classList.add('emp-shake'); setTimeout(() => ib.classList.remove('emp-shake'), 400); }
    }
    renderInputStats('easy', 'emp-easyStats');
}

// ============================================================
// DICTATION MODE
// ============================================================
function renderDict() {
    if (!words.length) return;
    const w = words[curIdx];
    const tgt = getCopyTarget();
    const mx = getMaxRound();
    const s = getS();
    document.querySelectorAll('#emp-dictTabs .emp-tab-btn').forEach(t =>
        t.classList.toggle('emp-active', t.dataset.phase === copyPhase));
    const progEl = document.getElementById('emp-dictProgress');
    if (progEl) progEl.innerHTML = renderDots(copyRound, mx);
    const hidden = document.getElementById('emp-dictHidden');
    if (hidden) hidden.textContent = dictHintCount > 0 ? tgt.substring(0, dictHintCount) + '…' : '???';
    const clue = document.getElementById('emp-dictClue');
    if (clue) clue.textContent = copyPhase === 'word' ? (w[2] || '') : (w[4] || w[2] || '');
    renderCopyInput('emp-dictInputBox');
    const ans = document.getElementById('emp-dictAnswer');
    if (ans) { ans.className = 'emp-answer'; ans.style.display = 'none'; }
    renderInputStats('dict', 'emp-dictStats');

    // Auto-play on load
    if (s.autoSpeak) {
        tts.speak(tgt, 'en-US', s.deRate);
    }
}

function confirmDict() {
    if (!words.length) return;
    const tgt = getCopyTarget();
    const s = inputSessionData.dict;
    s.total++; state.stats.total++;
    if (copyInput === tgt) {
        s.correct++; s.streak++; state.stats.correct++;
        const ib = document.getElementById('emp-dictInputBox');
        if (ib) ib.classList.add('emp-correct');
        const ans = document.getElementById('emp-dictAnswer');
        if (ans) { ans.className = 'emp-answer emp-show emp-ok'; ans.textContent = '✅ ' + tgt; }
        const hidden = document.getElementById('emp-dictHidden');
        if (hidden) hidden.textContent = tgt;
        copyRound++;
        const mx = getMaxRound();
        if (copyRound > mx) {
            const w = words[curIdx];
            if (copyPhase === 'word' && w[3]) { copyPhase = 'ex'; copyRound = 1; }
            else {
                curIdx++;
                if (curIdx >= words.length) { curIdx = 0; empToast('🎉!'); }
                copyPhase = 'word'; copyRound = 1;
            }
            recordToday();
        }
        setTimeout(() => {
            if (ib) ib.classList.remove('emp-correct');
            copyInput = '';
            dictHintCount = 0;
            renderDict();
        }, 1000);
    } else {
        s.streak = 0;
        const ib = document.getElementById('emp-dictInputBox');
        if (ib) { ib.classList.add('emp-wrong', 'emp-shake'); setTimeout(() => ib.classList.remove('emp-wrong', 'emp-shake'), 500); }
        const ans = document.getElementById('emp-dictAnswer');
        if (ans) { ans.className = 'emp-answer emp-show emp-ng'; ans.textContent = '❌ ' + tgt; }
        const hidden = document.getElementById('emp-dictHidden');
        if (hidden) hidden.textContent = tgt;
    }
    renderInputStats('dict', 'emp-dictStats');
}

// ============================================================
// KEYBOARD
// ============================================================
const QWERTY_LOWER = [
    ['q','w','e','r','t','y','u','i','o','p'],
    ['a','s','d','f','g','h','j','k','l'],
    ['z','x','c','v','b','n','m'],
];
const QWERTY_UPPER = QWERTY_LOWER.map(row => row.map(c => c.toUpperCase()));
const PNCT = ['.', ',', '!', '?', ';', ':', '-', "'", '"', '(', ')', '/'];

function renderKeyboard(mode) {
    const grid = document.getElementById(`emp-${mode}KBGrid`);
    if (!grid) return;
    const tab = activeKBTab[mode];
    const sh = kbShift[mode];
    let g = '';
    if (tab === 'qwerty') {
        const rows = sh ? QWERTY_UPPER : QWERTY_LOWER;
        rows.forEach(row => {
            g += '<div class="emp-kb-row">';
            row.forEach(ch => {
                g += `<button class="emp-key" data-char="${eA(ch)}" data-mode="${mode}">${eH(ch)}</button>`;
            });
            g += '</div>';
        });
        g += '<div class="emp-kb-row">';
        g += `<button class="emp-key emp-shift${sh ? ' emp-shift-on' : ''}" data-act="shift" data-mode="${mode}">⇧</button>`;
        g += `<button class="emp-key emp-space" data-char=" " data-mode="${mode}">Space</button>`;
        g += `<button class="emp-key" data-act="back" data-mode="${mode}">⌫</button>`;
        g += '</div>';
    } else {
        g += '<div class="emp-kb-row" style="flex-wrap:wrap">';
        PNCT.forEach(ch => {
            g += `<button class="emp-key" data-char="${eA(ch)}" data-mode="${mode}">${eH(ch)}</button>`;
        });
        g += '</div><div class="emp-kb-row">';
        g += `<button class="emp-key emp-space" data-char=" " data-mode="${mode}">Space</button>`;
        g += `<button class="emp-key" data-act="back" data-mode="${mode}">⌫</button>`;
        g += '</div>';
    }
    grid.innerHTML = g;

    // Tabs
    const tabs = document.getElementById(`emp-${mode}KBTabs`);
    if (tabs) {
        tabs.innerHTML = ['qwerty', 'punct'].map(k =>
            `<button class="emp-kb-tab${tab === k ? ' emp-active' : ''}" data-kbtype="${k}" data-mode="${mode}">${k === 'qwerty' ? 'ABC' : 'Signs'}</button>`
        ).join('');
    }
}

function onKeyPress(ch, mode) {
    copyInput += ch;
    if (mode === 'easy') checkEasyChar();
    else if (mode === 'art' && artSubMode === 'artEasy') checkArtEasyChar();
    refreshModeInput(mode);
}

function onBackspace(mode) {
    if (copyInput.length > 0) copyInput = copyInput.slice(0, -1);
    refreshModeInput(mode);
}

function onClear(mode) {
    copyInput = '';
    if (mode === 'dict') dictHintCount = 0;
    if (mode === 'art') artDictHint = 0;
    refreshModeInput(mode);
}

function refreshModeInput(mode) {
    if (mode === 'copy') renderCopy();
    else if (mode === 'easy') renderEasy();
    else if (mode === 'dict') renderDict();
    else if (mode === 'art') renderArticleWork();
}

// ============================================================
// ARTICLE SYSTEM
// ============================================================
function getArtSent() { return curArticle ? curArticle.sentences[artSentIdx] : null; }
function getArtTarget() { const s = getArtSent(); return s ? (s.de || '').replace(/\|/g, '') : ''; }

function parseArticleText(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l);
    const sents = [];
    const isWW = x => ((x.match(/[a-zA-Z]+\s*\([^)]*[\u4e00-\u9fff][^)]*\)/g) || []).length >= 3);
    const isEN = x => { const ec = (x.match(/[a-zA-Z]/g) || []).length; const cc = (x.match(/[\u4e00-\u9fff]/g) || []).length; return ec > cc && ec >= 3; };
    let i = 0;
    while (i < lines.length) {
        if (i + 2 < lines.length && isEN(lines[i]) && hasChinese(lines[i+1]) && isWW(lines[i+2])) {
            sents.push({ de: lines[i], cn: lines[i+1], ww: lines[i+2] }); i += 3;
        } else if (i + 1 < lines.length && isEN(lines[i]) && hasChinese(lines[i+1])) {
            sents.push({ de: lines[i], cn: lines[i+1], ww: '' }); i += 2;
        } else {
            sents.push({ de: lines[i], cn: '', ww: '' }); i++;
        }
    }
    return sents;
}

function saveArtPos() {
    if (!curArticle || curArticleIdx < 0) return;
    if (!state.artPositions) state.artPositions = {};
    const key = curArticle.title || ('art_' + curArticleIdx);
    state.artPositions[key] = { sentIdx: artSentIdx, pageNum: readerPageNum };
    saveState();
}

// ============================================================
// READER MODE
// ============================================================
function renderReader() {
    if (!curArticle) return;
    const sents = curArticle.sentences;
    const totalPages = Math.ceil(sents.length / READER_PAGE_SIZE);
    const activePage = Math.floor(artSentIdx / READER_PAGE_SIZE);
    if (readerPlaying && readerPageNum !== activePage) readerPageNum = activePage;
    if (readerPageNum >= totalPages) readerPageNum = totalPages - 1;
    if (readerPageNum < 0) readerPageNum = 0;

    const pageStart = readerPageNum * READER_PAGE_SIZE;
    const pageEnd = Math.min(pageStart + READER_PAGE_SIZE, sents.length);

    // Title & progress
    const titleEl = document.getElementById('emp-readerTitle');
    if (titleEl) titleEl.textContent = curArticle.title;
    const progText = document.getElementById('emp-readerProgText');
    if (progText) progText.textContent = `${artSentIdx + 1}/${sents.length}`;
    const progFill = document.getElementById('emp-readerProgFill');
    if (progFill) progFill.style.width = Math.round((artSentIdx + 1) / sents.length * 100) + '%';

    // Pager
    const pager = document.getElementById('emp-readerPager');
    if (pager) {
        if (totalPages > 1) {
            let ph = '';
            ph += `<button class="emp-pg-btn" data-pgact="prev" ${readerPageNum === 0 ? 'disabled' : ''}>◀</button>`;
            const maxBtns = 7;
            let startP = Math.max(0, readerPageNum - 3);
            let endP = Math.min(totalPages, startP + maxBtns);
            if (endP - startP < maxBtns) startP = Math.max(0, endP - maxBtns);
            for (let p = startP; p < endP; p++) {
                ph += `<button class="emp-pg-btn${p === readerPageNum ? ' emp-pg-active' : ''}" data-pgnum="${p}">${p + 1}</button>`;
            }
            ph += `<button class="emp-pg-btn" data-pgact="next" ${readerPageNum >= totalPages - 1 ? 'disabled' : ''}>▶</button>`;
            ph += `<span class="emp-pg-info">${pageStart+1}-${pageEnd}/${sents.length}</span>`;
            pager.innerHTML = ph;
            pager.style.display = '';
        } else {
            pager.innerHTML = '';
            pager.style.display = 'none';
        }
    }

    // Sentences
    const body = document.getElementById('emp-readerBody');
    if (body) {
        let hh = '';
        for (let i = pageStart; i < pageEnd; i++) {
            const s = sents[i];
            const isActive = i === artSentIdx;
            const isPlayed = i < artSentIdx;
            let cls = 'emp-reader-sent';
            if (isActive) cls += ' emp-active-sent';
            if (isPlayed) cls += ' emp-played-sent';
            const enText = (s.de || '').replace(/\|/g, '');
            const cnText = (s.cn || '').replace(/\|/g, '');
            const wwText = (s.ww || '').replace(/\|/g, '');
            hh += `<div class="${cls}" data-sentidx="${i}">
                <span class="emp-sent-num">#${i + 1}</span>
                <div class="emp-sent-en${readerShowEN ? '' : ' emp-hidden'}">${renderClickableEN(enText)}</div>
                <div class="emp-sent-cn${readerShowCN ? '' : ' emp-hidden'}">${eH(cnText)}</div>
                ${wwText ? `<div class="emp-sent-ww${readerShowWW ? '' : ' emp-hidden'}">${renderClickableEN(wwText)}</div>` : ''}
            </div>`;
        }
        body.innerHTML = hh;
        setTimeout(() => {
            const active = body.querySelector('.emp-active-sent');
            if (active) active.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 80);
    }

    // Controls state
    const playBtn = document.getElementById('emp-rcPlay');
    if (playBtn) {
        playBtn.textContent = readerPlaying ? '⏸' : '▶️';
        playBtn.classList.toggle('emp-playing', readerPlaying);
    }
    const loopBtn = document.getElementById('emp-rcLoop');
    if (loopBtn) loopBtn.classList.toggle('emp-active', readerLoopSingle);
    const speedEl = document.getElementById('emp-rcSpeed');
    if (speedEl) speedEl.textContent = getS().deRate.toFixed(1) + 'x';

    // Toolbar active states
    document.querySelectorAll('#emp-readerToolbar .emp-rtb').forEach(b => {
        if (b.dataset.rmode === 'bilingual') b.classList.toggle('emp-active', readerDisplayMode === 'bilingual');
        if (b.dataset.rmode === 'enonly') b.classList.toggle('emp-active', readerDisplayMode === 'enonly');
        if (b.dataset.rmode === 'singleloop') b.classList.toggle('emp-active', readerLoopSingle);
        if (b.dataset.raudio === 'cnenmix') b.classList.toggle('emp-active', readerAudioMode === 'cnenmix');
        if (b.dataset.raudio === 'enonly') b.classList.toggle('emp-active', readerAudioMode === 'enonly');
        if (b.dataset.raudio === 'wwonly') b.classList.toggle('emp-active', readerAudioMode === 'wwonly');
        if (b.dataset.rshow === 'en') b.classList.toggle('emp-active', readerShowEN);
        if (b.dataset.rshow === 'cn') b.classList.toggle('emp-active', readerShowCN);
        if (b.dataset.rshow === 'ww') b.classList.toggle('emp-active', readerShowWW);
    });

    // Playlist bar
    const plBar = document.getElementById('emp-playlistBar');
    if (plBar) {
        if (playlistMode) {
            plBar.style.display = '';
            document.getElementById('emp-plTitle').textContent = curArticle.title;
            document.getElementById('emp-plIdx').textContent = playlistIdx + 1;
            document.getElementById('emp-plTotal').textContent = playlistArticles.length;
        } else {
            plBar.style.display = 'none';
        }
    }
}

function readerNav(dir) {
    if (!curArticle) return;
    stopReaderPlay();
    artSentIdx += dir;
    if (artSentIdx < 0) artSentIdx = curArticle.sentences.length - 1;
    if (artSentIdx >= curArticle.sentences.length) artSentIdx = 0;
    saveArtPos();
    renderReader();
}

function stopReaderPlay() {
    readerPlaying = false;
    clearTimeout(readerTimer);
    tts.cancel();
    renderReader();
}

function toggleReaderPlay() {
    if (readerPlaying) { stopReaderPlay(); return; }
    if (!curArticle) return;
    readerPlaying = true;
    readerStep();
}

async function readerStep() {
    if (!readerPlaying || !curArticle) return;
    const neededPage = Math.floor(artSentIdx / READER_PAGE_SIZE);
    if (neededPage !== readerPageNum) readerPageNum = neededPage;
    renderReader();

    const s = getArtSent();
    if (!s) { stopReaderPlay(); return; }
    const en = (s.de || '').replace(/\|/g, '');
    const cn = (s.cn || '').replace(/\|/g, '');
    const settings = getS();

    tts.speechId++;
    const myId = tts.speechId;
    tts.cancel();
    await new Promise(r => setTimeout(r, 100));
    if (tts.speechId !== myId || !readerPlaying) return;

    if (readerAudioMode === 'wwonly' && s.ww) {
        const pairs = (s.ww || '').match(/([a-zA-Z][a-zA-Z'-]*)\s*\(([^)]+)\)/g) || [];
        for (const pair of pairs) {
            if (tts.speechId !== myId || !readerPlaying) return;
            const mm = pair.match(/([a-zA-Z][a-zA-Z'-]*)\s*\(([^)]+)\)/);
            if (mm) {
                await tts.speakOne(mm[1], 'en-US', settings.deRate);
                if (tts.speechId !== myId || !readerPlaying) return;
                await tts.speakOne(mm[2], 'zh-CN', settings.zhRate);
                if (tts.speechId !== myId || !readerPlaying) return;
            }
        }
    } else {
        await tts.speakOne(en, 'en-US', settings.deRate);
        if (tts.speechId !== myId || !readerPlaying) return;
        if (readerAudioMode === 'cnenmix' && cn) {
            await tts.speakOne(cn, 'zh-CN', settings.zhRate);
            if (tts.speechId !== myId || !readerPlaying) return;
        }
    }

    readerTimer = setTimeout(() => {
        if (!readerPlaying) return;
        artSentIdx++;
        saveArtPos();
        if (artSentIdx >= curArticle.sentences.length) {
            if (readerLoopSingle) {
                artSentIdx = 0;
                recordToday();
                readerStep();
            } else if (playlistMode) {
                playlistIdx++;
                if (playlistIdx >= playlistArticles.length) playlistIdx = 0;
                curArticle = playlistArticles[playlistIdx];
                curArticleIdx = state.articles.indexOf(curArticle);
                artSentIdx = 0;
                recordToday();
                readerStep();
            } else {
                artSentIdx = 0;
                empToast('🎉 播放完成');
                stopReaderPlay();
            }
        } else {
            readerStep();
        }
    }, 800);
}

function startPlaylist() {
    const flt = state.articles.filter(a => artCatFilter === '全部' || a.cat === artCatFilter);
    if (!flt.length) { empToast('无文章'); return; }
    playlistArticles = flt;
    playlistIdx = 0;
    playlistMode = true;
    curArticle = flt[0];
    curArticleIdx = state.articles.indexOf(curArticle);
    artSentIdx = 0;
    switchMode('reader');
    readerPlaying = true;
    readerStep();
}

function stopPlaylist() {
    playlistMode = false;
    stopReaderPlay();
    renderReader();
}

// ============================================================
// ARTICLE WORK MODES (copy/easy/dictation for articles)
// ============================================================
function renderArticleWork() {
    if (!curArticle) return;
    const s = getArtSent();
    if (!s) return;
    const tgt = getArtTarget();
    const mx = getS().copyArt;
    const t = curArticle.sentences.length;
    const pct = Math.round((artSentIdx + 1) / t * 100);

    const titleEl = document.getElementById('emp-artPageTitle');
    if (titleEl) titleEl.textContent = '📄 ' + curArticle.title;
    const progEl = document.getElementById('emp-artProgress');
    if (progEl) progEl.innerHTML = `<span>${artSentIdx+1}/${t} (${pct}%)</span>`;
    const roundEl = document.getElementById('emp-artRound');
    if (roundEl) roundEl.innerHTML = renderDots(artRound, mx);

    const body = document.getElementById('emp-artBody');
    if (!body) return;

    if (artSubMode === 'artCopy') {
        body.innerHTML = `
            <div class="emp-ref-box">
                <div class="emp-ref-label">📌 请抄写</div>
                <div class="emp-ref-text" style="font-size:${tgt.length > 15 ? '1rem' : '1.5rem'}">${renderClickableEN(tgt)}</div>
                <div class="emp-ref-detail">${eH((s.cn || '').replace(/\|/g, ''))}</div>
            </div>
            <div class="emp-input-box" id="emp-artIB"><span class="emp-cursor"></span></div>
            <div class="emp-answer" id="emp-artAns"></div>`;
        renderCopyInput('emp-artIB');
    } else if (artSubMode === 'artEasy') {
        body.innerHTML = `
            <div class="emp-ref-box">
                <div class="emp-ref-label">📌 简易抄写</div>
                <div id="emp-artSeg" class="emp-segments"></div>
            </div>
            <div class="emp-input-box" id="emp-artIB"><span class="emp-cursor"></span></div>
            <div class="emp-answer" id="emp-artAns"></div>`;
        renderEasySegments(s.de, s.cn || '', 'emp-artSeg', copyInput.length);
        renderCopyInput('emp-artIB');
    } else if (artSubMode === 'artDict') {
        body.innerHTML = `
            <div class="emp-ref-box">
                <div class="emp-ref-label">🔊 听后输入</div>
                <div class="emp-dict-hidden" id="emp-artDH">${artDictHint > 0 ? eH(tgt.substring(0, artDictHint)) + '…' : '???'}</div>
                <div class="emp-dict-clue">${eH((s.cn || '').replace(/\|/g, ''))}</div>
                <button class="emp-dict-play" id="emp-artDP">🔊 Play</button>
            </div>
            <div class="emp-input-box" id="emp-artIB"><span class="emp-cursor"></span></div>
            <div class="emp-answer" id="emp-artAns"></div>`;
        renderCopyInput('emp-artIB');
        const dp = document.getElementById('emp-artDP');
        if (dp) dp.onclick = () => tts.speak(tgt, 'en-US', getS().deRate);
    }
    renderInputStats('art', 'emp-artStats');
}

function checkArtEasyChar() {
    if (!curArticle) return;
    const tgt = getArtTarget();
    const li = copyInput.length - 1;
    if (li < 0) return;
    const st = inputSessionData.art;
    st.total++; state.stats.total++;
    if (copyInput[li] === tgt[li]) {
        st.correct++; st.streak++; state.stats.correct++;
        if (copyInput === tgt) {
            const ib = document.getElementById('emp-artIB');
            if (ib) ib.classList.add('emp-correct');
            artAdvance();
            setTimeout(() => {
                if (ib) ib.classList.remove('emp-correct');
                copyInput = '';
                renderArticleWork();
            }, 600);
        }
    } else {
        st.streak = 0;
        copyInput = copyInput.slice(0, -1);
        const ib = document.getElementById('emp-artIB');
        if (ib) { ib.classList.add('emp-shake'); setTimeout(() => ib.classList.remove('emp-shake'), 400); }
    }
    renderInputStats('art', 'emp-artStats');
}

function artAdvance() {
    artRound++;
    if (artRound > getS().copyArt) {
        artSentIdx++;
        artRound = 1;
        if (artSentIdx >= curArticle.sentences.length) {
            artSentIdx = 0;
            empToast('🎉!');
        }
        recordToday();
    }
}

function confirmArtCopy() {
    if (!curArticle) return;
    const tgt = getArtTarget();
    const s = inputSessionData.art;
    s.total++; state.stats.total++;
    if (copyInput === tgt) {
        s.correct++; s.streak++; state.stats.correct++;
        const ib = document.getElementById('emp-artIB');
        if (ib) ib.classList.add('emp-correct');
        artAdvance();
        setTimeout(() => { copyInput = ''; renderArticleWork(); }, 600);
    } else {
        s.streak = 0;
        const ib = document.getElementById('emp-artIB');
        if (ib) { ib.classList.add('emp-wrong', 'emp-shake'); setTimeout(() => ib.classList.remove('emp-wrong', 'emp-shake'), 500); }
        const ans = document.getElementById('emp-artAns');
        if (ans) { ans.className = 'emp-answer emp-show emp-ng'; ans.textContent = '❌ ' + tgt; }
    }
    renderInputStats('art', 'emp-artStats');
}

function confirmArtDict() {
    if (!curArticle) return;
    const tgt = getArtTarget();
    const s = inputSessionData.art;
    s.total++; state.stats.total++;
    if (copyInput === tgt) {
        s.correct++; s.streak++; state.stats.correct++;
        artAdvance();
        setTimeout(() => { copyInput = ''; artDictHint = 0; renderArticleWork(); }, 1000);
    } else {
        s.streak = 0;
        const ib = document.getElementById('emp-artIB');
        if (ib) { ib.classList.add('emp-wrong', 'emp-shake'); setTimeout(() => ib.classList.remove('emp-wrong', 'emp-shake'), 500); }
        const ans = document.getElementById('emp-artAns');
        if (ans) { ans.className = 'emp-answer emp-show emp-ng'; ans.textContent = '❌ ' + tgt; }
    }
    renderInputStats('art', 'emp-artStats');
}

// ============================================================
// ARTICLE AI PROCESSING
// ============================================================
async function aiProcessArticle(artIdx) {
    const art = state.articles[artIdx];
    if (!art) return;
    const needFix = [];
    const needFixIdx = [];
    art.sentences.forEach((s, i) => {
        const hasDE = s.de && (s.de.match(/[a-zA-Z]/g) || []).length >= 2;
        const hasCN = s.cn && hasChinese(s.cn);
        const hasWW = s.ww && isWWValid(s.ww);
        if (!hasDE || !hasCN || !hasWW) {
            const src = (s.de || s.cn || '').replace(/\|/g, '');
            if (src.trim()) { needFix.push(src); needFixIdx.push(i); }
        }
    });
    if (!needFix.length) { empToast('✅ 已完整'); return; }

    empToast('✨ AI处理 ' + needFix.length + ' 句...');
    const lang = needFix.some(s => (s.match(/[a-zA-Z]/g) || []).length >= 3) ? 'en' : 'cn';

    const sys = lang === 'en'
        ? '你是翻译引擎。将每个英语句子翻译成中文并逐词标注。\n严格3行格式：\n1行:原英文\n2行:中文翻译\n3行:逐词标注 如 The(这个) cat(猫) sat(坐)\n序号开头如1. 句间空行'
        : '你是翻译引擎。将每个中文句子翻译成英文并逐词标注。\n严格3行格式：\n1行:英语翻译\n2行:原中文\n3行:逐词标注\n序号开头如1. 句间空行';

    const BS = 10;
    let done = 0;
    for (let bi = 0; bi < needFix.length; bi += BS) {
        const batch = needFix.slice(bi, Math.min(bi + BS, needFix.length));
        const prompt = batch.map((s, j) => (j + 1) + '. ' + s).join('\n');
        const reply = await callLLMWithRetry(sys, prompt, 0.1, 8000, 2);
        if (reply) {
            const blocks = reply.split(/\n\s*\n/).filter(b => b.trim());
            blocks.forEach((block, bIdx) => {
                const idx = bi + bIdx;
                if (idx >= needFixIdx.length) return;
                const lines = block.split('\n').map(l => l.replace(/^\d+[\.\uff0e\)]\s*/, '').trim()).filter(l => l);
                if (lines.length >= 2) {
                    let de = lines[0], cn = lines[1], ww = lines.length >= 3 ? lines[2] : '';
                    const si = needFixIdx[idx];
                    if (si !== undefined && art.sentences[si]) {
                        if (de && (de.match(/[a-zA-Z]/g) || []).length >= 2) art.sentences[si].de = de;
                        if (cn && hasChinese(cn)) art.sentences[si].cn = cn;
                        if (ww && isWWValid(ww)) art.sentences[si].ww = ww;
                    }
                }
            });
        }
        done += batch.length;
        empToast(`AI: ${done}/${needFix.length}`);
        saveState();
        if (bi + BS < needFix.length) await new Promise(r => setTimeout(r, 1500));
    }
    forceSaveState();
    renderArticleList();
    if (curArticle === art) renderReader();
    empToast('✅ AI处理完成');
}

// ============================================================
// PHONICS
// ============================================================
const PHONICS = [
    { title: 'Alphabet', items: 'A,Apple|B,Boy|C,Cat|D,Dog|E,Egg|F,Fish|G,Go|H,Hat|I,Ice|J,Jam|K,Kite|L,Lamp|M,Map|N,Net|O,Orange|P,Pen|Q,Queen|R,Red|S,Sun|T,Top|U,Up|V,Van|W,Water|X,Box|Y,Yes|Z,Zoo'.split('|').map(s => { const [ch,n] = s.split(','); return { ch, n }; }) },
    { title: 'Vowels', items: 'æ,cat|ɛ,bed|ɪ,sit|ɒ,hot|ʌ,cup|iː,see|ɑː,car|uː,too'.split('|').map(s => { const [ch,n] = s.split(','); return { ch, n }; }) },
    { title: 'Consonants', items: 'θ,think|ð,this|ʃ,she|ʒ,vision|tʃ,church|dʒ,judge|ŋ,sing'.split('|').map(s => { const [ch,n] = s.split(','); return { ch, n }; }) },
    { title: 'Numbers', items: '0,zero|1,one|2,two|3,three|4,four|5,five|6,six|7,seven|8,eight|9,nine|10,ten'.split('|').map(s => { const [ch,n] = s.split(','); return { ch, n }; }) },
];

function renderPhonics() {
    const c = document.getElementById('emp-phonicsBody');
    if (!c) return;
    let h = '';
    PHONICS.forEach(sec => {
        h += `<div class="emp-ph-section"><h4>${eH(sec.title)}</h4><div class="emp-ph-grid">`;
        sec.items.forEach(it => {
            h += `<div class="emp-ph-card" data-speak="${eA(it.n || it.ch)}"><div class="emp-ph-char">${eH(it.ch)}</div><div class="emp-ph-name">${eH(it.n)}</div></div>`;
        });
        h += '</div></div>';
    });
    c.innerHTML = h;
}

// ============================================================
// AI TUTOR
// ============================================================
function getActiveConv() {
    return (state.kiConversations || []).find(c => c.id === state.kiActiveConvId) || null;
}

function createNewConv() {
    const id = Date.now().toString(36);
    const conv = { id, title: '新对话', messages: [], created: Date.now() };
    state.kiConversations.unshift(conv);
    state.kiActiveConvId = id;
    saveState();
    renderKIHistory();
    renderKI();
    return conv;
}

function renderKIHistory() {
    const el = document.getElementById('emp-kiHistoryList');
    if (!el) return;
    if (!state.kiConversations.length) {
        el.innerHTML = '<div class="emp-empty-sm">无对话记录</div>';
        return;
    }
    el.innerHTML = state.kiConversations.map(c =>
        `<div class="emp-ki-hist-item${c.id === state.kiActiveConvId ? ' emp-active-conv' : ''}" data-convid="${c.id}">
            <span class="emp-kh-title">${eH(c.title)}</span>
            <span class="emp-kh-meta">${c.messages.length}条</span>
            <button class="emp-small-del" data-convdel="${c.id}">×</button>
        </div>`
    ).join('');
}

function renderKI() {
    const el = document.getElementById('emp-kiMessages');
    if (!el) return;
    const conv = getActiveConv();
    let h = `<div class="emp-ki-msg emp-assistant">${renderAIText('Hello! Click any English word to hear it and see the translation.')}</div>`;
    if (conv) {
        conv.messages.forEach(m => {
            if (m.role === 'user') {
                h += `<div class="emp-ki-msg emp-user">${eH(m.content)}</div>`;
            } else {
                h += `<div class="emp-ki-msg emp-assistant">${renderAIText(m.content)}</div>`;
            }
        });
    }
    el.innerHTML = h;
    el.scrollTop = el.scrollHeight;
}

async function sendKI() {
    const input = document.getElementById('emp-kiInput');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;

    let conv = getActiveConv();
    if (!conv) conv = createNewConv();

    conv.messages.push({ role: 'user', content: text });
    if (conv.messages.filter(m => m.role === 'user').length === 1) {
        conv.title = text.substring(0, 25);
    }
    input.value = '';
    saveState();
    renderKI();
    renderKIHistory();

    const sys = '你是英语对话伙伴。每次回复输出每个英语句子后紧跟中文翻译和逐词解析。保持对话自然。';
    const msgs = conv.messages.slice(-12).map(m => m.role + ': ' + m.content).join('\n');
    const result = await callLLMWithRetry(sys, msgs, 0.7, 4000, 1);
    conv.messages.push({ role: 'assistant', content: result || '⚠️ API调用失败' });
    saveState();
    renderKI();
    renderKIHistory();
}

// ============================================================
// MODE SWITCHING
// ============================================================
function switchMode(mode) {
    state.mode = mode;
    document.querySelectorAll('.emp-mode-page').forEach(p => p.classList.remove('emp-active'));
    const map = {
        browse: 'emp-browsePage', copy: 'emp-copyPage', easyCopy: 'emp-easyCopyPage',
        dictation: 'emp-dictPage', reader: 'emp-readerPage', article: 'emp-articlePage',
        ki: 'emp-kiPage', phonics: 'emp-phonicsPage',
    };
    const pg = document.getElementById(map[mode]);
    if (pg) pg.classList.add('emp-active');

    document.querySelectorAll('#emp-modeGroup .emp-mode-btn').forEach(b =>
        b.classList.toggle('emp-active', b.dataset.mode === mode));

    if (isPlaying) stopAutoPlay();
    stopReaderPlay();
    tts.cancel();
    copyInput = ''; copyRound = 1; copyPhase = 'word'; dictHintCount = 0; artDictHint = 0;
    updateProgress();

    const modeLabel = document.getElementById('emp-modeLabel');
    if (modeLabel) {
        modeLabel.textContent = {
            browse:'浏览', copy:'抄写', easyCopy:'简易', dictation:'听写',
            reader:'阅读', article:'文章', ki:'AI', phonics:'发音'
        }[mode] || '';
    }

    if (mode === 'browse') renderBrowse();
    else if (mode === 'copy') { renderKeyboard('copy'); renderCopy(); }
    else if (mode === 'easyCopy') { renderKeyboard('easy'); renderEasy(); }
    else if (mode === 'dictation') { renderKeyboard('dict'); renderDict(); }
    else if (mode === 'reader') renderReader();
    else if (mode === 'article') { renderKeyboard('art'); renderArticleWork(); }
    else if (mode === 'ki') renderKI();
    else if (mode === 'phonics') renderPhonics();
}

function startArticle(idx) {
    curArticle = state.articles[idx];
    curArticleIdx = idx;
    artRound = 1;
    copyInput = '';
    artDictHint = 0;

    const posKey = curArticle.title || ('art_' + idx);
    const saved = state.artPositions?.[posKey];
    if (saved && saved.sentIdx >= 0 && saved.sentIdx < curArticle.sentences.length) {
        artSentIdx = saved.sentIdx;
        readerPageNum = saved.pageNum || Math.floor(artSentIdx / READER_PAGE_SIZE);
    } else {
        artSentIdx = 0;
        readerPageNum = 0;
    }

    if (artSubMode === 'reader') switchMode('reader');
    else switchMode('article');
}

// ============================================================
// ARTICLE LIST & LIBRARY LIST RENDERING
// ============================================================
function renderLibList() {
    const el = document.getElementById('emp-libList');
    if (!el) return;
    const libs = getAllLibs();
    if (!libs.length) {
        el.innerHTML = '<div class="emp-empty-sm">暂无 — 请导入词库</div>';
        return;
    }
    el.innerHTML = libs.map(l => {
        const ck = (state.selectedLibs || []).includes(l.id);
        return `<div class="emp-lib-item" data-libid="${l.id}">
            <span class="emp-lib-check${ck ? ' emp-checked' : ''}">✓</span>
            <span class="emp-lib-name">${eH(l.name)}</span>
            <span class="emp-lib-meta">${l.count}</span>
            <button class="emp-small-del" data-impidx="${l.impIdx}">×</button>
        </div>`;
    }).join('');
}

function renderArticleList() {
    const flt = state.articles.filter(a => artCatFilter === '全部' || a.cat === artCatFilter);
    const el = document.getElementById('emp-artList');
    if (!el) return;
    if (!flt.length) {
        el.innerHTML = '<div class="emp-empty-sm">暂无文章</div>';
        return;
    }
    el.innerHTML = flt.map(a => {
        const ri = state.articles.indexOf(a);
        const total = a.sentences.length;
        const complete = a.sentences.filter(s => {
            return s.de && (s.de.match(/[a-zA-Z]/g) || []).length >= 2
                && s.cn && hasChinese(s.cn)
                && s.ww && isWWValid(s.ww);
        }).length;
        const metaColor = complete >= total ? 'var(--SmartThemeQuoteColor, #2e7d32)' : 'inherit';
        const needFix = complete < total;
        return `<div class="emp-art-item" data-artidx="${ri}">
            <span class="emp-art-title">${eH(a.title)}</span>
            <span class="emp-art-meta" style="color:${metaColor}">${complete >= total ? total + '句' : complete + '/' + total}</span>
            ${needFix ? `<button class="emp-small-del" data-artfix="${ri}" title="AI补全" style="color:#2563eb">🔄</button>` : ''}
            <button class="emp-small-del" data-artdelidx="${ri}">×</button>
        </div>`;
    }).join('');

    // Category filter
    const cats = ['全部'];
    state.articles.forEach(a => { if (a.cat && !cats.includes(a.cat)) cats.push(a.cat); });
    const cf = document.getElementById('emp-catFilter');
    if (cf) {
        cf.innerHTML = cats.map(c =>
            `<button class="emp-cat-btn${c === artCatFilter ? ' emp-active' : ''}" data-cat="${eA(c)}">${eH(c)}</button>`
        ).join('');
    }
}

// ============================================================
// PHYSICAL KEYBOARD HANDLER
// ============================================================
function handlePhysicalKey(e) {
    if (!panelOpen) return;
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    const mode = state.mode;
    if (mode === 'browse') {
        if (e.code === 'Space') { e.preventDefault(); toggleAutoPlay(); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); nav(-1); }
        if (e.key === 'ArrowRight') { e.preventDefault(); nav(1); }
        return;
    }
    if (mode === 'reader') {
        if (e.code === 'Space') { e.preventDefault(); toggleReaderPlay(); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); readerNav(-1); }
        if (e.key === 'ArrowRight') { e.preventDefault(); readerNav(1); }
        return;
    }
    if (mode === 'ki' || mode === 'phonics') return;

    const modeMap = { copy: 'copy', easyCopy: 'easy', dictation: 'dict', article: 'art' };
    const mk = modeMap[mode];
    if (!mk) return;

    if (e.key === 'Backspace') { e.preventDefault(); onBackspace(mk); return; }
    if (e.key === 'Escape') { e.preventDefault(); onClear(mk); return; }
    if (e.key === 'Enter') {
        e.preventDefault();
        if (mode === 'copy') confirmCopy();
        else if (mode === 'dictation') confirmDict();
        else if (mode === 'article') {
            if (artSubMode === 'artCopy') confirmArtCopy();
            else if (artSubMode === 'artDict') confirmArtDict();
        }
        return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        onKeyPress(e.key, mk);
    }
}

// ============================================================
// BUILD PANEL HTML
// ============================================================
function buildPanelHTML() {
    return `
<div id="emp-panel" class="emp-panel" style="display:none">
    <div class="emp-header">
        <span class="emp-logo">🇬🇧 EnglishMaster Pro</span>
        <span class="emp-mode-label" id="emp-modeLabel">浏览</span>
        <button class="emp-close-btn" id="emp-closePanel">✕</button>
    </div>

    <div class="emp-layout">
        <!-- SIDEBAR -->
        <div class="emp-sidebar" id="emp-sidebar">
            <div class="emp-stats">
                <div class="emp-stat"><div class="emp-stat-val" id="emp-statToday">0</div><div class="emp-stat-lbl">今日</div></div>
                <div class="emp-stat"><div class="emp-stat-val" id="emp-statStreak">0</div><div class="emp-stat-lbl">连续</div></div>
                <div class="emp-stat"><div class="emp-stat-val" id="emp-statMaster">0</div><div class="emp-stat-lbl">掌握</div></div>
                <div class="emp-stat"><div class="emp-stat-val" id="emp-statAcc">0%</div><div class="emp-stat-lbl">正确率</div></div>
            </div>

            <div class="emp-tabs">
                <button class="emp-tab emp-active" data-tab="learn">Learn</button>
                <button class="emp-tab" data-tab="article">Texts</button>
                <button class="emp-tab" data-tab="library">Vocab</button>
                <button class="emp-tab" data-tab="phonics">Sound</button>
                <button class="emp-tab" data-tab="ki">AI</button>
                <button class="emp-tab" data-tab="settings">⚙️</button>
            </div>

            <div class="emp-sidebar-content">
                <!-- Learn Tab -->
                <div class="emp-sb-page emp-active" id="emp-tab-learn">
                    <div class="emp-section-title">词库选择</div>
                    <div class="emp-lib-list" id="emp-libList"></div>
                    <div class="emp-btn-row">
                        <button class="emp-btn emp-btn-sm" id="emp-btnSelAll">全选</button>
                        <button class="emp-btn emp-btn-sm" id="emp-btnSelNone">清空</button>
                        <button class="emp-btn emp-btn-sm emp-btn-primary" id="emp-btnStart">开始学习</button>
                    </div>
                    <div class="emp-section-title">学习模式</div>
                    <div class="emp-mode-group" id="emp-modeGroup">
                        <button class="emp-mode-btn emp-active" data-mode="browse">📖 浏览</button>
                        <button class="emp-mode-btn" data-mode="copy">✏️ 抄写</button>
                        <button class="emp-mode-btn" data-mode="easyCopy">⚡ 简易</button>
                        <button class="emp-mode-btn" data-mode="dictation">🎧 听写</button>
                    </div>
                    <div class="emp-section-title">配音模式</div>
                    <div class="emp-mode-group" id="emp-voiceModeGroup">
                        <button class="emp-mode-btn emp-active" data-vmode="wordCnEn">单词中英</button>
                        <button class="emp-mode-btn" data-vmode="exCnEn">例句中英</button>
                        <button class="emp-mode-btn" data-vmode="allCnEn">全部中英</button>
                        <button class="emp-mode-btn" data-vmode="allEn">全部纯英</button>
                    </div>
                    <div class="emp-section-title">顺序</div>
                    <div class="emp-mode-group" id="emp-orderGroup">
                        <button class="emp-mode-btn emp-active" data-order="seq">顺序</button>
                        <button class="emp-mode-btn" data-order="rand">随机</button>
                    </div>
                    <div class="emp-section-title">当前列表</div>
                    <div class="emp-word-list" id="emp-wordList"></div>
                </div>

                <!-- Article Tab -->
                <div class="emp-sb-page" id="emp-tab-article">
                    <div class="emp-section-title">导入文章</div>
                    <div class="emp-info-box">每2行: 英语+中文<br>或仅粘贴英语/中文 → AI翻译</div>
                    <input class="emp-text-input" id="emp-artTitle" placeholder="文章标题">
                    <input class="emp-text-input" id="emp-artCat" placeholder="分类 (默认)" value="默认" style="margin-top:4px">
                    <textarea class="emp-text-input emp-textarea" id="emp-artText" placeholder="粘贴文章内容..."></textarea>
                    <div class="emp-btn-row">
                        <button class="emp-btn emp-btn-sm emp-btn-primary" id="emp-btnArtImport">📥 导入</button>
                        <button class="emp-btn emp-btn-sm" id="emp-btnArtAI">✨ AI补全</button>
                    </div>
                    <div class="emp-section-title">阅读模式</div>
                    <div class="emp-mode-group" id="emp-artModeGroup">
                        <button class="emp-mode-btn emp-active" data-artmode="reader">📖 阅读</button>
                        <button class="emp-mode-btn" data-artmode="artCopy">✏️ 抄写</button>
                        <button class="emp-mode-btn" data-artmode="artEasy">⚡ 简易</button>
                        <button class="emp-mode-btn" data-artmode="artDict">🎧 听写</button>
                    </div>
                    <div class="emp-section-title">文章列表</div>
                    <div class="emp-cat-filter" id="emp-catFilter"></div>
                    <div class="emp-art-list" id="emp-artList"></div>
                    <div class="emp-btn-row">
                        <button class="emp-btn emp-btn-sm" id="emp-btnPlayAll">▶️ 播放全部</button>
                        <button class="emp-btn emp-btn-sm" id="emp-btnStopPL">⏹ 停止</button>
                    </div>
                </div>

                <!-- Library Tab -->
                <div class="emp-sb-page" id="emp-tab-library">
                    <div class="emp-section-title">导入词库</div>
                    <div class="emp-info-box">每行: 英语,变化,中文,例句,例句中文,语法</div>
                    <input class="emp-text-input" id="emp-libName" placeholder="词库名称">
                    <textarea class="emp-text-input emp-textarea" id="emp-libText" placeholder="粘贴数据..."></textarea>
                    <div class="emp-btn-row">
                        <button class="emp-btn emp-btn-sm emp-btn-primary" id="emp-btnLibImport">导入</button>
                    </div>
                    <div class="emp-section-title">数据管理</div>
                    <div class="emp-btn-row">
                        <button class="emp-btn emp-btn-sm" id="emp-btnExport">💾 导出</button>
                        <button class="emp-btn emp-btn-sm" id="emp-btnImport">📥 导入</button>
                    </div>
                    <input type="file" id="emp-importFile" accept=".json" style="display:none">
                    <button class="emp-btn emp-btn-danger" id="emp-btnReset" style="margin-top:12px;width:100%">🗑️ 重置数据</button>
                </div>

                <!-- Phonics Tab -->
                <div class="emp-sb-page" id="emp-tab-phonics">
                    <div class="emp-section-title">发音学习</div>
                    <button class="emp-btn emp-btn-primary" id="emp-btnOpenPhonics" style="width:100%">🔤 打开发音页面</button>
                </div>

                <!-- AI Tab -->
                <div class="emp-sb-page" id="emp-tab-ki">
                    <div class="emp-section-title">AI-Tutor</div>
                    <div class="emp-info-box">与AI英语对话。使用SillyTavern配置的API。</div>
                    <button class="emp-btn emp-btn-primary" id="emp-btnOpenKI" style="width:100%;margin-bottom:8px">🤖 打开AI对话</button>
                    <div class="emp-section-title">对话历史</div>
                    <div class="emp-ki-hist" id="emp-kiHistoryList"></div>
                </div>

                <!-- Settings Tab -->
                <div class="emp-sb-page" id="emp-tab-settings">
                    <div class="emp-section-title">语音设置</div>
                    <div class="emp-setting">
                        <span>英语语速</span>
                        <input type="range" id="emp-setDeRate" min="0.5" max="3" step="0.1" value="1">
                        <span id="emp-valDeRate">1.0x</span>
                    </div>
                    <div class="emp-setting">
                        <span>中文语速</span>
                        <input type="range" id="emp-setZhRate" min="0.5" max="3" step="0.1" value="1">
                        <span id="emp-valZhRate">1.0x</span>
                    </div>
                    <div class="emp-setting">
                        <span>自动播放</span>
                        <button class="emp-toggle emp-on" id="emp-togAutoSpeak"></button>
                    </div>
                    <div class="emp-setting">
                        <span>中文配音</span>
                        <button class="emp-toggle emp-on" id="emp-togVoiceAll"></button>
                    </div>
                    <div class="emp-section-title">抄写设置</div>
                    <div class="emp-setting">
                        <span>单词次数</span>
                        <input type="number" id="emp-setCopyWord" min="1" max="10" value="3" class="emp-num-input">
                    </div>
                    <div class="emp-setting">
                        <span>例句次数</span>
                        <input type="number" id="emp-setCopyEx" min="1" max="10" value="2" class="emp-num-input">
                    </div>
                    <div class="emp-setting">
                        <span>文章次数</span>
                        <input type="number" id="emp-setCopyArt" min="1" max="10" value="2" class="emp-num-input">
                    </div>
                    <div class="emp-section-title">显示设置</div>
                    <div class="emp-setting">
                        <span>词形变化</span>
                        <button class="emp-toggle emp-on" id="emp-togForms"></button>
                    </div>
                    <div class="emp-setting">
                        <span>例句</span>
                        <button class="emp-toggle emp-on" id="emp-togExample"></button>
                    </div>
                    <div class="emp-setting">
                        <span>跳过已掌握</span>
                        <button class="emp-toggle emp-on" id="emp-togSkipMaster"></button>
                    </div>
                    <div class="emp-btn-row">
                        <button class="emp-btn emp-btn-sm" id="emp-btnTestEN">🔊 测试英语</button>
                        <button class="emp-btn emp-btn-sm" id="emp-btnTestZH">🔊 测试中文</button>
                    </div>
                </div>
            </div>
        </div>

        <!-- MAIN AREA -->
        <div class="emp-main">
            <div class="emp-main-header">
                <button class="emp-hamburger" id="emp-btnMenu">☰</button>
                <div class="emp-progress">
                    <span id="emp-progressText">0/0</span>
                    <div class="emp-progress-bar"><div class="emp-progress-fill" id="emp-progressFill"></div></div>
                </div>
            </div>

            <!-- Browse Page -->
            <div class="emp-mode-page emp-active" id="emp-browsePage">
                <div class="emp-card" id="emp-browseCard">
                    <div class="emp-card-header">
                        <span class="emp-card-type" id="emp-browseType">-</span>
                        <div style="flex:1"></div>
                        <button class="emp-icon-btn" id="emp-btnBrSpeak">🔊</button>
                        <span class="emp-mastery-badge emp-m-new" id="emp-browseMastery">New</span>
                    </div>
                    <div class="emp-card-body">
                        <div class="emp-word-main" id="emp-browseMain">-</div>
                        <div class="emp-word-forms" id="emp-browseForms"></div>
                        <div class="emp-word-meaning" id="emp-browseMeaning"></div>
                        <div class="emp-grammar" id="emp-browseGrammar" style="display:none"></div>
                        <div class="emp-example-box" id="emp-browseExample" style="display:none">
                            <div class="emp-ex-label">📝 Example <button class="emp-icon-btn" id="emp-btnExSpeak">🔊</button></div>
                            <div class="emp-ex-en" id="emp-browseExDe"></div>
                            <div class="emp-ex-cn" id="emp-browseExCn"></div>
                        </div>
                        <div class="emp-ai-section">
                            <div class="emp-ai-btns">
                                <button class="emp-ai-btn" id="emp-btnAiGrammar">✨ 语法</button>
                                <button class="emp-ai-btn" id="emp-btnAiExamples">✨ 例句</button>
                                <button class="emp-ai-btn" id="emp-btnAiCorrect">✨ 造句</button>
                            </div>
                            <div class="emp-ai-input" id="emp-aiInputRow" style="display:none">
                                <input class="emp-text-input" id="emp-aiSentInput" placeholder="用此词造句...">
                                <button class="emp-btn emp-btn-sm emp-btn-primary" id="emp-btnAiSubmit">批改</button>
                            </div>
                            <div class="emp-ai-result" id="emp-aiResult" style="display:none"></div>
                        </div>
                    </div>
                </div>
                <div class="emp-controls" id="emp-browseControls">
                    <div class="emp-ctrl-row">
                        <button class="emp-ctrl-btn emp-bad" id="emp-btnBad">👎</button>
                        <button class="emp-ctrl-btn" id="emp-btnPrev">⏮</button>
                        <button class="emp-ctrl-btn emp-main-ctrl" id="emp-btnPlay">▶️</button>
                        <button class="emp-ctrl-btn" id="emp-btnNext">⏭</button>
                        <button class="emp-ctrl-btn emp-good" id="emp-btnGood">👍</button>
                    </div>
                    <div class="emp-quick-row">
                        <button class="emp-quick-btn" id="emp-btnMaster">✅ 掌握</button>
                        <button class="emp-quick-btn" id="emp-btnShuffle">🔀 打乱</button>
                    </div>
                </div>
                <div class="emp-empty" id="emp-browseEmpty" style="display:none">
                    <b>还没有学习内容</b><br>导入词库或文章后开始
                </div>
            </div>

            <!-- Copy Page -->
            <div class="emp-mode-page" id="emp-copyPage">
                <div class="emp-work-header"><h3>✏️ 抄写</h3></div>
                <div class="emp-tab-bar" id="emp-copyTabs">
                    <button class="emp-tab-btn emp-active" data-phase="word">Word</button>
                    <button class="emp-tab-btn" data-phase="ex">Example</button>
                </div>
                <div class="emp-work-progress" id="emp-copyProgress"></div>
                <div class="emp-work-body">
                    <div class="emp-ref-box">
                        <div class="emp-ref-label">📌 请抄写</div>
                        <div class="emp-ref-text" id="emp-copyRefText">-</div>
                        <div class="emp-ref-detail" id="emp-copyRefDetail"></div>
                    </div>
                    <div class="emp-input-box" id="emp-copyInputBox"><span class="emp-cursor"></span></div>
                    <div class="emp-answer" id="emp-copyAnswer"></div>
                </div>
                <div class="emp-kb" id="emp-copyKB">
                    <div class="emp-kb-tabs" id="emp-copyKBTabs"></div>
                    <div class="emp-kb-grid" id="emp-copyKBGrid"></div>
                    <div class="emp-kb-actions">
                        <button class="emp-btn" data-act="clear" data-mode="copy">清空</button>
                        <button class="emp-btn" data-act="speak" data-mode="copy">🔊</button>
                        <button class="emp-btn emp-btn-primary" data-act="confirm" data-mode="copy">确认 ✓</button>
                    </div>
                </div>
                <div class="emp-input-stats" id="emp-copyStats"></div>
            </div>

            <!-- Easy Copy Page -->
            <div class="emp-mode-page" id="emp-easyCopyPage">
                <div class="emp-work-header"><h3>⚡ 简易抄写</h3></div>
                <div class="emp-tab-bar" id="emp-easyTabs">
                    <button class="emp-tab-btn emp-active" data-phase="word">Word</button>
                    <button class="emp-tab-btn" data-phase="ex">Example</button>
                </div>
                <div class="emp-work-progress" id="emp-easyProgress"></div>
                <div class="emp-work-body">
                    <div class="emp-ref-box">
                        <div class="emp-ref-label">📌 点击单词播放+翻译</div>
                        <div id="emp-easySegments" class="emp-segments"></div>
                    </div>
                    <div class="emp-input-box" id="emp-easyInputBox"><span class="emp-cursor"></span></div>
                    <div class="emp-answer" id="emp-easyAnswer"></div>
                </div>
                <div class="emp-kb" id="emp-easyKB">
                    <div class="emp-kb-tabs" id="emp-easyKBTabs"></div>
                    <div class="emp-kb-grid" id="emp-easyKBGrid"></div>
                    <div class="emp-kb-actions">
                        <button class="emp-btn" data-act="clear" data-mode="easy">清空</button>
                        <button class="emp-btn" data-act="speak" data-mode="easy">🔊</button>
                    </div>
                </div>
                <div class="emp-input-stats" id="emp-easyStats"></div>
            </div>

            <!-- Dictation Page -->
            <div class="emp-mode-page" id="emp-dictPage">
                <div class="emp-work-header"><h3>🎧 听写</h3></div>
                <div class="emp-tab-bar" id="emp-dictTabs">
                    <button class="emp-tab-btn emp-active" data-phase="word">Word</button>
                    <button class="emp-tab-btn" data-phase="ex">Example</button>
                </div>
                <div class="emp-work-progress" id="emp-dictProgress"></div>
                <div class="emp-work-body">
                    <div class="emp-ref-box">
                        <div class="emp-ref-label">🔊 听后输入</div>
                        <div class="emp-dict-hidden" id="emp-dictHidden">???</div>
                        <div class="emp-dict-clue" id="emp-dictClue"></div>
                        <button class="emp-dict-play" id="emp-btnDictPlay">🔊 Play</button>
                    </div>
                    <div class="emp-input-box" id="emp-dictInputBox"><span class="emp-cursor"></span></div>
                    <div class="emp-answer" id="emp-dictAnswer"></div>
                </div>
                <div class="emp-kb" id="emp-dictKB">
                    <div class="emp-kb-tabs" id="emp-dictKBTabs"></div>
                    <div class="emp-kb-grid" id="emp-dictKBGrid"></div>
                    <div class="emp-kb-actions">
                        <button class="emp-btn" data-act="clear" data-mode="dict">清空</button>
                        <button class="emp-btn" data-act="hint" data-mode="dict">💡 提示</button>
                        <button class="emp-btn emp-btn-primary" data-act="confirm" data-mode="dict">确认 ✓</button>
                    </div>
                </div>
                <div class="emp-input-stats" id="emp-dictStats"></div>
            </div>

            <!-- Reader Page -->
            <div class="emp-mode-page" id="emp-readerPage">
                <div class="emp-reader-toolbar" id="emp-readerToolbar">
                    <button class="emp-rtb emp-active" data-rmode="bilingual">中英</button>
                    <button class="emp-rtb" data-rmode="enonly">纯英</button>
                    <span class="emp-rtb-sep"></span>
                    <button class="emp-rtb" data-rmode="singleloop">🔁 循环</button>
                    <span class="emp-rtb-sep"></span>
                    <button class="emp-rtb emp-active" data-raudio="cnenmix">🔊中英</button>
                    <button class="emp-rtb" data-raudio="enonly">🔊纯英</button>
                    <button class="emp-rtb" data-raudio="wwonly">🔊词汇</button>
                    <span class="emp-rtb-sep"></span>
                    <button class="emp-rtb emp-active" data-rshow="en">📝英</button>
                    <button class="emp-rtb emp-active" data-rshow="cn">📝中</button>
                    <button class="emp-rtb emp-active" data-rshow="ww">📝词</button>
                </div>
                <div class="emp-playlist-bar" id="emp-playlistBar" style="display:none">
                    📋 列表播放: <b id="emp-plTitle">—</b> (<span id="emp-plIdx">0</span>/<span id="emp-plTotal">0</span>)
                    <span style="flex:1"></span>
                    <button class="emp-small-del" id="emp-plClose">✕</button>
                </div>
                <div class="emp-reader-prog">
                    <div class="emp-reader-prog-bar"><div class="emp-reader-prog-fill" id="emp-readerProgFill"></div></div>
                    <div class="emp-reader-prog-text"><span id="emp-readerProgText">0/0</span><span id="emp-readerTitle">—</span></div>
                </div>
                <div class="emp-reader-pager" id="emp-readerPager"></div>
                <div class="emp-reader-body" id="emp-readerBody"></div>
                <div class="emp-reader-controls">
                    <span class="emp-rc-speed" id="emp-rcSpeed">1.0x</span>
                    <button class="emp-rc-btn" id="emp-rcPrev">⏮</button>
                    <button class="emp-rc-btn emp-rc-play" id="emp-rcPlay">▶️</button>
                    <button class="emp-rc-btn" id="emp-rcNext">⏭</button>
                    <button class="emp-rc-btn" id="emp-rcLoop">🔁</button>
                </div>
            </div>

            <!-- Article Work Page -->
            <div class="emp-mode-page" id="emp-articlePage">
                <div class="emp-work-header"><h3 id="emp-artPageTitle">📄 Text</h3></div>
                <div id="emp-artProgress"></div>
                <div id="emp-artRound"></div>
                <div class="emp-work-body" id="emp-artBody"></div>
                <div class="emp-kb" id="emp-artKB">
                    <div class="emp-kb-tabs" id="emp-artKBTabs"></div>
                    <div class="emp-kb-grid" id="emp-artKBGrid"></div>
                    <div class="emp-kb-actions">
                        <button class="emp-btn" data-act="clear" data-mode="art">清空</button>
                        <button class="emp-btn" data-act="speak" data-mode="art">🔊</button>
                        <button class="emp-btn emp-btn-primary" data-act="confirm" data-mode="art">确认 ✓</button>
                    </div>
                </div>
                <div class="emp-input-stats" id="emp-artStats"></div>
            </div>

            <!-- Phonics Page -->
            <div class="emp-mode-page" id="emp-phonicsPage">
                <div class="emp-work-header"><h3>🔤 发音练习</h3></div>
                <div class="emp-work-body" id="emp-phonicsBody"></div>
            </div>

            <!-- AI Page -->
            <div class="emp-mode-page" id="emp-kiPage">
                <div class="emp-ki-header">
                    <span style="font-weight:600">🤖 AI-Tutor</span>
                    <button class="emp-btn emp-btn-sm emp-btn-primary" id="emp-btnKiNew">+ 新对话</button>
                </div>
                <div class="emp-ki-messages" id="emp-kiMessages"></div>
                <div class="emp-ki-input-row">
                    <input class="emp-text-input" id="emp-kiInput" placeholder="用英语输入..." autocomplete="off">
                    <button class="emp-btn emp-btn-primary" id="emp-btnKiSend">发送</button>
                </div>
            </div>
        </div>
    </div>
    <div class="emp-toast" id="emp-toast"></div>
</div>`;
}

// ============================================================
// EVENT BINDING
// ============================================================
function initEvents() {
    const panel = document.getElementById('emp-panel');
    if (!panel) return;

    // Close panel
    document.getElementById('emp-closePanel').addEventListener('click', () => {
        panel.style.display = 'none';
        panelOpen = false;
        tts.cancel();
        stopAutoPlay();
        stopReaderPlay();
    });

    // Mobile menu
    document.getElementById('emp-btnMenu')?.addEventListener('click', () => {
        document.getElementById('emp-sidebar')?.classList.toggle('emp-sb-open');
    });

    // Tabs
    panel.querySelectorAll('.emp-tabs .emp-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            panel.querySelectorAll('.emp-tabs .emp-tab').forEach(t => t.classList.remove('emp-active'));
            tab.classList.add('emp-active');
            panel.querySelectorAll('.emp-sb-page').forEach(p => p.classList.remove('emp-active'));
            const page = document.getElementById('emp-tab-' + tab.dataset.tab);
            if (page) page.classList.add('emp-active');
            if (tab.dataset.tab === 'ki') renderKIHistory();
        });
    });

    // Library list clicks
    document.getElementById('emp-libList')?.addEventListener('click', e => {
        const del = e.target.closest('.emp-small-del[data-impidx]');
        if (del) { state.imported.splice(parseInt(del.dataset.impidx), 1); state.selectedLibs = []; forceSaveState(); renderLibList(); return; }
        const item = e.target.closest('.emp-lib-item');
        if (!item) return;
        const id = item.dataset.libid;
        const ii = state.selectedLibs.indexOf(id);
        if (ii >= 0) state.selectedLibs.splice(ii, 1);
        else state.selectedLibs.push(id);
        renderLibList();
    });

    document.getElementById('emp-btnSelAll')?.addEventListener('click', () => { state.selectedLibs = getAllLibs().map(l => l.id); renderLibList(); });
    document.getElementById('emp-btnSelNone')?.addEventListener('click', () => { state.selectedLibs = []; renderLibList(); });
    document.getElementById('emp-btnStart')?.addEventListener('click', () => {
        buildWordList();
        document.getElementById('emp-sidebar')?.classList.remove('emp-sb-open');
    });

    // Mode group
    document.getElementById('emp-modeGroup')?.addEventListener('click', e => {
        const b = e.target.closest('.emp-mode-btn');
        if (b) switchMode(b.dataset.mode);
    });

    // Voice mode
    document.getElementById('emp-voiceModeGroup')?.addEventListener('click', e => {
        const b = e.target.closest('.emp-mode-btn');
        if (b) {
            browseVoiceMode = b.dataset.vmode;
            document.querySelectorAll('#emp-voiceModeGroup .emp-mode-btn').forEach(x =>
                x.classList.toggle('emp-active', x.dataset.vmode === browseVoiceMode));
        }
    });

    // Order group
    document.getElementById('emp-orderGroup')?.addEventListener('click', e => {
        const b = e.target.closest('.emp-mode-btn');
        if (b) {
            state.order = b.dataset.order;
            document.querySelectorAll('#emp-orderGroup .emp-mode-btn').forEach(x =>
                x.classList.toggle('emp-active', x.dataset.order === state.order));
        }
    });

    // Word list
    document.getElementById('emp-wordList')?.addEventListener('click', e => {
        const item = e.target.closest('.emp-word-item');
        if (item) { curIdx = parseInt(item.dataset.widx); onWordChange(); }
    });

    // Browse controls
    document.getElementById('emp-btnPlay')?.addEventListener('click', toggleAutoPlay);
    document.getElementById('emp-btnPrev')?.addEventListener('click', () => nav(-1));
    document.getElementById('emp-btnNext')?.addEventListener('click', () => nav(1));
    document.getElementById('emp-btnBad')?.addEventListener('click', () => {
        if (words.length) { state.mastery[words[curIdx][0]] = Math.max(0, (state.mastery[words[curIdx][0]] || 0) - 1); nav(1); }
    });
    document.getElementById('emp-btnGood')?.addEventListener('click', () => {
        if (words.length) { state.mastery[words[curIdx][0]] = Math.min(10, (state.mastery[words[curIdx][0]] || 0) + 1); nav(1); }
    });
    document.getElementById('emp-btnMaster')?.addEventListener('click', () => {
        if (!words.length) return;
        const ch = words[curIdx][0];
        if (!state.mastered.includes(ch)) state.mastered.push(ch);
        state.mastery[ch] = 10;
        empToast('✅ 已掌握');
        updateStats();
        renderBrowse();
        saveState();
    });
    document.getElementById('emp-btnShuffle')?.addEventListener('click', () => {
        if (words.length) { shuf(words); curIdx = 0; onWordChange(); empToast('🔀'); }
    });
    document.getElementById('emp-btnBrSpeak')?.addEventListener('click', () => {
        if (words.length) tts.speakEnCn(words[curIdx][0], words[curIdx][2], getS().deRate, getS().zhRate, getS().voiceAll);
    });
    document.getElementById('emp-btnExSpeak')?.addEventListener('click', e => {
        e.stopPropagation();
        if (words.length && words[curIdx][3]) tts.speakEnCn(words[curIdx][3].replace(/\|/g, ''), words[curIdx][4], getS().deRate, getS().zhRate, getS().voiceAll);
    });

    // AI buttons (browse)
    document.getElementById('emp-btnAiGrammar')?.addEventListener('click', async () => {
        if (!words.length) return;
        const res = document.getElementById('emp-aiResult');
        res.style.display = 'block'; res.innerHTML = '⏳';
        const reply = await callLLMWithRetry('英语语法教授，详细分析词汇用法。', words[curIdx][0]);
        res.innerHTML = reply ? renderAIText(reply) : '❌ 失败';
    });
    document.getElementById('emp-btnAiExamples')?.addEventListener('click', async () => {
        if (!words.length) return;
        const res = document.getElementById('emp-aiResult');
        res.style.display = 'block'; res.innerHTML = '⏳ ...';
        const reply = await callLLMWithRetry('英语教师，生成5个例句。', words[curIdx][0] + ' (' + words[curIdx][2] + ')');
        res.innerHTML = reply ? renderAIText(reply) : '❌ 失败';
    });
    document.getElementById('emp-btnAiCorrect')?.addEventListener('click', () => {
        const row = document.getElementById('emp-aiInputRow');
        row.style.display = row.style.display === 'none' ? 'flex' : 'none';
    });
    document.getElementById('emp-btnAiSubmit')?.addEventListener('click', async () => {
        const input = document.getElementById('emp-aiSentInput')?.value?.trim();
        if (!input || !words.length) return;
        const res = document.getElementById('emp-aiResult');
        res.style.display = 'block'; res.innerHTML = '⏳ ...';
        const reply = await callLLMWithRetry('英语教师，批改造句，指出错误并给出正确版本。', '用"' + words[curIdx][0] + '"造句: ' + input);
        res.innerHTML = reply ? renderAIText(reply) : '❌ 失败';
    });

    // Copy/Easy/Dict tab clicks
    ['emp-copyTabs', 'emp-easyTabs', 'emp-dictTabs'].forEach(id => {
        document.getElementById(id)?.addEventListener('click', e => {
            const t = e.target.closest('.emp-tab-btn');
            if (!t) return;
            copyPhase = t.dataset.phase;
            copyRound = 1;
            copyInput = '';
            dictHintCount = 0;
            if (id === 'emp-copyTabs') renderCopy();
            else if (id === 'emp-easyTabs') renderEasy();
            else renderDict();
        });
    });

    // Dictation play
    document.getElementById('emp-btnDictPlay')?.addEventListener('click', () => {
        if (words.length) tts.speak(getCopyTarget(), 'en-US', getS().deRate);
    });

    // Article import
    document.getElementById('emp-btnArtImport')?.addEventListener('click', () => {
        const ti = document.getElementById('emp-artTitle')?.value?.trim();
        const tx = document.getElementById('emp-artText')?.value?.trim();
        const cat = document.getElementById('emp-artCat')?.value || '默认';
        if (!ti || !tx) { empToast('请输入标题和内容'); return; }
        const sents = parseArticleText(tx);
        if (!sents.length) { empToast('无有效内容'); return; }
        state.articles.push({ title: ti, cat, sentences: sents });
        forceSaveState();
        renderArticleList();
        document.getElementById('emp-artTitle').value = '';
        document.getElementById('emp-artText').value = '';
        empToast('✅ 导入 ' + sents.length + ' 句');
    });

    document.getElementById('emp-btnArtAI')?.addEventListener('click', async () => {
        if (!state.articles.length) { empToast('无文章'); return; }
        const lastIdx = state.articles.length - 1;
        await aiProcessArticle(lastIdx);
    });

    // Article mode group
    document.getElementById('emp-artModeGroup')?.addEventListener('click', e => {
        const b = e.target.closest('.emp-mode-btn');
        if (b) {
            artSubMode = b.dataset.artmode;
            document.querySelectorAll('#emp-artModeGroup .emp-mode-btn').forEach(x =>
                x.classList.toggle('emp-active', x.dataset.artmode === artSubMode));
        }
    });

    // Article list
    document.getElementById('emp-artList')?.addEventListener('click', e => {
        const fix = e.target.closest('[data-artfix]');
        if (fix) { e.stopPropagation(); aiProcessArticle(parseInt(fix.dataset.artfix)); return; }
        const del = e.target.closest('[data-artdelidx]');
        if (del) { state.articles.splice(parseInt(del.dataset.artdelidx), 1); forceSaveState(); renderArticleList(); return; }
        const item = e.target.closest('.emp-art-item');
        if (item) {
            startArticle(parseInt(item.dataset.artidx));
            document.getElementById('emp-sidebar')?.classList.remove('emp-sb-open');
        }
    });

    // Category filter
    document.getElementById('emp-catFilter')?.addEventListener('click', e => {
        const b = e.target.closest('.emp-cat-btn');
        if (!b) return;
        artCatFilter = b.dataset.cat;
        renderArticleList();
    });

    // Playlist
    document.getElementById('emp-btnPlayAll')?.addEventListener('click', startPlaylist);
    document.getElementById('emp-btnStopPL')?.addEventListener('click', stopPlaylist);
    document.getElementById('emp-plClose')?.addEventListener('click', stopPlaylist);

    // Reader controls
    document.getElementById('emp-rcPlay')?.addEventListener('click', toggleReaderPlay);
    document.getElementById('emp-rcPrev')?.addEventListener('click', () => readerNav(-1));
    document.getElementById('emp-rcNext')?.addEventListener('click', () => readerNav(1));
    document.getElementById('emp-rcLoop')?.addEventListener('click', () => { readerLoopSingle = !readerLoopSingle; renderReader(); });
    document.getElementById('emp-rcSpeed')?.addEventListener('click', () => {
        const speeds = [0.5, 0.7, 0.8, 1.0, 1.2, 1.5, 2.0];
        const ci = speeds.indexOf(getS().deRate);
        setS('deRate', speeds[(ci + 1) % speeds.length]);
        renderReader();
    });

    // Reader toolbar
    document.getElementById('emp-readerToolbar')?.addEventListener('click', e => {
        const b = e.target.closest('.emp-rtb');
        if (!b) return;
        const rm = b.dataset.rmode, ra = b.dataset.raudio, rs = b.dataset.rshow;
        if (rm === 'bilingual') { readerDisplayMode = 'bilingual'; readerShowEN = true; readerShowCN = true; }
        if (rm === 'enonly') { readerDisplayMode = 'enonly'; readerShowEN = true; readerShowCN = false; }
        if (rm === 'singleloop') readerLoopSingle = !readerLoopSingle;
        if (ra === 'cnenmix') readerAudioMode = 'cnenmix';
        if (ra === 'enonly') readerAudioMode = 'enonly';
        if (ra === 'wwonly') readerAudioMode = 'wwonly';
        if (rs === 'en') readerShowEN = !readerShowEN;
        if (rs === 'cn') readerShowCN = !readerShowCN;
        if (rs === 'ww') readerShowWW = !readerShowWW;
        renderReader();
    });

    // Reader pager
    document.getElementById('emp-readerPager')?.addEventListener('click', e => {
        const pgBtn = e.target.closest('[data-pgnum]');
        if (pgBtn) { readerPageNum = parseInt(pgBtn.dataset.pgnum); saveArtPos(); renderReader(); return; }
        const act = e.target.closest('[data-pgact]');
        if (act) {
            const tp = Math.ceil((curArticle?.sentences?.length || 1) / READER_PAGE_SIZE);
            if (act.dataset.pgact === 'prev') readerPageNum = Math.max(0, readerPageNum - 1);
            if (act.dataset.pgact === 'next') readerPageNum = Math.min(tp - 1, readerPageNum + 1);
            saveArtPos();
            renderReader();
        }
    });

    // Reader body sentence click
    document.getElementById('emp-readerBody')?.addEventListener('click', e => {
        const sent = e.target.closest('.emp-reader-sent');
        if (sent && !e.target.closest('.emp-clickable-word')) {
            const idx = parseInt(sent.dataset.sentidx);
            if (!isNaN(idx)) {
                artSentIdx = idx;
                saveArtPos();
                if (!readerPlaying) renderReader();
                const s = curArticle.sentences[idx];
                if (s) tts.speakEnCn((s.de || '').replace(/\|/g, ''), readerAudioMode === 'cnenmix' ? (s.cn || '').replace(/\|/g, '') : '', getS().deRate, getS().zhRate, readerAudioMode === 'cnenmix');
            }
        }
    });

    // Library import
    document.getElementById('emp-btnLibImport')?.addEventListener('click', () => {
        const n = document.getElementById('emp-libName')?.value?.trim();
        const t = document.getElementById('emp-libText')?.value?.trim();
        if (!n || !t) { empToast('请输入'); return; }
        const d = [];
        t.split('\n').forEach(l => {
            const p = l.trim().split(/[,\t]/);
            if (p.length >= 2) d.push([p[0]||'', p[1]||'', p[2]||'', p[3]||'', p[4]||'', p[5]||'']);
        });
        if (!d.length) { empToast('无效'); return; }
        state.imported.push({ name: n, data: d });
        saveState();
        document.getElementById('emp-libName').value = '';
        document.getElementById('emp-libText').value = '';
        renderLibList();
        empToast(d.length + ' 词');
    });

    // Export/Import
    document.getElementById('emp-btnExport')?.addEventListener('click', () => {
        const blob = new Blob([JSON.stringify(state)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `englishmaster_${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        URL.revokeObjectURL(url);
        empToast('已导出');
    });

    document.getElementById('emp-btnImport')?.addEventListener('click', () => document.getElementById('emp-importFile')?.click());
    document.getElementById('emp-importFile')?.addEventListener('change', e => {
        const f = e.target.files[0];
        if (f) {
            const r = new FileReader();
            r.onload = ev => {
                try {
                    const d = JSON.parse(ev.target.result);
                    if (d.imported) state.imported = state.imported.concat(d.imported);
                    if (d.articles) state.articles = state.articles.concat(d.articles);
                    if (d.mastery) Object.assign(state.mastery, d.mastery);
                    if (d.mastered) state.mastered = [...new Set(state.mastered.concat(d.mastered))];
                    forceSaveState();
                    renderLibList();
                    renderArticleList();
                    empToast('已导入');
                } catch (err) { empToast('导入失败'); }
            };
            r.readAsText(f);
        }
        e.target.value = '';
    });

    document.getElementById('emp-btnReset')?.addEventListener('click', () => {
        if (!confirm('确认重置所有数据？')) return;
        localStorage.removeItem(STORAGE_KEY);
        state = {defaultState };
        renderLibList();
        renderArticleList();
        words = [];
        curIdx = 0;
        onWordChange();
        updateStats();
        empToast('已重置');
    });

    // Phonics
    document.getElementById('emp-btnOpenPhonics')?.addEventListener('click', () => {
        switchMode('phonics');
        document.getElementById('emp-sidebar')?.classList.remove('emp-sb-open');
    });

    // AI Tutor
    document.getElementById('emp-btnOpenKI')?.addEventListener('click', () => {
        if (!getActiveConv()) createNewConv();
        switchMode('ki');
        document.getElementById('emp-sidebar')?.classList.remove('emp-sb-open');
    });
    document.getElementById('emp-btnKiNew')?.addEventListener('click', () => { createNewConv(); renderKI(); });
    document.getElementById('emp-btnKiSend')?.addEventListener('click', sendKI);
    document.getElementById('emp-kiInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); sendKI(); } });

    // KI History
    document.getElementById('emp-kiHistoryList')?.addEventListener('click', e => {
        const del = e.target.closest('[data-convdel]');
        if (del) {
            e.stopPropagation();
            state.kiConversations = state.kiConversations.filter(c => c.id !== del.dataset.convdel);
            if (state.kiActiveConvId === del.dataset.convdel) state.kiActiveConvId = state.kiConversations[0]?.id || null;
            forceSaveState();
            renderKIHistory();
            renderKI();
            return;
        }
        const item = e.target.closest('.emp-ki-hist-item');
        if (item) {
            state.kiActiveConvId = item.dataset.convid;
            saveState();
            renderKIHistory();
            renderKI();
            if (state.mode !== 'ki') switchMode('ki');
        }
    });

    // Settings
    document.getElementById('emp-setDeRate')?.addEventListener('input', e => {
        setS('deRate', parseFloat(e.target.value));
        document.getElementById('emp-valDeRate').textContent = getS().deRate.toFixed(1) + 'x';
    });
    document.getElementById('emp-setZhRate')?.addEventListener('input', e => {
        setS('zhRate', parseFloat(e.target.value));
        document.getElementById('emp-valZhRate').textContent = getS().zhRate.toFixed(1) + 'x';
    });

    const toggleSetting = (id, key) => {
        document.getElementById(id)?.addEventListener('click', e => {
            const cur = getS()[key];
            setS(key, !cur);
            e.target.classList.toggle('emp-on', !cur);
        });
    };
    toggleSetting('emp-togAutoSpeak', 'autoSpeak');
    toggleSetting('emp-togVoiceAll', 'voiceAll');
    toggleSetting('emp-togForms', 'showForms');
    toggleSetting('emp-togExample', 'showExample');
    toggleSetting('emp-togSkipMaster', 'skipMastered');

    document.getElementById('emp-setCopyWord')?.addEventListener('change', e => setS('copyWord', Math.max(1, parseInt(e.target.value) || 3)));
    document.getElementById('emp-setCopyEx')?.addEventListener('change', e => setS('copyEx', Math.max(1, parseInt(e.target.value) || 2)));
    document.getElementById('emp-setCopyArt')?.addEventListener('change', e => setS('copyArt', Math.max(1, parseInt(e.target.value) || 2)));

    document.getElementById('emp-btnTestEN')?.addEventListener('click', () => tts.speak('Hello! How are you?', 'en-US', getS().deRate));
    document.getElementById('emp-btnTestZH')?.addEventListener('click', () => tts.speak('你好世界', 'zh-CN', getS().zhRate));

    // Word main click
    document.getElementById('emp-browseMain')?.addEventListener('click', () => {
        if (words.length) {
            tts.speakWord(words[curIdx][0]);
            if (words[curIdx][2]) showTip(document.getElementById('emp-browseMain'), words[curIdx][2]);
        }
    });

    // Global clickable word handler
    panel.addEventListener('click', e => {
        hideTip();
        const cw = e.target.closest('.emp-clickable-word');
        if (cw) { e.preventDefault(); e.stopPropagation(); onClickWord(cw); return; }

        // Keyboard clicks
        const shiftBtn = e.target.closest('[data-act="shift"]');
        if (shiftBtn) { const m = shiftBtn.dataset.mode; kbShift[m] = !kbShift[m]; renderKeyboard(m); return; }

        const key = e.target.closest('.emp-key[data-char]');
        if (key) { onKeyPress(key.dataset.char, key.dataset.mode); return; }

        const kbTab = e.target.closest('.emp-kb-tab[data-kbtype]');
        if (kbTab) { activeKBTab[kbTab.dataset.mode] = kbTab.dataset.kbtype; renderKeyboard(kbTab.dataset.mode); return; }

        const kbAct = e.target.closest('[data-act]');
        if (kbAct) {
            const act = kbAct.dataset.act, m = kbAct.dataset.mode;
            if (act === 'back') onBackspace(m);
            else if (act === 'clear') onClear(m);
            else if (act === 'speak') {
                if (m === 'art' && curArticle) tts.speakEnCn(getArtTarget(), (getArtSent()?.cn || '').replace(/\|/g, ''), getS().deRate, getS().zhRate, true);
                else if (words.length) tts.speak(getCopyTarget(), 'en-US', getS().deRate);
            }
            else if (act === 'hint') {
                if (m === 'dict') { dictHintCount = Math.min(dictHintCount + 1, getCopyTarget().length); renderDict(); }
                else if (m === 'art') { artDictHint = Math.min(artDictHint + 1, getArtTarget().length); renderArticleWork(); }
            }
            else if (act === 'confirm') {
                if (m === 'copy') confirmCopy();
                else if (m === 'dict') confirmDict();
                else if (m === 'art') {
                    if (artSubMode === 'artCopy') confirmArtCopy();
                    else if (artSubMode === 'artDict') confirmArtDict();
                }
            }
            return;
        }

        // Phonics cards
        const pc = e.target.closest('.emp-ph-card');
        if (pc) { pc.classList.add('emp-playing'); setTimeout(() => pc.classList.remove('emp-playing'), 1500); tts.speakWord(pc.dataset.speak); return; }
    });

    // Physical keyboard
    document.addEventListener('keydown', handlePhysicalKey);

    // Auto-save
    setInterval(saveState, 15000);
}

// ============================================================
// APPLY SETTINGS TO UI
// ============================================================
function applySettingsUI() {
    const s = getS();
    const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    const setTxt = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
    const setTog = (id, on) => { const el = document.getElementById(id); if (el) el.classList.toggle('emp-on', on); };

    setVal('emp-setDeRate', s.deRate);
    setTxt('emp-valDeRate', s.deRate.toFixed(1) + 'x');
    setVal('emp-setZhRate', s.zhRate);
    setTxt('emp-valZhRate', s.zhRate.toFixed(1) + 'x');
    setTog('emp-togAutoSpeak', s.autoSpeak);
    setTog('emp-togVoiceAll', s.voiceAll);
    setTog('emp-togForms', s.showForms);
    setTog('emp-togExample', s.showExample);
    setTog('emp-togSkipMaster', s.skipMastered);
    setVal('emp-setCopyWord', s.copyWord);
    setVal('emp-setCopyEx', s.copyEx);
    setVal('emp-setCopyArt', s.copyArt);
}

// ============================================================
// EXTENSION ENTRY POINT
// ============================================================
jQuery(async () => {
    loadSettings();
    loadState();
    checkDate();
    await tts.init();

    // Add button to ST's extensions panel
    const buttonHTML = `
        <div id="emp-extension-block" class="extension_container">
            <div class="extension_toggle">
                <button id="emp-open-btn" class="menu_button">
                    🇬🇧 EnglishMaster Pro
                </button>
            </div>
        </div>`;
    $('#extensions_settings2').append(buttonHTML);

    // Inject panel into body
    $('body').append(buildPanelHTML());

    // Open panel
    $('#emp-open-btn').on('click', () => {
        const panel = document.getElementById('emp-panel');
        if (!panel) return;
        panel.style.display = 'flex';
        panelOpen = true;

        // Refresh UI
        renderLibList();
        renderArticleList();
        updateStats();
        applySettingsUI();
        if (state.selectedLibs.length) buildWordList();
        else { renderWordList(); updateProgress(); onWordChange(); }
        renderKIHistory();
        switchMode(state.mode || 'browse');
    });

    initEvents();

    console.log('[EnglishMaster Pro] Extension loaded successfully.');
});
