(function () {
    'use strict';

    var STORE_KEY = 'cr_data_v5';
    var PAGE_SIZE = 50;

    var state = {
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

    var charDataCache = {};
    var charList = [];
    var selectedChar = '';
    var selectedArt = -1;
    var sentenceIdx = 0;
    var pageIdx = 0;
    var isPlaying = false;
    var playTimeout = null;
    var speechId = 0;
    var voiceList = [];
    var mobileScreen = 'list';
    var playlistOn = false;
    var playlistIdx = 0;
    var playlistArts = [];
    var tooltipEl = null;
    var tooltipTimer = null;
    var keepAliveAudio = null;
    var pendingRender = false;

    function byId(id) {
        return document.getElementById(id);
    }

    function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function escapeAttr(str) {
        if (!str) return '';
        return str.replace(/"/g, '&quot;').replace(/</g, '&lt;');
    }

    function isMobile() {
        return window.innerWidth <= 768;
    }

    function showToast(msg) {
        var t = byId('cr-toast');
        if (!t) {
            t = document.createElement('div');
            t.id = 'cr-toast';
            t.className = 'cr-toast';
            document.body.appendChild(t);
        }
        t.textContent = msg;
        t.classList.add('on');
        clearTimeout(t._timer);
        t._timer = setTimeout(function () {
            t.classList.remove('on');
        }, 2000);
    }

    function loadState() {
        try {
            var raw = localStorage.getItem(STORE_KEY);
            if (raw) {
                var parsed = JSON.parse(raw);
                if (parsed.lastChar !== undefined) state.lastChar = parsed.lastChar;
                if (parsed.positions) state.positions = parsed.positions;
                if (parsed.lastViewed) state.lastViewed = parsed.lastViewed;
                if (parsed.fontSize) state.fontSize = parsed.fontSize;
                if (parsed.playMode) state.playMode = parsed.playMode;
                if (parsed.settings) {
                    var s = parsed.settings;
                    if (s.enRate !== undefined) state.settings.enRate = s.enRate;
                    if (s.cnRate !== undefined) state.settings.cnRate = s.cnRate;
                    if (s.audioMode) state.settings.audioMode = s.audioMode;
                    if (s.showEN !== undefined) state.settings.showEN = s.showEN;
                    if (s.showCN !== undefined) state.settings.showCN = s.showCN;
                    if (s.showWW !== undefined) state.settings.showWW = s.showWW;
                }
            }
        } catch (e) {
            console.log('[CR] load error', e);
        }
    }

    function saveState() {
        try {
            localStorage.setItem(STORE_KEY, JSON.stringify(state));
        } catch (e) {
            console.log('[CR] save error', e);
        }
    }

    function savePosition() {
        if (!selectedChar || selectedArt < 0) return;
        if (!state.positions[selectedChar]) state.positions[selectedChar] = {};
        state.positions[selectedChar].artIdx = selectedArt;
        state.positions[selectedChar].sentIdx = sentenceIdx;
        state.lastChar = selectedChar;
        state.lastViewed[selectedChar] = selectedArt;
        saveState();
    }

    function cleanMessage(raw) {
        var text = raw || '';
        text = text.replace(/<prepare>[\s\S]*?<\/prepare>/gi, '');
        text = text.replace(/<details>[\s\S]*?<\/details>/gi, '');
        text = text.replace(/<br\s*\/?>/gi, '\n');
        text = text.replace(/<[^>]+>/g, '');
        var tmp = document.createElement('textarea');
        tmp.innerHTML = text;
        text = tmp.value;
        return text.trim();
    }

    function hasEnglish(line) {
        var en = (line.match(/[a-zA-Z]/g) || []).length;
        var cn = (line.match(/[\u4e00-\u9fff]/g) || []).length;
        return en > cn && en >= 3;
    }

    function hasChinese(line) {
        return (line.match(/[\u4e00-\u9fff]/g) || []).length >= 2;
    }

    function hasWordAnnotation(line) {
        if (!line) return false;
        var matches = line.match(/[a-zA-Z][a-zA-Z'\u2019\-]*\s*\([^)]*[\u4e00-\u9fff][^)]*\)/g);
        return matches && matches.length >= 2;
    }

    function parseMessages(messages, chatFile) {
        var articles = [];
        var floorNum = 0;

        for (var mi = 0; mi < messages.length; mi++) {
            var msg = messages[mi];
            if (!msg || msg.is_user || msg.is_system) continue;
            if (!msg.mes || !msg.mes.trim()) continue;

            var text = cleanMessage(msg.mes);
            if (!text) continue;

            var rawLines = text.split('\n');
            var lines = [];
            for (var li = 0; li < rawLines.length; li++) {
                var trimmed = rawLines[li].trim();
                if (trimmed) lines.push(trimmed);
            }

            var sentences = [];
            var i = 0;
            while (i < lines.length) {
                if (i + 2 < lines.length && hasEnglish(lines[i]) && hasChinese(lines[i + 1]) && hasWordAnnotation(lines[i + 2])) {
                    sentences.push({
                        en: lines[i],
                        cn: lines[i + 1],
                        ww: lines[i + 2]
                    });
                    i += 3;
                } else if (i + 1 < lines.length && hasEnglish(lines[i]) && hasChinese(lines[i + 1])) {
                    sentences.push({
                        en: lines[i],
                        cn: lines[i + 1],
                        ww: ''
                    });
                    i += 2;
                } else {
                    i++;
                }
            }

            if (sentences.length === 0) continue;

            floorNum++;
            var title = '#' + floorNum;
            for (var pi = mi - 1; pi >= 0; pi--) {
                if (messages[pi] && messages[pi].is_user && messages[pi].mes) {
                    var userText = cleanMessage(messages[pi].mes);
                    if (userText) {
                        title = '#' + floorNum + ' ' + userText.substring(0, 30);
                    }
                    break;
                }
            }

            articles.push({
                title: title,
                sentences: sentences,
                floor: floorNum,
                chatFile: chatFile || 'current'
            });
        }

        return articles;
    }

    function getContext() {
        try {
            var ctx = window.SillyTavern && window.SillyTavern.getContext ? window.SillyTavern.getContext() : null;
            if (!ctx) {
                var impMod = document.querySelector('script[src*="extensions.js"]');
                if (window.getContext) return window.getContext();
            }
            return ctx;
        } catch (e) {
            return null;
        }
    }

    async function fetchPost(urls, body) {
        var endpoints = Array.isArray(urls) ? urls : [urls];
        for (var i = 0; i < endpoints.length; i++) {
            try {
                var response = await fetch(endpoints[i], {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                if (response.ok) {
                    return await response.json();
                }
            } catch (e) {
                continue;
            }
        }
        return null;
    }

    async function loadCharacterData(charName, avatar) {
        if (charDataCache[charName] && charDataCache[charName].loaded) {
            return charDataCache[charName];
        }

        var data = {
            name: charName,
            articles: [],
            loaded: false
        };
        charDataCache[charName] = data;

        var ctx = getContext();

        if (ctx && ctx.name2 === charName && ctx.chat && ctx.chat.length > 0) {
            var currentArts = parseMessages(ctx.chat, 'current');
            for (var ca = 0; ca < currentArts.length; ca++) {
                data.articles.push(currentArts[ca]);
            }
        }

        try {
            var chatFiles = await fetchPost(
                ['/api/characters/chats', '/getallchatsofcharacter'],
                { avatar_url: avatar }
            );

            if (chatFiles && Array.isArray(chatFiles)) {
                var currentFile = '';
                if (ctx && ctx.name2 === charName && ctx.chat_metadata && ctx.chat_metadata.file_name) {
                    currentFile = ctx.chat_metadata.file_name;
                }

                for (var fi = 0; fi < chatFiles.length; fi++) {
                    var fileName = chatFiles[fi].file_name || chatFiles[fi].fileName;
                    if (!fileName) continue;
                    if (currentFile && fileName.indexOf(currentFile) >= 0) continue;

                    try {
                        var chatMsgs = await fetchPost(
                            ['/api/chats/get', '/getchat'],
                            { ch_name: charName, file_name: fileName, avatar_url: avatar }
                        );

                        if (chatMsgs && Array.isArray(chatMsgs)) {
                            var fileArts = parseMessages(chatMsgs, fileName);
                            for (var fa = 0; fa < fileArts.length; fa++) {
                                data.articles.push(fileArts[fa]);
                            }
                        }
                    } catch (e) {
                        continue;
                    }
                }

                for (var ri = 0; ri < data.articles.length; ri++) {
                    data.articles[ri].floor = ri + 1;
                }
            }
        } catch (e) {
            console.log('[CR] scan error', e);
        }

        data.loaded = true;
        return data;
    }

    function getCharacterList() {
        var result = [];
        var ctx = getContext();
        if (!ctx) return result;

        var seen = {};
        var chars = ctx.characters || [];
        for (var i = 0; i < chars.length; i++) {
            var c = chars[i];
            if (c && c.name && !seen[c.name]) {
                seen[c.name] = true;
                result.push({ name: c.name, avatar: c.avatar || '' });
            }
        }
        if (ctx.name2 && !seen[ctx.name2]) {
            result.push({ name: ctx.name2, avatar: '' });
        }

        return result;
    }

    function initVoices() {
        if (!window.speechSynthesis) return;
        var load = function () {
            voiceList = speechSynthesis.getVoices();
        };
        load();
        if (speechSynthesis.onvoiceschanged !== undefined) {
            speechSynthesis.onvoiceschanged = load;
        }
        setTimeout(load, 2000);
    }

    function findVoice(lang) {
        if (!voiceList.length) voiceList = speechSynthesis.getVoices();
        var prefix = lang.split('-')[0];
        var matches = [];
        for (var i = 0; i < voiceList.length; i++) {
            if (voiceList[i].lang === lang || voiceList[i].lang.indexOf(prefix) === 0) {
                matches.push(voiceList[i]);
            }
        }
        for (var j = 0; j < matches.length; j++) {
            if (matches[j].localService) return matches[j];
        }
        return matches[0] || null;
    }

    function speakText(text, lang, rate) {
        return new Promise(function (resolve) {
            if (!window.speechSynthesis || !text || !text.trim()) {
                resolve();
                return;
            }
            var utterance = new SpeechSynthesisUtterance(text.trim());
            utterance.lang = lang;
            utterance.rate = Math.max(0.1, Math.min(5, rate || 1));
            var voice = findVoice(lang);
            if (voice) utterance.voice = voice;

            var finished = false;
            var done = function () {
                if (!finished) {
                    finished = true;
                    clearTimeout(timeout);
                    resolve();
                }
            };
            var timeout = setTimeout(done, Math.max(8000, text.length * 600));
            utterance.onend = done;
            utterance.onerror = done;

            try {
                speechSynthesis.speak(utterance);
            } catch (e) {
                done();
            }
        });
    }

    function cancelSpeech() {
        try {
            speechSynthesis.cancel();
        } catch (e) {}
    }

    function speakWord(word) {
        if (!word) return;
        cancelSpeech();
        var u = new SpeechSynthesisUtterance(word);
        u.lang = 'en-US';
        u.rate = state.settings.enRate;
        var v = findVoice('en-US');
        if (v) u.voice = v;
        try {
            speechSynthesis.speak(u);
        } catch (e) {}
    }

    function stopPlayback() {
        isPlaying = false;
        clearTimeout(playTimeout);
        cancelSpeech();
        speechId++;
        stopKeepAlive();
        updateMediaSession(false);
    }

    function startKeepAlive() {
        if (keepAliveAudio) return;
        try {
            keepAliveAudio = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=');
            keepAliveAudio.loop = true;
            keepAliveAudio.volume = 0.01;
            keepAliveAudio.play().catch(function () {});
        } catch (e) {}
    }

    function stopKeepAlive() {
        if (keepAliveAudio) {
            keepAliveAudio.pause();
            keepAliveAudio = null;
        }
    }

    function updateMediaSession(playing) {
        if (!('mediaSession' in navigator)) return;
        try {
            var art = getCurrentArticle();
            navigator.mediaSession.metadata = new MediaMetadata({
                title: art ? art.title : 'Chat Reader',
                artist: selectedChar || '',
                album: 'English Reading'
            });
            navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
            navigator.mediaSession.setActionHandler('play', function () { togglePlayback(); });
            navigator.mediaSession.setActionHandler('pause', function () { stopPlayback(); scheduleRender(); });
            navigator.mediaSession.setActionHandler('previoustrack', function () { navigateSentence(-1); });
            navigator.mediaSession.setActionHandler('nexttrack', function () { navigateSentence(1); });
        } catch (e) {}
    }

    function cleanWordPunctuation(word) {
        return (word || '')
            .replace(/^[.,!?;:'"()\-\u2013\u00bb\u00ab\[\]{}\/\\]+/, '')
            .replace(/[.,!?;:'"()\-\u2013\u00bb\u00ab\u2026\[\]{}\/\\]+$/, '')
            .trim();
    }

    function renderClickableEnglish(text) {
        if (!text) return '';
        var cleaned = text.replace(/\|/g, '');
        var parts = cleaned.split(/(\s+)/);
        var html = '';
        for (var i = 0; i < parts.length; i++) {
            var part = parts[i];
            if (!part) continue;
            if (/^\s+$/.test(part)) {
                html += ' ';
                continue;
            }
            if (/[a-zA-Z]/.test(part)) {
                var match = part.match(/^([^a-zA-Z]*)([a-zA-Z][a-zA-Z'\u2019\-]*[a-zA-Z]|[a-zA-Z])([^a-zA-Z]*)$/);
                if (match) {
                    html += escapeHtml(match[1]);
                    html += '<span class="cr-word" data-w="' + escapeAttr(cleanWordPunctuation(match[2])) + '">' + escapeHtml(match[2]) + '</span>';
                    html += escapeHtml(match[3]);
                } else {
                    html += '<span class="cr-word" data-w="' + escapeAttr(cleanWordPunctuation(part)) + '">' + escapeHtml(part) + '</span>';
                }
            } else {
                html += escapeHtml(part);
            }
        }
        return html;
    }

    function hideTooltip() {
        if (tooltipEl) {
            tooltipEl.remove();
            tooltipEl = null;
        }
        if (tooltipTimer) {
            clearTimeout(tooltipTimer);
            tooltipTimer = null;
        }
    }

    function showTooltip(element, text) {
        hideTooltip();
        var rect = element.getBoundingClientRect();
        var tip = document.createElement('div');
        tip.className = 'cr-tooltip';
        tip.textContent = text;
        tip.style.left = (rect.left + rect.width / 2) + 'px';
        if (rect.top > 50) {
            tip.style.top = (rect.top - 5) + 'px';
            tip.style.transform = 'translateX(-50%) translateY(-100%)';
        } else {
            tip.style.top = (rect.bottom + 5) + 'px';
            tip.style.transform = 'translateX(-50%)';
        }
        document.body.appendChild(tip);
        requestAnimationFrame(function () {
            var tipRect = tip.getBoundingClientRect();
            if (tipRect.right > window.innerWidth - 4) {
                tip.style.left = (window.innerWidth - tipRect.width / 2 - 4) + 'px';
            }
            if (tipRect.left < 4) {
                tip.style.left = (tipRect.width / 2 + 4) + 'px';
            }
            tip.classList.add('visible');
        });
        tooltipEl = tip;
        tooltipTimer = setTimeout(hideTooltip, 3000);
    }

    function onWordClick(element) {
        var word = cleanWordPunctuation(element.dataset.w || element.textContent);
        if (!word) return;
        element.classList.add('speaking');
        setTimeout(function () {
            element.classList.remove('speaking');
        }, 1000);
        speakWord(word);
        hideTooltip();

        var translation = '';
        var cachedData = charDataCache[selectedChar];
        if (cachedData && selectedArt >= 0 && cachedData.articles[selectedArt]) {
            var sents = cachedData.articles[selectedArt].sentences;
            for (var i = 0; i < sents.length; i++) {
                if (!sents[i].ww) continue;
                var regex = new RegExp(
                    word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\(([^)]+)\\)',
                    'i'
                );
                var found = sents[i].ww.match(regex);
                if (found) {
                    translation = found[1];
                    break;
                }
            }
        }
        showTooltip(element, translation || word);
    }

    function getCurrentArticle() {
        var data = charDataCache[selectedChar];
        if (data && data.articles && data.articles[selectedArt]) {
            return data.articles[selectedArt];
        }
        return null;
    }

    function createPanel() {
        var panel = document.createElement('div');
        panel.id = 'cr-panel';

        panel.innerHTML =
            '<div class="cr-topbar">' +
                '<button class="cr-topbar-back" id="crBack">◀</button>' +
                '<span class="cr-topbar-title" id="crTitle">📖 Chat Reader</span>' +
                '<button class="cr-topbtn" id="crRefresh" title="刷新">♻</button>' +
                '<button class="cr-topbtn" id="crSettings" title="设置">⚙</button>' +
                '<button class="cr-topbtn" id="crClose">✕</button>' +
            '</div>' +
            '<div class="cr-body">' +
                '<div class="cr-sidebar" id="crSidebar">' +
                    '<div class="cr-chartabs" id="crChars"></div>' +
                    '<div class="cr-artlist" id="crArts"><div class="cr-empty">点击角色卡加载文章</div></div>' +
                '</div>' +
                '<div class="cr-main" id="crMain">' +
                    '<div class="cr-view on" id="crViewWelcome">' +
                        '<div class="cr-welcome">' +
                            '<div style="font-size:40px">📖</div>' +
                            '<h3>Chat Article Reader</h3>' +
                            '<p>选择角色卡扫描聊天记录。<br>点击英文单词播放发音。<br>支持连续播放和后台播放。</p>' +
                        '</div>' +
                    '</div>' +
                    '<div class="cr-view" id="crViewReader">' +
                        '<div class="cr-toolbar" id="crToolbar"></div>' +
                        '<div class="cr-optbar" id="crFontBar"></div>' +
                        '<div class="cr-optbar" id="crModeBar"></div>' +
                        '<div class="cr-plbar" id="crPlaylist">' +
                            '<span>📋 <b id="crPlName">—</b></span>' +
                            '<button class="cr-topbtn" id="crPlClose" style="width:22px;height:22px;font-size:10px">✕</button>' +
                        '</div>' +
                        '<div class="cr-progress">' +
                            '<div class="cr-progbar"><div class="cr-progfill" id="crProgFill"></div></div>' +
                            '<div class="cr-progmeta"><span id="crProgIdx">0/0</span><span id="crProgTitle">—</span></div>' +
                        '</div>' +
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
                    '<div class="cr-view" id="crViewSettings">' +
                        '<div class="cr-setbody" id="crSetBody"></div>' +
                    '</div>' +
                '</div>' +
            '</div>';

        document.body.appendChild(panel);
    }

    function addExtensionButton() {
        var addBtn = function () {
            if (byId('cr-ext-btn')) return;

            var targets = [
                document.getElementById('extensionsMenu'),
                document.getElementById('extensions_settings'),
                document.querySelector('#top-settings-holder'),
                document.querySelector('.drawer-content'),
                document.querySelector('#rightSendForm'),
                document.querySelector('#leftSendForm'),
                document.querySelector('#send_form')
            ];

            var container = null;
            for (var i = 0; i < targets.length; i++) {
                if (targets[i]) { container = targets[i]; break; }
            }

            var btn = document.createElement('div');
            btn.id = 'cr-ext-btn';
            btn.title = 'Chat Reader';
            btn.style.cssText = 'cursor:pointer;padding:5px 8px;display:flex;align-items:center;gap:4px;font-size:14px;-webkit-tap-highlight-color:transparent;user-select:none;';
            btn.innerHTML = '<span style="font-size:18px">📖</span><span style="font-size:12px">Reader</span>';

            btn.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                openPanel();
            });

            btn.addEventListener('touchend', function (e) {
                e.preventDefault();
                e.stopPropagation();
                openPanel();
            });

            if (container) {
                if (container.id === 'send_form' || container.id === 'rightSendForm' || container.id === 'leftSendForm') {
                    container.parentNode.insertBefore(btn, container);
                } else {
                    container.appendChild(btn);
                }
            } else {
                btn.style.cssText = 'cursor:pointer;position:fixed;top:50%;right:0;z-index:99990;background:#000;color:#fff;padding:8px 6px;border-radius:8px 0 0 8px;font-size:14px;display:flex;align-items:center;gap:2px;-webkit-tap-highlight-color:transparent;user-select:none;box-shadow:0 2px 8px rgba(0,0,0,.3);';
                btn.innerHTML = '<span style="font-size:16px">📖</span>';
                document.body.appendChild(btn);
            }
        };

        addBtn();
        setTimeout(addBtn, 2000);
        setTimeout(addBtn, 5000);
        setTimeout(addBtn, 10000);
    }

    function openPanel() {
        var panel = byId('cr-panel');
        if (!panel) return;
        if (panel.classList.contains('open')) return;

        panel.classList.add('open');

        if (isMobile()) {
            mobileScreen = 'list';
            var sidebar = byId('crSidebar');
            var main = byId('crMain');
            if (sidebar) sidebar.classList.remove('hide');
            if (main) main.classList.add('hide');
            var back = byId('crBack');
            if (back) back.classList.remove('show');
            var title = byId('crTitle');
            if (title) title.textContent = '📖 Chat Reader';
        } else {
            var sidebar2 = byId('crSidebar');
            var main2 = byId('crMain');
            if (sidebar2) sidebar2.classList.remove('hide');
            if (main2) main2.classList.remove('hide');
        }

        refreshCharList();

        if (state.lastChar && !selectedChar) {
            selectCharacter(state.lastChar);
        }
    }

    function closePanel() {
        var panel = byId('cr-panel');
        if (panel) panel.classList.remove('open');
    }

    function refreshCharList() {
        charList = getCharacterList();
        renderCharTabs();
    }

    function renderCharTabs() {
        var el = byId('crChars');
        if (!el) return;
        if (!charList.length) {
            el.innerHTML = '<span style="color:#aaa;font-size:11px;padding:6px">无角色卡</span>';
            return;
        }
        var html = '';
        for (var i = 0; i < charList.length; i++) {
            var c = charList[i];
            var isOn = c.name === selectedChar;
            html += '<button class="cr-chartab' + (isOn ? ' on' : '') + '" data-name="' + escapeAttr(c.name) + '" data-avatar="' + escapeAttr(c.avatar) + '">' + escapeHtml(c.name) + '</button>';
        }
        el.innerHTML = html;
    }

    async function selectCharacter(name) {
        var charInfo = null;
        for (var i = 0; i < charList.length; i++) {
            if (charList[i].name === name) {
                charInfo = charList[i];
                break;
            }
        }
        if (!charInfo) return;

        selectedChar = name;
        state.lastChar = name;
        saveState();
        renderCharTabs();

        var artList = byId('crArts');
        if (artList) artList.innerHTML = '<div class="cr-empty">⏳ 扫描聊天记录中...</div>';

        var data = await loadCharacterData(name, charInfo.avatar);
        if (selectedChar !== name) return;

        renderArticleList(data.articles);

        if (data.articles.length === 0) {
            if (artList) artList.innerHTML = '<div class="cr-empty">此角色无三行格式内容</div>';
        }

        var savedPos = state.positions[name];
        if (savedPos && savedPos.artIdx >= 0 && savedPos.artIdx < data.articles.length) {
            openArticle(savedPos.artIdx, savedPos.sentIdx || 0);
        }
    }

    function renderArticleList(articles) {
        var el = byId('crArts');
        if (!el) return;

        if (!articles.length) {
            el.innerHTML = '<div class="cr-empty">此角色无三行格式内容</div>';
            return;
        }

        var groups = {};
        var groupOrder = [];
        for (var i = 0; i < articles.length; i++) {
            var groupKey = articles[i].chatFile || 'current';
            if (!groups[groupKey]) {
                groups[groupKey] = [];
                groupOrder.push(groupKey);
            }
            groups[groupKey].push({ article: articles[i], index: i });
        }

        var lastViewedIdx = state.lastViewed[selectedChar];
        var html = '';

        for (var gi = 0; gi < groupOrder.length; gi++) {
            var groupName = groupOrder[gi];
            var items = groups[groupName];

            if (groupOrder.length > 1) {
                var label = groupName === 'current' ? '📍 当前聊天' : '📄 ' + groupName.substring(0, 20);
                html += '<div class="cr-chatlabel">' + escapeHtml(label) + '</div>';
            }

            for (var ii = 0; ii < items.length; ii++) {
                var item = items[ii];
                var isCurrent = item.index === selectedArt;
                var isLastViewed = item.index === lastViewedIdx && !isCurrent;
                var cardClass = 'cr-artcard';
                if (isCurrent) cardClass += ' playing';
                if (isLastViewed) cardClass += ' lastview';

                html += '<div class="' + cardClass + '" data-idx="' + item.index + '">' +
                    '<div class="cr-artnum">' + item.article.floor + '</div>' +
                    '<div class="cr-artinfo">' +
                        '<div class="cr-artname">' + escapeHtml(item.article.title) + '</div>' +
                        '<div class="cr-artmeta">' + item.article.sentences.length + '句</div>' +
                    '</div>' +
                    '<span class="cr-artbadge">' + item.article.sentences.length + '</span>' +
                '</div>';
            }
        }

        html += '<div class="cr-playallwrap"><button class="cr-playallbtn" id="crPlayAll">▶ 连续播放全部 (' + articles.length + '篇)</button></div>';

        el.innerHTML = html;
    }

    function openArticle(artIdx, startSent) {
        var data = charDataCache[selectedChar];
        if (!data || !data.articles[artIdx]) return;

        selectedArt = artIdx;
        sentenceIdx = startSent || 0;
        pageIdx = Math.floor(sentenceIdx / PAGE_SIZE);

        state.lastViewed[selectedChar] = artIdx;
        savePosition();

        switchView('reader');
        scheduleRender();

        if (isMobile()) {
            mobileScreen = 'reader';
            var sidebar = byId('crSidebar');
            var main = byId('crMain');
            if (sidebar) sidebar.classList.add('hide');
            if (main) main.classList.remove('hide');
            var back = byId('crBack');
            if (back) back.classList.add('show');
            var title = byId('crTitle');
            if (title) title.textContent = data.articles[artIdx].title;
        }

        renderArticleList(data.articles);
    }

    function switchView(viewName) {
        var welcome = byId('crViewWelcome');
        var reader = byId('crViewReader');
        var settings = byId('crViewSettings');
        if (welcome) welcome.classList.toggle('on', viewName === 'welcome');
        if (reader) reader.classList.toggle('on', viewName === 'reader');
        if (settings) settings.classList.toggle('on', viewName === 'settings');
    }

    function goBackToList() {
        stopPlayback();
        if (isMobile()) {
            mobileScreen = 'list';
            var sidebar = byId('crSidebar');
            var main = byId('crMain');
            if (sidebar) sidebar.classList.remove('hide');
            if (main) main.classList.add('hide');
            var back = byId('crBack');
            if (back) back.classList.remove('show');
            var title = byId('crTitle');
            if (title) title.textContent = '📖 Chat Reader';
        }
    }

    function scheduleRender() {
        if (pendingRender) return;
        pendingRender = true;
        requestAnimationFrame(function () {
            pendingRender = false;
            doRender();
        });
    }

    function doRender() {
        var article = getCurrentArticle();
        if (!article) return;

        var sentences = article.sentences;
        var totalPages = Math.ceil(sentences.length / PAGE_SIZE);
        var autoPage = Math.floor(sentenceIdx / PAGE_SIZE);

        if (isPlaying && pageIdx !== autoPage) pageIdx = autoPage;
        if (pageIdx >= totalPages) pageIdx = totalPages - 1;
        if (pageIdx < 0) pageIdx = 0;

        var pageStart = pageIdx * PAGE_SIZE;
        var pageEnd = Math.min(pageStart + PAGE_SIZE, sentences.length);

        var progFill = byId('crProgFill');
        if (progFill) progFill.style.width = Math.round((sentenceIdx + 1) / sentences.length * 100) + '%';

        var progIdx = byId('crProgIdx');
        if (progIdx) progIdx.textContent = (sentenceIdx + 1) + '/' + sentences.length;

        var progTitle = byId('crProgTitle');
        if (progTitle) progTitle.textContent = article.title;

        var pager = byId('crPager');
        if (pager) {
            if (totalPages > 1) {
                var pagerHtml = '';
                pagerHtml += '<button class="cr-pgbtn" data-p="0"' + (pageIdx === 0 ? ' disabled' : '') + '>⏮</button>';
                pagerHtml += '<button class="cr-pgbtn" data-p="' + (pageIdx - 1) + '"' + (pageIdx === 0 ? ' disabled' : '') + '>◀</button>';

                var maxBtns = 5;
                var startP = Math.max(0, pageIdx - 2);
                var endP = Math.min(totalPages, startP + maxBtns);
                if (endP - startP < maxBtns) startP = Math.max(0, endP - maxBtns);

                for (var p = startP; p < endP; p++) {
                    pagerHtml += '<button class="cr-pgbtn' + (p === pageIdx ? ' on' : '') + '" data-p="' + p + '">' + (p + 1) + '</button>';
                }

                pagerHtml += '<button class="cr-pgbtn" data-p="' + (pageIdx + 1) + '"' + (pageIdx >= totalPages - 1 ? ' disabled' : '') + '>▶</button>';
                pagerHtml += '<button class="cr-pgbtn" data-p="' + (totalPages - 1) + '"' + (pageIdx >= totalPages - 1 ? ' disabled' : '') + '>⏭</button>';
                pagerHtml += '<span class="cr-pgmeta">' + (pageStart + 1) + '-' + pageEnd + '/' + sentences.length + '</span>';

                pager.innerHTML = pagerHtml;
                pager.classList.add('on');
            } else {
                pager.innerHTML = '';
                pager.classList.remove('on');
            }
        }

        var reader = byId('crReader');
        if (reader) {
            var showEN = state.settings.showEN;
            var showCN = state.settings.showCN;
            var showWW = state.settings.showWW;
            var readerHtml = '';

            for (var si = pageStart; si < pageEnd; si++) {
                var sent = sentences[si];
                var isActive = si === sentenceIdx;
                var isDone = si < sentenceIdx;
                var sentClass = 'cr-sent';
                if (isActive) sentClass += ' active';
                if (isDone) sentClass += ' done';

                var enText = (sent.en || '').replace(/\|/g, '');
                var cnText = (sent.cn || '').replace(/\|/g, '');
                var wwText = (sent.ww || '').replace(/\|/g, '');

                readerHtml += '<div class="' + sentClass + '" data-si="' + si + '">';
                readerHtml += '<span class="cr-sentnum">#' + (si + 1) + '</span>';
                readerHtml += '<div class="cr-en' + (showEN ? '' : ' cr-hidden') + '">' + renderClickableEnglish(enText) + '</div>';
                readerHtml += '<div class="cr-cn' + (showCN ? '' : ' cr-hidden') + '">' + escapeHtml(cnText) + '</div>';
                if (wwText) {
                    readerHtml += '<div class="cr-ww' + (showWW ? '' : ' cr-hidden') + '">' + renderClickableEnglish(wwText) + '</div>';
                }
                readerHtml += '</div>';
            }

            reader.innerHTML = readerHtml;
            reader.className = 'cr-reader fs-' + (state.fontSize || 'm');

            setTimeout(function () {
                var activeEl = reader.querySelector('.active');
                if (activeEl) {
                    activeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }, 50);
        }

        var playBtn = byId('crPlay');
        if (playBtn) {
            playBtn.textContent = isPlaying ? '⏸' : '▶️';
            playBtn.classList.toggle('on', isPlaying);
        }

        var loopBtn = byId('crLoop');
        if (loopBtn) loopBtn.classList.toggle('loopon', state.playMode === 'loop');

        var speedBtn = byId('crSpeed');
        if (speedBtn) speedBtn.textContent = state.settings.enRate.toFixed(1) + 'x';

        var plBar = byId('crPlaylist');
        if (plBar) {
            if (playlistOn) {
                plBar.classList.add('on');
                var plName = byId('crPlName');
                if (plName) plName.textContent = article.title + ' (' + (playlistIdx + 1) + '/' + playlistArts.length + ')';
            } else {
                plBar.classList.remove('on');
            }
        }

        renderToolbar();
        renderFontBar();
        renderModeBar();
    }

    function renderToolbar() {
        var el = byId('crToolbar');
        if (!el) return;
        var s = state.settings;
        el.innerHTML =
            '<button class="cr-tbtn' + (s.audioMode === 'cnenmix' ? ' on' : '') + '" data-am="cnenmix">🔊中英</button>' +
            '<button class="cr-tbtn' + (s.audioMode === 'enonly' ? ' on' : '') + '" data-am="enonly">🔊纯英</button>' +
            '<button class="cr-tbtn' + (s.audioMode === 'wwonly' ? ' on' : '') + '" data-am="wwonly">🔊词汇</button>' +
            '<span class="cr-tsep"></span>' +
            '<button class="cr-tbtn' + (s.showEN ? ' on' : '') + '" data-show="en">英文</button>' +
            '<button class="cr-tbtn' + (s.showCN ? ' on' : '') + '" data-show="cn">中文</button>' +
            '<button class="cr-tbtn' + (s.showWW ? ' on' : '') + '" data-show="ww">词汇</button>';
    }

    function renderFontBar() {
        var el = byId('crFontBar');
        if (!el) return;
        var sizes = [['s', '小'], ['m', '中'], ['l', '大'], ['xl', '特大']];
        var html = '<label>字号:</label>';
        for (var i = 0; i < sizes.length; i++) {
            html += '<button class="cr-optbtn' + (state.fontSize === sizes[i][0] ? ' on' : '') + '" data-fs="' + sizes[i][0] + '">' + sizes[i][1] + '</button>';
        }
        el.innerHTML = html;
    }

    function renderModeBar() {
        var el = byId('crModeBar');
        if (!el) return;
        var modes = [['seq', '顺序'], ['loop', '单篇循环'], ['shuffle', '随机']];
        var html = '<label>播放:</label>';
        for (var i = 0; i < modes.length; i++) {
            html += '<button class="cr-optbtn' + (state.playMode === modes[i][0] ? ' on' : '') + '" data-pm="' + modes[i][0] + '">' + modes[i][1] + '</button>';
        }
        el.innerHTML = html;
    }

    function togglePlayback() {
        if (isPlaying) {
            stopPlayback();
            scheduleRender();
            return;
        }
        var art = getCurrentArticle();
        if (!art) {
            showToast('请先选择文章');
            return;
        }
        isPlaying = true;
        startKeepAlive();
        updateMediaSession(true);
        playNextSentence();
    }

    async function playNextSentence() {
        if (!isPlaying) return;

        var art = getCurrentArticle();
        if (!art || sentenceIdx >= art.sentences.length) {
            handlePlaybackEnd();
            return;
        }

        var newPage = Math.floor(sentenceIdx / PAGE_SIZE);
        if (newPage !== pageIdx) pageIdx = newPage;
        scheduleRender();
        savePosition();

        var sent = art.sentences[sentenceIdx];
        var enText = (sent.en || '').replace(/\|/g, '');
        var cnText = (sent.cn || '').replace(/\|/g, '');
        var mode = state.settings.audioMode;

        speechId++;
        var mySpeechId = speechId;

        cancelSpeech();
        await new Promise(function (r) { setTimeout(r, 40); });
        if (speechId !== mySpeechId || !isPlaying) return;

        if (mode === 'wwonly' && sent.ww) {
            var pairs = (sent.ww || '').match(/([a-zA-Z][a-zA-Z'\u2019\-]*)\s*\(([^)]+)\)/g) || [];
            for (var pi = 0; pi < pairs.length; pi++) {
                if (speechId !== mySpeechId || !isPlaying) return;
                var match = pairs[pi].match(/([a-zA-Z][a-zA-Z'\u2019\-]*)\s*\(([^)]+)\)/);
                if (match) {
                    await speakText(match[1], 'en-US', state.settings.enRate);
                    if (speechId !== mySpeechId || !isPlaying) return;
                    await speakText(match[2], 'zh-CN', state.settings.cnRate);
                    if (speechId !== mySpeechId || !isPlaying) return;
                }
            }
        } else {
            await speakText(enText, 'en-US', state.settings.enRate);
            if (speechId !== mySpeechId || !isPlaying) return;
            if (mode === 'cnenmix' && cnText) {
                await speakText(cnText, 'zh-CN', state.settings.cnRate);
                if (speechId !== mySpeechId || !isPlaying) return;
            }
        }

        playTimeout = setTimeout(function () {
            if (!isPlaying) return;
            sentenceIdx++;
            if (sentenceIdx >= art.sentences.length) {
                handlePlaybackEnd();
            } else {
                playNextSentence();
            }
        }, 400);
    }

    function handlePlaybackEnd() {
        var data = charDataCache[selectedChar];
        if (!data) {
            stopPlayback();
            scheduleRender();
            return;
        }

        if (state.playMode === 'loop') {
            sentenceIdx = 0;
            playNextSentence();
            return;
        }

        if (playlistOn) {
            playlistIdx++;
            if (playlistIdx >= playlistArts.length) {
                playlistIdx = 0;
                showToast('🎉 列表播放完成');
                stopPlayback();
                playlistOn = false;
                scheduleRender();
                return;
            }
            var nextArt = playlistArts[playlistIdx];
            selectedArt = data.articles.indexOf(nextArt);
            sentenceIdx = 0;
            savePosition();
            playNextSentence();
            return;
        }

        if (state.playMode === 'shuffle' && data.articles.length > 1) {
            var nextIdx = selectedArt;
            while (nextIdx === selectedArt) {
                nextIdx = Math.floor(Math.random() * data.articles.length);
            }
            selectedArt = nextIdx;
            sentenceIdx = 0;
            savePosition();
            renderArticleList(data.articles);
            playNextSentence();
            return;
        }

        if (selectedArt + 1 < data.articles.length) {
            selectedArt++;
            sentenceIdx = 0;
            savePosition();
            renderArticleList(data.articles);
            playNextSentence();
            return;
        }

        sentenceIdx = 0;
        showToast('🎉 全部播放完成');
        stopPlayback();
        scheduleRender();
    }

    function navigateSentence(direction) {
        var art = getCurrentArticle();
        if (!art) return;
        stopPlayback();
        sentenceIdx += direction;
        if (sentenceIdx < 0) sentenceIdx = art.sentences.length - 1;
        if (sentenceIdx >= art.sentences.length) sentenceIdx = 0;
        savePosition();
        scheduleRender();

        var sent = art.sentences[sentenceIdx];
        if (sent) {
            cancelSpeech();
            speakText((sent.en || '').replace(/\|/g, ''), 'en-US', state.settings.enRate).then(function () {
                if (state.settings.audioMode === 'cnenmix' && sent.cn) {
                    speakText((sent.cn || '').replace(/\|/g, ''), 'zh-CN', state.settings.cnRate);
                }
            });
        }
    }

    function startPlayAll() {
        var data = charDataCache[selectedChar];
        if (!data || !data.articles.length) {
            showToast('无文章');
            return;
        }

        if (state.playMode === 'shuffle') {
            playlistArts = data.articles.slice();
            for (var i = playlistArts.length - 1; i > 0; i--) {
                var j = Math.floor(Math.random() * (i + 1));
                var tmp = playlistArts[i];
                playlistArts[i] = playlistArts[j];
                playlistArts[j] = tmp;
            }
        } else {
            playlistArts = data.articles.slice();
        }

        playlistIdx = 0;
        playlistOn = true;
        selectedArt = data.articles.indexOf(playlistArts[0]);
        sentenceIdx = 0;

        switchView('reader');

        if (isMobile()) {
            mobileScreen = 'reader';
            var sidebar = byId('crSidebar');
            var main = byId('crMain');
            if (sidebar) sidebar.classList.add('hide');
            if (main) main.classList.remove('hide');
            var back = byId('crBack');
            if (back) back.classList.add('show');
        }

        isPlaying = true;
        startKeepAlive();
        updateMediaSession(true);
        playNextSentence();
    }

    function renderSettingsView() {
        var el = byId('crSetBody');
        if (!el) return;
        var s = state.settings;
        el.innerHTML =
            '<div style="font-size:16px;font-weight:700;color:#000;margin-bottom:10px">⚙ 设置</div>' +
            '<div class="cr-setrow"><label>英语语速</label><div style="display:flex;align-items:center;gap:6px"><input type="range" id="crEnRate" min="0.5" max="2.5" step="0.1" value="' + s.enRate + '"><span class="val" id="crEnRateVal">' + s.enRate.toFixed(1) + 'x</span></div></div>' +
            '<div class="cr-setrow"><label>中文语速</label><div style="display:flex;align-items:center;gap:6px"><input type="range" id="crCnRate" min="0.5" max="2.5" step="0.1" value="' + s.cnRate + '"><span class="val" id="crCnRateVal">' + s.cnRate.toFixed(1) + 'x</span></div></div>' +
            '<div class="cr-setinfo">' +
                '<div style="font-weight:700;color:#000;margin-bottom:4px">📖 使用说明</div>' +
                '<div>• 扫描所有角色卡的聊天记录</div>' +
                '<div>• 识别三行格式: 英文+中文+逐词</div>' +
                '<div>• 点击单词播放发音显示翻译</div>' +
                '<div>• 顺序/循环/随机播放模式</div>' +
                '<div>• 后台播放+锁屏控制</div>' +
                '<div>• 自动记录阅读位置</div>' +
                '<div>• 小/中/大/特大字号</div>' +
                '<div style="margin-top:6px;color:#bbb">v5.0.0</div>' +
            '</div>';
    }

    function bindAllEvents() {
        var closeBtn = byId('crClose');
        if (closeBtn) {
            closeBtn.addEventListener('click', function (e) {
                e.preventDefault();
                closePanel();
            });
        }

        var backBtn = byId('crBack');
        if (backBtn) {
            backBtn.addEventListener('click', function (e) {
                e.preventDefault();
                var settingsView = byId('crViewSettings');
                if (settingsView && settingsView.classList.contains('on')) {
                    if (selectedArt >= 0) {
                        switchView('reader');
                        var title = byId('crTitle');
                        var art = getCurrentArticle();
                        if (title && art) title.textContent = art.title;
                    } else {
                        goBackToList();
                    }
                    return;
                }
                goBackToList();
            });
        }

        var refreshBtn = byId('crRefresh');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', function (e) {
                e.preventDefault();
                charDataCache = {};
                refreshCharList();
                if (selectedChar) {
                    selectCharacter(selectedChar);
                }
                showToast('刷新完成');
            });
        }

        var settingsBtn = byId('crSettings');
        if (settingsBtn) {
            settingsBtn.addEventListener('click', function (e) {
                e.preventDefault();
                var settingsView = byId('crViewSettings');
                if (settingsView && settingsView.classList.contains('on')) {
                    if (selectedArt >= 0) {
                        switchView('reader');
                        if (isMobile()) {
                            var art = getCurrentArticle();
                            var title = byId('crTitle');
                            if (title && art) title.textContent = art.title;
                        }
                    } else {
                        switchView('welcome');
                        if (isMobile()) goBackToList();
                    }
                } else {
                    renderSettingsView();
                    switchView('settings');
                    if (isMobile()) {
                        var sidebar = byId('crSidebar');
                        var main = byId('crMain');
                        if (sidebar) sidebar.classList.add('hide');
                        if (main) main.classList.remove('hide');
                        var back = byId('crBack');
                        if (back) back.classList.add('show');
                        var title2 = byId('crTitle');
                        if (title2) title2.textContent = '⚙ 设置';
                    }
                }
            });
        }

        var charsEl = byId('crChars');
        if (charsEl) {
            charsEl.addEventListener('click', function (e) {
                var tab = e.target.closest('.cr-chartab');
                if (tab) {
                    e.preventDefault();
                    selectCharacter(tab.dataset.name);
                }
            });
        }

        var artsEl = byId('crArts');
        if (artsEl) {
            artsEl.addEventListener('click', function (e) {
                var card = e.target.closest('.cr-artcard');
                if (card) {
                    e.preventDefault();
                    openArticle(parseInt(card.dataset.idx));
                    return;
                }
                var playAllBtn = e.target.closest('#crPlayAll');
                if (playAllBtn) {
                    e.preventDefault();
                    startPlayAll();
                }
            });
        }

        var toolbar = byId('crToolbar');
        if (toolbar) {
            toolbar.addEventListener('click', function (e) {
                var btn = e.target.closest('.cr-tbtn');
                if (!btn) return;
                e.preventDefault();
                if (btn.dataset.am) {
                    state.settings.audioMode = btn.dataset.am;
                    saveState();
                    scheduleRender();
                }
                if (btn.dataset.show === 'en') {
                    state.settings.showEN = !state.settings.showEN;
                    saveState();
                    scheduleRender();
                }
                if (btn.dataset.show === 'cn') {
                    state.settings.showCN = !state.settings.showCN;
                    saveState();
                    scheduleRender();
                }
                if (btn.dataset.show === 'ww') {
                    state.settings.showWW = !state.settings.showWW;
                    saveState();
                    scheduleRender();
                }
            });
        }

        var fontBar = byId('crFontBar');
        if (fontBar) {
            fontBar.addEventListener('click', function (e) {
                var btn = e.target.closest('.cr-optbtn');
                if (btn && btn.dataset.fs) {
                    e.preventDefault();
                    state.fontSize = btn.dataset.fs;
                    saveState();
                    renderFontBar();
                    var reader = byId('crReader');
                    if (reader) reader.className = 'cr-reader fs-' + state.fontSize;
                }
            });
        }

        var modeBar = byId('crModeBar');
        if (modeBar) {
            modeBar.addEventListener('click', function (e) {
                var btn = e.target.closest('.cr-optbtn');
                if (btn && btn.dataset.pm) {
                    e.preventDefault();
                    state.playMode = btn.dataset.pm;
                    saveState();
                    renderModeBar();
                    scheduleRender();
                }
            });
        }

        var pager = byId('crPager');
        if (pager) {
            pager.addEventListener('click', function (e) {
                var btn = e.target.closest('.cr-pgbtn');
                if (btn && !btn.disabled) {
                    e.preventDefault();
                    pageIdx = parseInt(btn.dataset.p);
                    scheduleRender();
                    var reader = byId('crReader');
                    if (reader) reader.scrollTo(0, 0);
                }
            });
        }

        var plCloseBtn = byId('crPlClose');
        if (plCloseBtn) {
            plCloseBtn.addEventListener('click', function (e) {
                e.preventDefault();
                playlistOn = false;
                stopPlayback();
                scheduleRender();
            });
        }

        var playBtn = byId('crPlay');
        if (playBtn) {
            playBtn.addEventListener('click', function (e) {
                e.preventDefault();
                togglePlayback();
            });
        }

        var prevBtn = byId('crPrev');
        if (prevBtn) {
            prevBtn.addEventListener('click', function (e) {
                e.preventDefault();
                navigateSentence(-1);
            });
        }

        var nextBtn = byId('crNext');
        if (nextBtn) {
            nextBtn.addEventListener('click', function (e) {
                e.preventDefault();
                navigateSentence(1);
            });
        }

        var loopBtn = byId('crLoop');
        if (loopBtn) {
            loopBtn.addEventListener('click', function (e) {
                e.preventDefault();
                state.playMode = state.playMode === 'loop' ? 'seq' : 'loop';
                saveState();
                scheduleRender();
            });
        }

        var speedBtn = byId('crSpeed');
        if (speedBtn) {
            speedBtn.addEventListener('click', function (e) {
                e.preventDefault();
                var speeds = [0.5, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.5, 2.0];
                var currentIdx = -1;
                for (var i = 0; i < speeds.length; i++) {
                    if (Math.abs(speeds[i] - state.settings.enRate) < 0.05) {
                        currentIdx = i;
                        break;
                    }
                }
                state.settings.enRate = speeds[(currentIdx + 1) % speeds.length];
                saveState();
                scheduleRender();
            });
        }

        var goListBtn = byId('crGoList');
        if (goListBtn) {
            goListBtn.addEventListener('click', function (e) {
                e.preventDefault();
                goBackToList();
            });
        }

        var readerEl = byId('crReader');
        if (readerEl) {
            readerEl.addEventListener('click', function (e) {
                var wordEl = e.target.closest('.cr-word');
                if (wordEl) {
                    e.preventDefault();
                    e.stopPropagation();
                    onWordClick(wordEl);
                    return;
                }
                var sentEl = e.target.closest('.cr-sent');
                if (sentEl) {
                    e.preventDefault();
                    var idx = parseInt(sentEl.dataset.si);
                    if (!isNaN(idx)) {
                        sentenceIdx = idx;
                        savePosition();
                        if (!isPlaying) scheduleRender();
                        var art = getCurrentArticle();
                        if (art && art.sentences[idx]) {
                            var sent = art.sentences[idx];
                            cancelSpeech();
                            speakText((sent.en || '').replace(/\|/g, ''), 'en-US', state.settings.enRate).then(function () {
                                if (state.settings.audioMode === 'cnenmix' && sent.cn) {
                                    speakText((sent.cn || '').replace(/\|/g, ''), 'zh-CN', state.settings.cnRate);
                                }
                            });
                        }
                    }
                }
            });
        }

        var setBody = byId('crSetBody');
        if (setBody) {
            setBody.addEventListener('input', function (e) {
                if (e.target.id === 'crEnRate') {
                    state.settings.enRate = parseFloat(e.target.value);
                    var display = byId('crEnRateVal');
                    if (display) display.textContent = state.settings.enRate.toFixed(1) + 'x';
                    saveState();
                }
                if (e.target.id === 'crCnRate') {
                    state.settings.cnRate = parseFloat(e.target.value);
                    var display2 = byId('crCnRateVal');
                    if (display2) display2.textContent = state.settings.cnRate.toFixed(1) + 'x';
                    saveState();
                }
            });
        }

        document.addEventListener('click', function (e) {
            if (!e.target.closest('.cr-tooltip') && !e.target.closest('.cr-word')) {
                hideTooltip();
            }
        });

        document.addEventListener('keydown', function (e) {
            var panel = byId('cr-panel');
            if (!panel || !panel.classList.contains('open')) return;
            var readerView = byId('crViewReader');
            if (!readerView || !readerView.classList.contains('on')) return;
            var tag = e.target.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

            if (e.code === 'Space') {
                e.preventDefault();
                togglePlayback();
            }
            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                navigateSentence(-1);
            }
            if (e.key === 'ArrowRight') {
                e.preventDefault();
                navigateSentence(1);
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                goBackToList();
            }
        });
    }

    function init() {
        loadState();
        createPanel();
        addExtensionButton();
        bindAllEvents();
        initVoices();
        console.log('[ChatReader] v5.0 initialized');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            setTimeout(init, 1000);
        });
    } else {
        setTimeout(init, 1000);
    }
})();
