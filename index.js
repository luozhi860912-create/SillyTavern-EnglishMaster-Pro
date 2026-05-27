import { getContext } from '../../../extensions.js';

(function () {
    var STORE = 'cr_v4';
    var PGSZ = 50;
    var S = { lastChar: '', pos: {}, lastV: {}, fabPos: null, fs: 'm', pm: 'seq', land: false, st: { dr: 1, zr: 1, am: 'cnenmix', se: true, sc: true, sw: true } };
    var cc = {};
    var cl = [];
    var sc = '';
    var sa = -1;
    var si = 0;
    var pn = 0;
    var pl = false;
    var pt = null;
    var sid = 0;
    var vc = [];
    var mv = 'list';
    var plm = false;
    var pli = 0;
    var pla = [];
    var tip = null;
    var tit = null;
    var ka = null;
    var rAF = null;

    function $(id) { return document.getElementById(id); }
    function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    function escA(s) { return (s || '').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
    function mob() { return window.innerWidth <= 768; }

    function toast(m) {
        var t = $('cr-toast');
        if (!t) { t = document.createElement('div'); t.id = 'cr-toast'; t.className = 'cr-toast'; document.body.appendChild(t); }
        t.textContent = m; t.classList.add('on');
        clearTimeout(t._t); t._t = setTimeout(function () { t.classList.remove('on'); }, 2200);
    }

    function load() { try { var d = JSON.parse(localStorage.getItem(STORE)); if (d) { for (var k in d) { if (k === 'st') { for (var j in d.st) S.st[j] = d.st[j]; } else S[k] = d[k]; } } } catch (e) {} }
    function save() { try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) {} }
    function saveP() { if (!sc || sa < 0) return; if (!S.pos[sc]) S.pos[sc] = {}; S.pos[sc].a = sa; S.pos[sc].s = si; S.lastChar = sc; S.lastV[sc] = sa; save(); }

    function clean(r) {
        var t = r || '';
        t = t.replace(/<prepare>[\s\S]*?<\/prepare>/gi, '');
        t = t.replace(/<details>[\s\S]*?<\/details>/gi, '');
        t = t.replace(/<br\s*\/?>/gi, '\n');
        t = t.replace(/<[^>]+>/g, '');
        var a = document.createElement('textarea'); a.innerHTML = t; t = a.value;
        var ci = t.search(/>\s*选择[：:]/);
        if (ci > 0) t = t.substring(0, ci);
        return t.trim();
    }

    function isE(l) { var e = (l.match(/[a-zA-Z]/g) || []).length, c = (l.match(/[\u4e00-\u9fff]/g) || []).length; return e > c && e >= 3; }
    function isC(l) { return (l.match(/[\u4e00-\u9fff]/g) || []).length >= 2; }
    function isW(l) { return ((l || '').match(/[a-zA-Z][a-zA-Z'\u2019\-]*\s*\([^)]*[\u4e00-\u9fff][^)]*\)/g) || []).length >= 2; }

    function parse(msgs, cf) {
        var arts = [], fl = 0;
        for (var mi = 0; mi < msgs.length; mi++) {
            var msg = msgs[mi];
            if (msg.is_user || msg.is_system || !msg.mes || !msg.mes.trim()) continue;
            var txt = clean(msg.mes);
            var ls = txt.split('\n'), lines = [];
            for (var li = 0; li < ls.length; li++) { var x = ls[li].trim(); if (x) lines.push(x); }
            var ss = [], i = 0;
            while (i < lines.length) {
                if (i + 2 < lines.length && isE(lines[i]) && isC(lines[i + 1]) && isW(lines[i + 2])) {
                    ss.push({ en: lines[i], cn: lines[i + 1], ww: lines[i + 2] }); i += 3;
                } else if (i + 1 < lines.length && isE(lines[i]) && isC(lines[i + 1])) {
                    ss.push({ en: lines[i], cn: lines[i + 1], ww: '' }); i += 2;
                } else { i++; }
            }
            if (!ss.length) continue;
            fl++;
            var title = '#' + fl;
            for (var pi = mi - 1; pi >= 0; pi--) {
                if (msgs[pi].is_user && msgs[pi].mes) { title = '#' + fl + ' ' + clean(msgs[pi].mes).substring(0, 35); break; }
            }
            arts.push({ title: title, sentences: ss, floor: fl, cf: cf || 'current' });
        }
        return arts;
    }

    async function aPost(urls, body) {
        var ep = Array.isArray(urls) ? urls : [urls];
        for (var i = 0; i < ep.length; i++) {
            try { var r = await fetch(ep[i], { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); if (r.ok) return await r.json(); } catch (e) {}
        }
        return null;
    }

    async function loadCD(name, av) {
        if (cc[name] && cc[name].ok) return cc[name];
        var d = { name: name, articles: [], ok: false };
        cc[name] = d;
        var ctx = getContext();
        if (ctx.name2 === name && ctx.chat && ctx.chat.length) d.articles = parse(ctx.chat, 'current');
        try {
            var cfs = await aPost(['/api/characters/chats', '/getallchatsofcharacter'], { avatar_url: av });
            if (cfs && Array.isArray(cfs)) {
                var cur = (ctx.name2 === name && ctx.chat_metadata && ctx.chat_metadata.file_name) ? ctx.chat_metadata.file_name : '';
                for (var ci = 0; ci < cfs.length; ci++) {
                    var fn = cfs[ci].file_name || cfs[ci].fileName;
                    if (!fn || (cur && fn.indexOf(cur) >= 0)) continue;
                    try {
                        var ms = await aPost(['/api/chats/get', '/getchat'], { ch_name: name, file_name: fn, avatar_url: av });
                        if (ms && Array.isArray(ms)) { var a2 = parse(ms, fn); for (var j = 0; j < a2.length; j++) d.articles.push(a2[j]); }
                    } catch (e) {}
                }
                for (var k = 0; k < d.articles.length; k++) d.articles[k].floor = k + 1;
            }
        } catch (e) {}
        d.ok = true;
        return d;
    }

    function gCL() {
        try {
            var ctx = getContext(), cs = ctx.characters || [], m = {};
            for (var i = 0; i < cs.length; i++) { if (cs[i].name && !m[cs[i].name]) m[cs[i].name] = cs[i].avatar || ''; }
            if (ctx.name2 && !m[ctx.name2]) m[ctx.name2] = '';
            var r = [];
            for (var n in m) r.push({ name: n, avatar: m[n] });
            return r;
        } catch (e) { return []; }
    }

    function initV() {
        if (!window.speechSynthesis) return;
        var l = function () { vc = speechSynthesis.getVoices(); };
        l();
        if (speechSynthesis.onvoiceschanged !== undefined) speechSynthesis.onvoiceschanged = l;
        setTimeout(l, 2000);
    }

    function fV(lang) {
        if (!vc.length) vc = speechSynthesis.getVoices();
        var p = lang.split('-')[0], m = [];
        for (var i = 0; i < vc.length; i++) { if (vc[i].lang === lang || vc[i].lang.indexOf(p) === 0) m.push(vc[i]); }
        for (var j = 0; j < m.length; j++) { if (m[j].localService) return m[j]; }
        return m[0] || null;
    }

    function s1(text, lang, rate) {
        return new Promise(function (res) {
            if (!window.speechSynthesis || !text || !text.trim()) { res(); return; }
            var u = new SpeechSynthesisUtterance(text.trim());
            u.lang = lang; u.rate = Math.max(0.1, Math.min(5, rate || 1));
            var v = fV(lang); if (v) u.voice = v;
            var d = false, f = function () { if (!d) { d = true; clearTimeout(tm); res(); } };
            var tm = setTimeout(f, Math.max(6000, text.length * 800));
            u.onend = f; u.onerror = f;
            try { speechSynthesis.speak(u); } catch (e) { f(); }
        });
    }

    function cs() { try { speechSynthesis.cancel(); } catch (e) {} }

    function spkW(w) {
        if (!w) return; cs();
        var u = new SpeechSynthesisUtterance(w);
        u.lang = 'en-US'; u.rate = S.st.dr;
        var v = fV('en-US'); if (v) u.voice = v;
        try { speechSynthesis.speak(u); } catch (e) {}
    }

    function stopP() { pl = false; clearTimeout(pt); cs(); sid++; stopKA(); upMS(false); }

    function startKA() {
        if (ka) return;
        try { ka = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA='); ka.loop = true; ka.volume = 0.01; ka.play().catch(function () {}); } catch (e) {}
    }

    function stopKA() { if (ka) { ka.pause(); ka = null; } }

    function upMS(isP) {
        if (!('mediaSession' in navigator)) return;
        try {
            var art = gA();
            navigator.mediaSession.metadata = new MediaMetadata({ title: art ? art.title : 'Chat Reader', artist: sc || '', album: 'English' });
            navigator.mediaSession.playbackState = isP ? 'playing' : 'paused';
            navigator.mediaSession.setActionHandler('play', function () { togP(); });
            navigator.mediaSession.setActionHandler('pause', function () { stopP(); render(); });
            navigator.mediaSession.setActionHandler('previoustrack', function () { navS(-1); });
            navigator.mediaSession.setActionHandler('nexttrack', function () { navS(1); });
        } catch (e) {}
    }

    function clW(w) { return (w || '').replace(/^[.,!?;:'"()\-\u2013\u00bb\u00ab\[\]{}\/\\]+/, '').replace(/[.,!?;:'"()\-\u2013\u00bb\u00ab\u2026\[\]{}\/\\]+$/, '').trim(); }

    function rcE(text) {
        if (!text) return '';
        var parts = text.replace(/\|/g, '').split(/(\s+)/), h = '';
        for (var i = 0; i < parts.length; i++) {
            var p = parts[i];
            if (!p) continue;
            if (/^\s+$/.test(p)) { h += ' '; continue; }
            if (/[a-zA-Z]/.test(p)) {
                var m = p.match(/^([^a-zA-Z]*)([a-zA-Z][a-zA-Z'\u2019\-]*[a-zA-Z]|[a-zA-Z])([^a-zA-Z]*)$/);
                if (m) { h += esc(m[1]) + '<span class="cr-w" data-w="' + escA(clW(m[2])) + '">' + esc(m[2]) + '</span>' + esc(m[3]); }
                else { h += '<span class="cr-w" data-w="' + escA(clW(p)) + '">' + esc(p) + '</span>'; }
            } else { h += esc(p); }
        }
        return h;
    }

    function hideTip() { if (tip) { tip.remove(); tip = null; } if (tit) { clearTimeout(tit); tit = null; } }

    function showTip(el, text) {
        hideTip();
        var r = el.getBoundingClientRect();
        var t = document.createElement('div'); t.className = 'cr-tip'; t.textContent = text;
        t.style.left = (r.left + r.width / 2) + 'px';
        if (r.top > 50) { t.style.top = (r.top - 5) + 'px'; t.style.transform = 'translateX(-50%) translateY(-100%)'; }
        else { t.style.top = (r.bottom + 5) + 'px'; t.style.transform = 'translateX(-50%)'; }
        document.body.appendChild(t);
        requestAnimationFrame(function () {
            var tr = t.getBoundingClientRect();
            if (tr.right > window.innerWidth - 4) t.style.left = (window.innerWidth - tr.width / 2 - 4) + 'px';
            if (tr.left < 4) t.style.left = (tr.width / 2 + 4) + 'px';
            t.classList.add('vis');
        });
        tip = t; tit = setTimeout(hideTip, 3000);
    }

    function onCW(el) {
        var w = clW(el.dataset.w || el.textContent);
        if (!w) return;
        el.classList.add('spk'); setTimeout(function () { el.classList.remove('spk'); }, 1000);
        spkW(w);
        hideTip();
        var trans = '';
        var arts = cc[sc] ? cc[sc].articles : [];
        if (sa >= 0 && arts[sa]) {
            for (var i = 0; i < arts[sa].sentences.length; i++) {
                var s = arts[sa].sentences[i];
                if (!s.ww) continue;
                var rx = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\(([^)]+)\\)', 'i');
                var mm = s.ww.match(rx);
                if (mm) { trans = mm[1]; break; }
            }
        }
        showTip(el, trans || w);
    }

    function gA() { var d = cc[sc]; return (d && d.articles && d.articles[sa]) ? d.articles[sa] : null; }

    function createUI() {
        var fab = document.createElement('button');
        fab.id = 'cr-fab'; fab.textContent = '\uD83D\uDCD6';
        var pos = S.fabPos || { x: mob() ? Math.round(window.innerWidth / 2 - 25) : (window.innerWidth - 70), y: Math.round(window.innerHeight / 2 - 25) };
        fab.style.left = pos.x + 'px'; fab.style.top = pos.y + 'px';
        document.body.appendChild(fab);
        initDrag(fab);

        var root = document.createElement('div');
        root.id = 'cr-root';
        if (S.land) root.classList.add('cr-landscape');
        root.innerHTML =
            '<div class="cr-bar" id="cr-bar">' +
                '<button class="cr-bb" id="cr-back" style="display:none">\u25C0</button>' +
                '<span class="cr-bar-title" id="cr-title">\uD83D\uDCD6 Chat Reader</span>' +
                '<button class="cr-bb" id="cr-brot" title="\u65CB\u8F6C">\uD83D\uDD04</button>' +
                '<button class="cr-bb" id="cr-bref" title="\u5237\u65B0">\u267B</button>' +
                '<button class="cr-bb" id="cr-bset" title="\u8BBE\u7F6E">\u2699</button>' +
                '<button class="cr-bb" id="cr-bclose">\u2715</button>' +
            '</div>' +
            '<div class="cr-body-wrap">' +
                '<div class="cr-body">' +
                    '<div class="cr-side" id="cr-side">' +
                        '<div class="cr-chtabs" id="cr-ch"></div>' +
                        '<div class="cr-alist" id="cr-al"><div class="cr-se">\u70B9\u51FB\u89D2\u8272\u5361\u52A0\u8F7D</div></div>' +
                    '</div>' +
                    '<div class="cr-main" id="cr-main">' +
                        '<div class="cr-vw on" id="cr-vw">' +
                            '<div class="cr-wel"><div style="font-size:2.5rem">\uD83D\uDCD6</div><h3>Chat Article Reader</h3><p>\u9009\u62E9\u89D2\u8272\u5361\u626B\u63CF\u804A\u5929\u8BB0\u5F55\u3002<br>\u70B9\u51FB\u82F1\u6587\u5355\u8BCD\u64AD\u653E\u53D1\u97F3\u3002<br>\u652F\u6301\u540E\u53F0\u64AD\u653E\u3002</p></div>' +
                        '</div>' +
                        '<div class="cr-vw" id="cr-vr">' +
                            '<div class="cr-tb2" id="cr-tb"></div>' +
                            '<div class="cr-fb" id="cr-fbr"></div>' +
                            '<div class="cr-mb" id="cr-mbr"></div>' +
                            '<div class="cr-plb" id="cr-pl"><span>\uD83D\uDCCB <b id="cr-pln">\u2014</b></span><button class="cr-bb" id="cr-plx" style="width:24px;height:24px;font-size:.7rem">\u2715</button></div>' +
                            '<div class="cr-prg"><div class="cr-pb"><div class="cr-pf" id="cr-pf"></div></div><div class="cr-px"><span id="cr-pi">0/0</span><span id="cr-pt">\u2014</span></div></div>' +
                            '<div class="cr-pgr" id="cr-pgr"></div>' +
                            '<div class="cr-rd cr-fs-m" id="cr-rd"></div>' +
                            '<div class="cr-ct">' +
                                '<span class="cr-spd" id="cr-spd">' + S.st.dr.toFixed(1) + 'x</span>' +
                                '<button class="cr-c" id="cr-prev">\u23EE</button>' +
                                '<button class="cr-c cp" id="cr-play">\u25B6\uFE0F</button>' +
                                '<button class="cr-c" id="cr-next">\u23ED</button>' +
                                '<button class="cr-c" id="cr-loop">\uD83D\uDD01</button>' +
                                '<button class="cr-c" id="cr-gl">\uD83D\uDCCB</button>' +
                            '</div>' +
                        '</div>' +
                        '<div class="cr-vw" id="cr-vs">' +
                            '<div class="cr-stb" id="cr-stb"></div>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
            '</div>';
        document.body.appendChild(root);
    }

    function initDrag(el) {
        var drag = false, moved = false, sx, sy, ex, ey;
        function oS(e) { drag = true; moved = false; var t = e.touches ? e.touches[0] : e; sx = t.clientX; sy = t.clientY; ex = parseInt(el.style.left); ey = parseInt(el.style.top); e.preventDefault(); }
        function oM(e) { if (!drag) return; var t = e.touches ? e.touches[0] : e; var dx = t.clientX - sx, dy = t.clientY - sy; if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true; el.style.left = Math.max(0, Math.min(window.innerWidth - 56, ex + dx)) + 'px'; el.style.top = Math.max(0, Math.min(window.innerHeight - 56, ey + dy)) + 'px'; }
        function oE() { drag = false; S.fabPos = { x: parseInt(el.style.left), y: parseInt(el.style.top) }; save(); if (!moved) togPanel(); }
        el.addEventListener('mousedown', oS); el.addEventListener('touchstart', oS, { passive: false });
        document.addEventListener('mousemove', oM); document.addEventListener('touchmove', oM, { passive: false });
        document.addEventListener('mouseup', oE); document.addEventListener('touchend', oE);
    }

    function togPanel() { var r = $('cr-root'); if (!r) return; if (r.classList.contains('cr-open')) closeP(); else openP(); }
    function openP() {
        var r = $('cr-root'); if (!r) return;
        r.classList.add('cr-open');
        mv = 'list';
        if (mob()) { $('cr-side').classList.remove('cr-hide'); $('cr-main').classList.add('cr-hide'); $('cr-back').style.display = 'none'; $('cr-title').textContent = '\uD83D\uDCD6 Chat Reader'; }
        else { $('cr-side').classList.remove('cr-hide'); $('cr-main').classList.remove('cr-hide'); }
        rCL();
        if (S.lastChar && !sc) selC(S.lastChar);
    }
    function closeP() { $('cr-root').classList.remove('cr-open'); }

    function rCL() { cl = gCL(); rCH(); }

    function rCH() {
        var el = $('cr-ch'); if (!el) return;
        var h = '';
        for (var i = 0; i < cl.length; i++) h += '<button class="cr-cht' + (cl[i].name === sc ? ' on' : '') + '" data-ch="' + escA(cl[i].name) + '" data-av="' + escA(cl[i].avatar) + '">' + esc(cl[i].name) + '</button>';
        el.innerHTML = h || '<span style="color:#aaa;font-size:.72rem;padding:6px">\u65E0\u89D2\u8272\u5361</span>';
    }

    async function selC(name) {
        var ch = null;
        for (var i = 0; i < cl.length; i++) { if (cl[i].name === name) { ch = cl[i]; break; } }
        if (!ch) return;
        sc = name; S.lastChar = name; save();
        rCH();
        $('cr-al').innerHTML = '<div class="cr-se">\u23F3 \u626B\u63CF\u4E2D...</div>';
        var d = await loadCD(name, ch.avatar);
        if (sc !== name) return;
        rAL(d.articles);
        var sv = S.pos[name];
        if (sv && sv.a >= 0 && sv.a < d.articles.length) opA(sv.a, sv.s || 0);
    }

    function rAL(arts) {
        var el = $('cr-al'); if (!el) return;
        if (!arts.length) { el.innerHTML = '<div class="cr-se">\u65E0\u4E09\u884C\u683C\u5F0F\u5185\u5BB9</div>'; return; }
        var gs = {}, go = [];
        for (var i = 0; i < arts.length; i++) {
            var g = arts[i].cf || 'current';
            if (!gs[g]) { gs[g] = []; go.push(g); }
            gs[g].push({ a: arts[i], i: i });
        }
        var lv = S.lastV[sc], h = '';
        for (var gi = 0; gi < go.length; gi++) {
            var gn = go[gi], items = gs[gn];
            if (go.length > 1) h += '<div class="cr-cl">' + (gn === 'current' ? '\uD83D\uDCCD \u5F53\u524D' : '\uD83D\uDCC4 ' + esc(gn.substring(0, 22))) + '</div>';
            for (var j = 0; j < items.length; j++) {
                var it = items[j], ic = it.i === sa, il = it.i === lv && !ic;
                h += '<div class="cr-ac' + (ic ? ' on' : '') + (il ? ' lv' : '') + '" data-ai="' + it.i + '"><div class="cr-an">' + it.a.floor + '</div><div class="cr-ai"><div class="cr-at">' + esc(it.a.title) + '</div><div class="cr-am">' + it.a.sentences.length + '\u53E5</div></div><span class="cr-ab">' + it.a.sentences.length + '</span></div>';
            }
        }
        h += '<div class="cr-pab"><button id="cr-pall">\u25B6 \u8FDE\u7EED\u64AD\u653E (' + arts.length + '\u7BC7)</button></div>';
        el.innerHTML = h;
    }

    function opA(idx, ss) {
        var d = cc[sc]; if (!d || !d.articles[idx]) return;
        sa = idx; si = ss || 0; pn = Math.floor(si / PGSZ);
        S.lastV[sc] = idx; saveP();
        sV('reader'); render();
        if (mob()) {
            mv = 'reader';
            $('cr-side').classList.add('cr-hide');
            $('cr-main').classList.remove('cr-hide');
            $('cr-back').style.display = '';
            $('cr-title').textContent = d.articles[idx].title;
        }
        rAL(d.articles);
    }

    function sV(v) {
        var w = $('cr-vw'), r = $('cr-vr'), s = $('cr-vs');
        if (w) w.classList.toggle('on', v === 'welcome');
        if (r) r.classList.toggle('on', v === 'reader');
        if (s) s.classList.toggle('on', v === 'settings');
    }

    function goL() {
        stopP();
        if (mob()) {
            mv = 'list';
            $('cr-side').classList.remove('cr-hide');
            $('cr-main').classList.add('cr-hide');
            $('cr-back').style.display = 'none';
            $('cr-title').textContent = '\uD83D\uDCD6 Chat Reader';
        }
    }

    function render() {
        if (rAF) return;
        rAF = requestAnimationFrame(function () { rAF = null; doRender(); });
    }

    function doRender() {
        var art = gA(); if (!art) return;
        var ss = art.sentences, tp = Math.ceil(ss.length / PGSZ);
        var ap = Math.floor(si / PGSZ);
        if (pl && pn !== ap) pn = ap;
        if (pn >= tp) pn = tp - 1;
        if (pn < 0) pn = 0;
        var ps = pn * PGSZ, pe = Math.min(ps + PGSZ, ss.length);

        var pf = $('cr-pf'); if (pf) pf.style.width = Math.round((si + 1) / ss.length * 100) + '%';
        var pi = $('cr-pi'); if (pi) pi.textContent = (si + 1) + '/' + ss.length;
        var ptx = $('cr-pt'); if (ptx) ptx.textContent = art.title;

        var pgr = $('cr-pgr');
        if (pgr) {
            if (tp > 1) {
                var h = '<button class="cr-pg" data-p="0"' + (pn === 0 ? ' disabled' : '') + '>\u23EE</button><button class="cr-pg" data-p="' + (pn - 1) + '"' + (pn === 0 ? ' disabled' : '') + '>\u25C0</button>';
                var mx = 5, sp = Math.max(0, pn - 2), ep = Math.min(tp, sp + mx);
                if (ep - sp < mx) sp = Math.max(0, ep - mx);
                for (var p = sp; p < ep; p++) h += '<button class="cr-pg' + (p === pn ? ' on' : '') + '" data-p="' + p + '">' + (p + 1) + '</button>';
                h += '<button class="cr-pg" data-p="' + (pn + 1) + '"' + (pn >= tp - 1 ? ' disabled' : '') + '>\u25B6</button><button class="cr-pg" data-p="' + (tp - 1) + '"' + (pn >= tp - 1 ? ' disabled' : '') + '>\u23ED</button>';
                h += '<span class="cr-pgi">' + (ps + 1) + '-' + pe + '/' + ss.length + '</span>';
                pgr.innerHTML = h; pgr.classList.add('on');
            } else { pgr.innerHTML = ''; pgr.classList.remove('on'); }
        }

        var bd = $('cr-rd');
        if (bd) {
            var st = S.st, bh = '';
            for (var i = ps; i < pe; i++) {
                var s = ss[i], ac = i === si, dn = i < si;
                bh += '<div class="cr-s' + (ac ? ' act' : '') + (dn ? ' dn' : '') + '" data-si="' + i + '"><span class="cr-sn">#' + (i + 1) + '</span><div class="cr-en' + (st.se ? '' : ' cr-hd') + '">' + rcE((s.en || '').replace(/\|/g, '')) + '</div><div class="cr-cn' + (st.sc ? '' : ' cr-hd') + '">' + esc((s.cn || '').replace(/\|/g, '')) + '</div>' + (s.ww ? '<div class="cr-ww' + (st.sw ? '' : ' cr-hd') + '">' + rcE((s.ww || '').replace(/\|/g, '')) + '</div>' : '') + '</div>';
            }
            bd.innerHTML = bh;
            bd.className = 'cr-rd cr-fs-' + (S.fs || 'm');
            setTimeout(function () { var a = bd.querySelector('.act'); if (a) a.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 60);
        }

        var pb = $('cr-play');
        if (pb) { pb.textContent = pl ? '\u23F8' : '\u25B6\uFE0F'; pb.classList.toggle('on', pl); }
        var lb = $('cr-loop');
        if (lb) lb.classList.toggle('lo', S.pm === 'loop');
        var spd = $('cr-spd');
        if (spd) spd.textContent = S.st.dr.toFixed(1) + 'x';

        var plb = $('cr-pl');
        if (plb) { if (plm) { plb.classList.add('on'); var pln = $('cr-pln'); if (pln) pln.textContent = art.title + ' (' + (pli + 1) + '/' + pla.length + ')'; } else plb.classList.remove('on'); }

        rTB(); rFB(); rMB();
    }

    function rTB() {
        var tb = $('cr-tb'); if (!tb) return;
        var st = S.st;
        tb.innerHTML =
            '<button class="cr-rt' + (st.am === 'cnenmix' ? ' on' : '') + '" data-am="cnenmix">\uD83D\uDD0A\u4E2D\u82F1</button>' +
            '<button class="cr-rt' + (st.am === 'enonly' ? ' on' : '') + '" data-am="enonly">\uD83D\uDD0A\u7EAF\u82F1</button>' +
            '<button class="cr-rt' + (st.am === 'wwonly' ? ' on' : '') + '" data-am="wwonly">\uD83D\uDD0A\u8BCD\u6C47</button>' +
            '<span class="cr-sp2"></span>' +
            '<button class="cr-rt' + (st.se ? ' on' : '') + '" data-sh="en">\u82F1\u6587</button>' +
            '<button class="cr-rt' + (st.sc ? ' on' : '') + '" data-sh="cn">\u4E2D\u6587</button>' +
            '<button class="cr-rt' + (st.sw ? ' on' : '') + '" data-sh="ww">\u8BCD\u6C47</button>';
    }

    function rFB() {
        var fb = $('cr-fbr'); if (!fb) return;
        var ss = [['s', '\u5C0F'], ['m', '\u4E2D'], ['l', '\u5927'], ['xl', '\u7279\u5927']];
        var h = '<label>\u5B57\u53F7:</label>';
        for (var i = 0; i < ss.length; i++) h += '<button class="cr-fbtn' + (S.fs === ss[i][0] ? ' on' : '') + '" data-fs="' + ss[i][0] + '">' + ss[i][1] + '</button>';
        fb.innerHTML = h;
    }

    function rMB() {
        var mb = $('cr-mbr'); if (!mb) return;
        var ms = [['seq', '\u987A\u5E8F'], ['loop', '\u5355\u7BC7\u5FAA\u73AF'], ['shuffle', '\u968F\u673A']];
        var h = '<label>\u64AD\u653E:</label>';
        for (var i = 0; i < ms.length; i++) h += '<button class="cr-mbtn' + (S.pm === ms[i][0] ? ' on' : '') + '" data-pm="' + ms[i][0] + '">' + ms[i][1] + '</button>';
        mb.innerHTML = h;
    }

    function togP() {
        if (pl) { stopP(); render(); return; }
        if (!gA()) { toast('\u8BF7\u5148\u9009\u62E9\u6587\u7AE0'); return; }
        pl = true; startKA(); upMS(true); pStep();
    }

    async function pStep() {
        if (!pl) return;
        var art = gA();
        if (!art || si >= art.sentences.length) { hEnd(); return; }
        var np = Math.floor(si / PGSZ);
        if (np !== pn) pn = np;
        render(); saveP();

        var s = art.sentences[si];
        var en = (s.en || '').replace(/\|/g, '');
        var cn = (s.cn || '').replace(/\|/g, '');
        var am = S.st.am;

        sid++; var my = sid;
        cs(); await new Promise(function (r) { setTimeout(r, 50); });
        if (sid !== my || !pl) return;

        if (am === 'wwonly' && s.ww) {
            var pairs = (s.ww || '').match(/([a-zA-Z][a-zA-Z'\u2019\-]*)\s*\(([^)]+)\)/g) || [];
            for (var pi = 0; pi < pairs.length; pi++) {
                if (sid !== my || !pl) return;
                var mm = pairs[pi].match(/([a-zA-Z][a-zA-Z'\u2019\-]*)\s*\(([^)]+)\)/);
                if (mm) { await s1(mm[1], 'en-US', S.st.dr); if (sid !== my || !pl) return; await s1(mm[2], 'zh-CN', S.st.zr); if (sid !== my || !pl) return; }
            }
        } else {
            await s1(en, 'en-US', S.st.dr);
            if (sid !== my || !pl) return;
            if (am === 'cnenmix' && cn) { await s1(cn, 'zh-CN', S.st.zr); if (sid !== my || !pl) return; }
        }

        pt = setTimeout(function () { if (!pl) return; si++; if (si >= art.sentences.length) hEnd(); else pStep(); }, 500);
    }

    function hEnd() {
        var d = cc[sc]; if (!d) { stopP(); render(); return; }
        if (S.pm === 'loop') { si = 0; pStep(); return; }
        if (plm) {
            pli++;
            if (pli >= pla.length) { pli = 0; toast('\uD83C\uDF89 \u5B8C\u6210'); stopP(); plm = false; render(); return; }
            sa = d.articles.indexOf(pla[pli]); si = 0; saveP(); pStep(); return;
        }
        if (S.pm === 'shuffle' && d.articles.length > 1) {
            var nx = sa; while (nx === sa) nx = Math.floor(Math.random() * d.articles.length);
            sa = nx; si = 0; saveP(); rAL(d.articles); pStep(); return;
        }
        if (sa + 1 < d.articles.length) { sa++; si = 0; saveP(); rAL(d.articles); pStep(); return; }
        si = 0; toast('\uD83C\uDF89 \u5168\u90E8\u5B8C\u6210'); stopP(); render();
    }

    function navS(dir) {
        var art = gA(); if (!art) return;
        stopP(); si += dir;
        if (si < 0) si = art.sentences.length - 1;
        if (si >= art.sentences.length) si = 0;
        saveP(); render();
        var s = art.sentences[si];
        if (s) { cs(); s1((s.en || '').replace(/\|/g, ''), 'en-US', S.st.dr).then(function () { if (S.st.am === 'cnenmix' && s.cn) s1((s.cn || '').replace(/\|/g, ''), 'zh-CN', S.st.zr); }); }
    }

    function startPA() {
        var d = cc[sc]; if (!d || !d.articles.length) { toast('\u65E0\u6587\u7AE0'); return; }
        if (S.pm === 'shuffle') {
            pla = d.articles.slice();
            for (var i = pla.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = pla[i]; pla[i] = pla[j]; pla[j] = t; }
        } else { pla = d.articles.slice(); }
        pli = 0; plm = true; sa = d.articles.indexOf(pla[0]); si = 0;
        sV('reader');
        if (mob()) { mv = 'reader'; $('cr-side').classList.add('cr-hide'); $('cr-main').classList.remove('cr-hide'); $('cr-back').style.display = ''; }
        pl = true; startKA(); upMS(true); pStep();
    }

    function rSet() {
        var el = $('cr-stb'); if (!el) return;
        el.innerHTML =
            '<div style="font-size:1rem;font-weight:700;color:#000;margin-bottom:12px">\u2699 \u8BBE\u7F6E</div>' +
            '<div class="cr-sr"><label>\u82F1\u8BED\u8BED\u901F</label><div style="display:flex;align-items:center;gap:6px"><input type="range" id="cr-sdr" min="0.5" max="2.5" step="0.1" value="' + S.st.dr + '"><span class="vl" id="cr-vdr">' + S.st.dr.toFixed(1) + 'x</span></div></div>' +
            '<div class="cr-sr"><label>\u4E2D\u6587\u8BED\u901F</label><div style="display:flex;align-items:center;gap:6px"><input type="range" id="cr-szr" min="0.5" max="2.5" step="0.1" value="' + S.st.zr + '"><span class="vl" id="cr-vzr">' + S.st.zr.toFixed(1) + 'x</span></div></div>' +
            '<div class="cr-si"><div style="font-weight:700;color:#000;margin-bottom:4px">\uD83D\uDCD6 \u8BF4\u660E</div><div>\u2022 \u626B\u63CF\u6240\u6709\u89D2\u8272\u5361\u804A\u5929\u8BB0\u5F55</div><div>\u2022 \u8BC6\u522B\u4E09\u884C\u683C\u5F0F: \u82F1\u6587+\u4E2D\u6587+\u9010\u8BCD</div><div>\u2022 \u70B9\u51FB\u5355\u8BCD\u64AD\u653E\u53D1\u97F3\u663E\u793A\u7FFB\u8BD1</div><div>\u2022 \u987A\u5E8F/\u5FAA\u73AF/\u968F\u673A\u64AD\u653E</div><div>\u2022 \u540E\u53F0\u64AD\u653E+\u9501\u5C4F\u63A7\u5236</div><div>\u2022 \u81EA\u52A8\u8BB0\u5F55\u4F4D\u7F6E</div><div>\u2022 \u53EF\u62D6\u52A8\u6309\u94AE</div><div>\u2022 \u5C0F/\u4E2D/\u5927/\u7279\u5927\u5B57\u53F7</div><div>\u2022 \u6A2A\u5C4F/\u7AD6\u5C4F\u5207\u6362</div><div style="margin-top:6px;color:#bbb">v4.0.0</div></div>';
    }

    function bind() {
        $('cr-bclose').addEventListener('click', closeP);
        $('cr-back').addEventListener('click', function () {
            if ($('cr-vs').classList.contains('on')) {
                if (sa >= 0) { sV('reader'); if (mob()) $('cr-title').textContent = gA() ? gA().title : '\uD83D\uDCD6'; } else goL();
            } else goL();
        });
        $('cr-bref').addEventListener('click', function () { cc = {}; rCL(); if (sc) { delete cc[sc]; selC(sc); } toast('\u5237\u65B0\u5B8C\u6210'); });
        $('cr-brot').addEventListener('click', function () { S.land = !S.land; save(); $('cr-root').classList.toggle('cr-landscape', S.land); toast(S.land ? '\u6A2A\u5C4F' : '\u7AD6\u5C4F'); });
        $('cr-bset').addEventListener('click', function () {
            if ($('cr-vs').classList.contains('on')) {
                if (sa >= 0) { sV('reader'); if (mob()) $('cr-title').textContent = gA() ? gA().title : '\uD83D\uDCD6'; } else { sV('welcome'); if (mob()) goL(); }
            } else {
                rSet(); sV('settings');
                if (mob()) { $('cr-side').classList.add('cr-hide'); $('cr-main').classList.remove('cr-hide'); $('cr-back').style.display = ''; $('cr-title').textContent = '\u2699 \u8BBE\u7F6E'; }
            }
        });
        $('cr-ch').addEventListener('click', function (e) { var b = e.target.closest('.cr-cht'); if (b) selC(b.dataset.ch); });
        $('cr-al').addEventListener('click', function (e) {
            var c = e.target.closest('.cr-ac'); if (c) { opA(parseInt(c.dataset.ai)); return; }
            if (e.target.id === 'cr-pall' || e.target.closest('#cr-pall')) startPA();
        });
        $('cr-tb').addEventListener('click', function (e) {
            var b = e.target.closest('.cr-rt'); if (!b) return;
            if (b.dataset.am) { S.st.am = b.dataset.am; save(); render(); }
            if (b.dataset.sh === 'en') { S.st.se = !S.st.se; save(); render(); }
            if (b.dataset.sh === 'cn') { S.st.sc = !S.st.sc; save(); render(); }
            if (b.dataset.sh === 'ww') { S.st.sw = !S.st.sw; save(); render(); }
        });
        $('cr-fbr').addEventListener('click', function (e) { var b = e.target.closest('.cr-fbtn'); if (b) { S.fs = b.dataset.fs; save(); rFB(); var rd = $('cr-rd'); if (rd) rd.className = 'cr-rd cr-fs-' + S.fs; } });
        $('cr-mbr').addEventListener('click', function (e) { var b = e.target.closest('.cr-mbtn'); if (b) { S.pm = b.dataset.pm; save(); rMB(); render(); } });
        $('cr-pgr').addEventListener('click', function (e) { var b = e.target.closest('.cr-pg'); if (b && !b.disabled) { pn = parseInt(b.dataset.p); render(); var rd = $('cr-rd'); if (rd) rd.scrollTo(0, 0); } });
        $('cr-plx').addEventListener('click', function () { plm = false; stopP(); render(); });
        $('cr-play').addEventListener('click', togP);
        $('cr-prev').addEventListener('click', function () { navS(-1); });
        $('cr-next').addEventListener('click', function () { navS(1); });
        $('cr-loop').addEventListener('click', function () { S.pm = S.pm === 'loop' ? 'seq' : 'loop'; save(); render(); });
        $('cr-spd').addEventListener('click', function () {
            var sp = [0.5, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.5, 2.0];
            var ci = -1; for (var i = 0; i < sp.length; i++) { if (Math.abs(sp[i] - S.st.dr) < 0.05) { ci = i; break; } }
            S.st.dr = sp[(ci + 1) % sp.length]; save(); render();
        });
        $('cr-gl').addEventListener('click', goL);
        $('cr-rd').addEventListener('click', function (e) {
            var w = e.target.closest('.cr-w'); if (w) { e.preventDefault(); e.stopPropagation(); onCW(w); return; }
            var s = e.target.closest('.cr-s');
            if (s) {
                var idx = parseInt(s.dataset.si);
                if (!isNaN(idx)) {
                    si = idx; saveP(); if (!pl) render();
                    var art = gA();
                    if (art && art.sentences[idx]) { var sn = art.sentences[idx]; cs(); s1((sn.en || '').replace(/\|/g, ''), 'en-US', S.st.dr).then(function () { if (S.st.am === 'cnenmix' && sn.cn) s1((sn.cn || '').replace(/\|/g, ''), 'zh-CN', S.st.zr); }); }
                }
            }
        });
        $('cr-stb').addEventListener('input', function (e) {
            if (e.target.id === 'cr-sdr') { S.st.dr = parseFloat(e.target.value); var v = $('cr-vdr'); if (v) v.textContent = S.st.dr.toFixed(1) + 'x'; save(); }
            if (e.target.id === 'cr-szr') { S.st.zr = parseFloat(e.target.value); var v2 = $('cr-vzr'); if (v2) v2.textContent = S.st.zr.toFixed(1) + 'x'; save(); }
        });
        document.addEventListener('click', function (e) { if (!e.target.closest('.cr-tip') && !e.target.closest('.cr-w')) hideTip(); });
        document.addEventListener('keydown', function (e) {
            var r = $('cr-root'); if (!r || !r.classList.contains('cr-open')) return;
            var vr = $('cr-vr'); if (!vr || !vr.classList.contains('on')) return;
            var tag = e.target.tagName; if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            if (e.code === 'Space') { e.preventDefault(); togP(); }
            if (e.key === 'ArrowLeft') { e.preventDefault(); navS(-1); }
            if (e.key === 'ArrowRight') { e.preventDefault(); navS(1); }
            if (e.key === 'Escape') { e.preventDefault(); goL(); }
        });
        window.addEventListener('resize', function () {
            var fab = $('cr-fab'); if (!fab) return;
            var x = parseInt(fab.style.left), y = parseInt(fab.style.top);
            fab.style.left = Math.max(0, Math.min(window.innerWidth - 56, x)) + 'px';
            fab.style.top = Math.max(0, Math.min(window.innerHeight - 56, y)) + 'px';
        });
    }

    jQuery(async function () { load(); createUI(); bind(); initV(); console.log('[ChatReader] v4 loaded'); });
})();
