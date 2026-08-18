/* 手机工作媒介 前端逻辑 */
(function () {
  'use strict';

  var API = ''; // 与桥接服务同源
  var TOKEN = '';
  try {
    var _q = new URLSearchParams(location.search);
    TOKEN = _q.get('token') || '';
  } catch (e) {}
  function url(p) {
    return API + p + (TOKEN ? (p.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN) : '');
  }
  var currentSessionId = null;
  var pendingFiles = [];
  var streaming = false;
  var themes = ['premium-black', 'frosted-glass', 'dreamy-gradient', 'forest-green', 'ice-jelly', 'milk-tea', 'pixel'];
  var currentTheme = 'premium-black';
  function avatarSrc() {
    return currentTheme === 'pixel' ? 'assets/pixel-whale.png' : 'assets/avatar.png';
  }

  // 界面偏好（本地持久化）
  var prefs = { glass: 60, bgGlass: 50, bg: true, bgPreset: 'auto', flourish: true };

  // ---------- 工具 ----------
  function $(s) { return document.querySelector(s); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    var hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    if (sameDay) return hm;
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
  }
  function fmtSize(n) {
    if (n == null) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 内联 SVG 图标（替代 emoji）
  var ICONS = {
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l2.2-3.7A8.5 8.5 0 1 1 21 11.5Z"/></svg>',
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg>',
    doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7l-5-5Z"/><path d="M14 2v5h5"/><path d="M9 13h6M9 17h4"/></svg>',
    img: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M3.5 18l5-5 3.5 3.5 3-3 5.5 5"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7l-5-5Z"/><path d="M14 2v5h5"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 11l5 5 5-5"/><path d="M4 20h16"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
    clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 12.5l7-7a3 3 0 0 1 4.2 4.2l-9 9a5 5 0 0 1-7-7l9-9"/></svg>'
  };
  function iconEl(cls, name) {
    var e = document.createElement('span');
    if (cls) e.className = cls;
    e.innerHTML = ICONS[name] || '';
    return e;
  }

  // Markdown 轻渲染：粗体/行内码/换行/代码块
  function renderMd(text) {
    var blocks = [];
    var lines = text.split('\n');
    var inCode = false, buf = [];
    function flushBuf() {
      if (buf.length) { blocks.push('<pre>' + esc(buf.join('\n')) + '</pre>'); buf = []; }
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.trim().startsWith('```')) { inCode = !inCode; flushBuf(); continue; }
      if (inCode) { buf.push(line); continue; }
      flushBuf();
      var p = esc(line);
      p = p.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      p = p.replace(/`([^`]+)`/g, '<code>$1</code>');
      blocks.push(p);
    }
    flushBuf();
    return blocks.join('\n');
  }

  // ---------- 消息渲染 ----------
  var chatList = $('#chatList');
  var chatScroll = $('#chatScroll');
  var welcome = $('#welcome');

  // 状态行（错误/警告/提示）：仿正式版 turn-error 行，
  // 无论本轮是否已有内容都渲染，绝不让回答区一片空白。
  // kind: 'error' | 'warn' | 'info'
  function addStatusRow(kind, message, code) {
    if (welcome) { welcome.remove(); welcome = null; }
    var wrap = el('div', 'msg ai status-msg');
    var av = el('span', 'msg-avatar');
    av.innerHTML = '<img src="' + avatarSrc() + '" alt="">';
    wrap.appendChild(av);
    var main = el('div', 'msg-main');
    var row = el('div', 'status-row ' + kind);
    var dot = el('span', 'status-dot');
    var copy = el('div', 'status-copy');
    var title = el('span', 'status-title',
      kind === 'error' ? '本轮回答失败' : kind === 'warn' ? '提示' : '消息');
    copy.appendChild(title);
    copy.appendChild(el('span', 'status-message', message || ''));
    row.appendChild(dot);
    row.appendChild(copy);
    if (code) row.appendChild(el('code', 'status-code', code));
    main.appendChild(row);
    wrap.appendChild(main);
    chatList.appendChild(wrap);
    scrollBottom();
    return wrap;
  }

  // ---------- 问题确认卡片（复刻正式版 ask_user_question 环节）----------
  // 智能体有不清楚的地方时，会通过 mux 流推送问题给前端，这里渲染成可交互卡片。
  var currentQuestion = null; // { wrap, rpcId, sessionId, questions }

  function renderQuestionCard(evt) {
    if (welcome) { welcome.remove(); welcome = null; }
    // 若已有问题卡片先收起（同轮多问）
    if (currentQuestion) { currentQuestion.wrap.remove(); currentQuestion = null; }

    var questions = evt.questions || [];
    var wrap = el('div', 'msg ai');
    var av = el('span', 'msg-avatar');
    av.innerHTML = '<img src="' + avatarSrc() + '" alt="">';
    wrap.appendChild(av);
    var main = el('div', 'msg-main');
    var card = el('div', 'question-card');
    card.innerHTML = '';
    card.appendChild(el('div', 'q-card-title', '🤔 需要你确认一下'));

    var answers = []; // { id, selected:[], custom:'' }

    questions.forEach(function (q, qi) {
      var qWrap = el('div', 'q-item');
      var head = el('div', 'q-head');
      if (q.header) head.appendChild(el('span', 'q-header', q.header));
      head.appendChild(el('div', 'q-question', q.question || '（无问题内容）'));
      qWrap.appendChild(head);

      var sel = [];
      var customInput = null;
      answers.push({ id: q.id, selected: sel, custom: '' });

      var opts = el('div', 'q-options');
      (q.options || []).forEach(function (opt) {
        var label = opt.label || '';
        var isRec = /\(?Recommended\)?/i.test(label) || /（推荐）/.test(label);
        var o = el('div', 'q-option' + (isRec ? ' rec' : ''));
        var dot = el('span', 'q-radio');
        var txt = el('span', 'q-opt-label', label);
        o.appendChild(dot);
        o.appendChild(txt);
        o.onclick = function () {
          if (q.multiSelect) {
            var idx = sel.indexOf(label);
            if (idx >= 0) { sel.splice(idx, 1); o.classList.remove('sel'); }
            else { sel.push(label); o.classList.add('sel'); }
          } else {
            sel.length = 0; sel.push(label);
            qWrap.querySelectorAll('.q-option').forEach(function (x) { x.classList.remove('sel'); });
            o.classList.add('sel');
          }
        };
        opts.appendChild(o);
      });
      qWrap.appendChild(opts);

      // 自定义输入（单选时允许"其他"；多选也可补充说明）
      if (q.multiSelect || true) {
        var inp = el('input', 'q-input');
        inp.type = 'text';
        inp.placeholder = q.multiSelect ? '补充说明（可选）' : '或输入自定义答案（可选）';
        inp.oninput = function () {
          answers[qi].custom = this.value.trim();
        };
        qWrap.appendChild(inp);
      }
      card.appendChild(qWrap);
    });

    var btnRow = el('div', 'q-btns');
    var confirm = el('button', 'q-btn primary', '提交回答');
    confirm.disabled = false;
    confirm.onclick = function () {
      confirm.disabled = true;
      confirm.textContent = '提交中…';
      submitQuestion(evt.rpcId, evt.sessionId, answers)
        .catch(function (e) { confirm.disabled = false; confirm.textContent = '提交回答'; toast('提交失败：' + e.message); });
    };
    btnRow.appendChild(confirm);
    card.appendChild(btnRow);

    main.appendChild(card);
    wrap.appendChild(main);
    chatList.appendChild(wrap);
    scrollBottom();

    currentQuestion = { wrap: wrap, rpcId: evt.rpcId, sessionId: evt.sessionId, questions: questions };
    return wrap;
  }

  function submitQuestion(rpcId, sessionId, answers) {
    // 空答案也允许提交（用户可能就想让智能体自己判断）——传 selected=[] 即可
    var clean = answers.map(function (a) {
      var o = { id: a.id, selected: a.selected || [] };
      if (a.custom) o.custom = a.custom;
      return o;
    });
    return fetch(url('/api/chat/respond'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionId, rpcId: rpcId, answer: { answers: clean } })
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (d) { throw new Error(d.error || 'HTTP ' + r.status); });
      return r.json();
    }).then(function (res) {
      if (!res.ok) throw new Error(res.error || '未接受');
      // 回答成功后：标记卡片已回答，并追加一行用户答案回显
      if (currentQuestion) {
        var card = currentQuestion.wrap;
        card.classList.add('answered');
        var echo = el('div', 'q-echo', '✔ 已提交回答');
        card.querySelector('.question-card').appendChild(echo);
        currentQuestion = null;
      }
      scrollBottom();
      toast('已提交回答');
      return res;
    });
  }

  function addBubble(role, html, meta) {
    if (welcome) { welcome.remove(); welcome = null; }
    var wrap = el('div', 'msg ' + (role === 'me' ? 'me' : 'ai'));
    if (role === 'ai') {
      var av = el('span', 'msg-avatar');
      av.innerHTML = '<img src="' + avatarSrc() + '" alt="">';
      wrap.appendChild(av);
    }
    var main = el('div', 'msg-main');
    if (meta) main.appendChild(el('div', 'msg-meta', meta));
    var b = el('div', 'bubble');
    b.innerHTML = html;
    main.appendChild(b);
    if (role === 'ai') {
      var actions = el('div', 'actions');
      var cp = el('button', null, '复制');
      cp.onclick = function () { copyText(b.textContent); };
      actions.appendChild(cp);
      main.appendChild(actions);
    }
    wrap.appendChild(main);
    chatList.appendChild(wrap);
    scrollBottom();
    b._wrap = wrap;
    return b;
  }

  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).catch(function () { fallbackCopy(t); });
    } else fallbackCopy(t);
  }
  function fallbackCopy(t) {
    var ta = el('textarea'); ta.value = t; document.body.appendChild(ta);
    ta.select(); try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
    toast('已复制');
  }

  function scrollBottom(force) {
    requestAnimationFrame(function () {
      chatScroll.scrollTop = chatScroll.scrollHeight;
      updateToTop();
    });
  }
  function updateToTop() {
    var btn = $('#toTop');
    if (!btn) return;
    btn.style.display = chatScroll.scrollTop > 400 ? 'flex' : 'none';
  }

  // ---------- 连接状态 ----------
  function setConn(ok, label) {
    var sub = $('#connState');
    sub.textContent = label || (ok ? '已连接' : '未连接');
    sub.className = 'title-sub' + (ok ? ' ok' : '');
  }
  function checkHealth() {
    apiFetch('/api/health').then(function () { setConn(true); }).catch(function () { setConn(false, '未连接'); });
  }

  // ---------- API ----------
  function apiFetch(p, opts) {
    opts = opts || {};
    return fetch(url(p), opts).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r;
    });
  }

  // ---------- 对话 ----------
  function sendMessage(text) {
    text = (text || '').trim();
    if (!text || streaming) return;
    streaming = true;
    $('#sendBtn').disabled = true;

    addBubble('me', esc(text), '我');

    // 持久打工指示条：整轮生成期间一直显示，完成后移除
    var workingRow = el('div', 'working-row');
    workingRow.innerHTML = '<span class="msg-avatar working"><img src="' + avatarSrc() + '" alt=""></span>'
      + '<span class="working-text">小鲸鱼正在努力搬砖<span class="working-dots"><i></i><i></i><i></i></span></span>';
    chatList.appendChild(workingRow);
    scrollBottom();

    var curBubble = null;
    var body = JSON.stringify({
      message: text,
      sessionId: currentSessionId,
      attachments: pendingFiles
    });
    pendingFiles = [];
    renderAttachmentBar();

    fetch(url('/api/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body
    }).then(function (r) {
      if (!r.ok || !r.body) throw new Error('HTTP ' + r.status);
      return readStream(r.body, function (evt) {
        if (evt.type === 'session') { currentSessionId = evt.sessionId; }
        else if (evt.type === 'question') {
          // 智能体提问确认：渲染问题卡片（会阻塞本轮，等用户回答后继续）
          renderQuestionCard(evt);
        } else if (evt.type === 'question-resolved') {
          // 问题已解决：若有卡片则标记完成
          if (currentQuestion && (!evt.questionRpcId || currentQuestion.rpcId === evt.questionRpcId)) {
            var qc = currentQuestion.wrap;
            if (!qc.classList.contains('answered')) {
              var ec = el('div', 'q-echo',
                evt.outcome === 'cancelled' ? '（该问题已被取消）' : '✔ 已处理');
              var qcard = qc.querySelector('.question-card');
              if (qcard) qcard.appendChild(ec);
            }
            currentQuestion = null;
          }
          scrollBottom();
        }
        else if (evt.type === 'delta') {
          if (!curBubble) { curBubble = addBubble('ai', '', '助手'); curBubble._acc = ''; }
          curBubble._acc += evt.text || '';
          curBubble.innerHTML = renderMd(curBubble._acc) + '<span class="cursor"></span>';
          scrollBottom();
        } else if (evt.type === 'msg-end') {
          // 一条消息完成：用权威全文替换流式预览（避免重复/缺字），下一条消息另起气泡
          if (!curBubble) { curBubble = addBubble('ai', '', '助手'); curBubble._acc = ''; }
          curBubble.innerHTML = renderMd(evt.text || curBubble._acc) || '（无回复）';
          curBubble = null;
          scrollBottom();
        } else if (evt.type === 'done') {
          if (curBubble) { curBubble.innerHTML = renderMd(curBubble._acc) || '（无回复）'; curBubble = null; }
          if (workingRow) workingRow.remove();
          markDone();
          scrollBottom();
        } else if (evt.type === 'error') {
          // 出错：保留已生成的半截内容，再追加一条错误行 —— 无论有没有内容都可见
          if (curBubble) {
            curBubble.innerHTML = renderMd(curBubble._acc) || '（无回复）';
            curBubble = null;
          }
          addStatusRow('error', evt.message || '请稍后重试', evt.code);
          if (workingRow) workingRow.remove();
          scrollBottom();
        } else if (evt.type === 'max-tokens') {
          if (curBubble) { curBubble.innerHTML = renderMd(curBubble._acc) || '（无回复）'; curBubble = null; }
          addStatusRow('warn', '本次回答达到了模型输出上限，可能不完整，可让智能体继续或分段提问。', 'max-tokens');
          if (workingRow) workingRow.remove();
          scrollBottom();
        } else if (evt.type === 'aborted' || evt.type === 'blocked' || evt.type === 'interrupted') {
          if (curBubble) { curBubble.innerHTML = renderMd(curBubble._acc) || '（无回复）'; curBubble = null; }
          addStatusRow('warn',
            evt.type === 'aborted' ? '本轮回答被中止。'
              : evt.type === 'blocked' ? '本轮回答被阻塞。'
                : '本轮回答被中断。',
            evt.type);
          if (workingRow) workingRow.remove();
          scrollBottom();
        }
      });
    }).catch(function (e) {
      // 连接/网络失败：无论是否已有内容，都给出可见提示，不留空白
      if (curBubble) { curBubble.innerHTML = renderMd(curBubble._acc) || '（无回复）'; curBubble = null; }
      addStatusRow('error', '连接失败：' + e.message, 'network');
      if (workingRow) workingRow.remove();
      scrollBottom();
    }).then(function () {
      streaming = false;
      $('#sendBtn').disabled = false;
      scrollBottom();
    });
  }

  // 完成标记：最后一条 AI 气泡的元信息加上可爱的颜文字
  function markDone() {
    var nodes = chatList.querySelectorAll('.msg.ai');
    var last = nodes[nodes.length - 1];
    if (!last) return;
    var meta = last.querySelector('.msg-meta');
    if (meta) meta.innerHTML = '助手 · <span class="done-mark">完成 (๑˃̵ᴗ˂̵)و</span>';
  }

  function readStream(body, onEvent) {
    var reader = body.getReader();
    var decoder = new TextDecoder();
    var buf = '';
    function pump() {
      return reader.read().then(function (r) {
        if (r.done) return;
        buf += decoder.decode(r.value, { stream: true });
        var idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          var chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
          parseSSE(chunk, onEvent);
        }
        return pump();
      });
    }
    return pump();
  }
  function parseSSE(chunk, onEvent) {
    chunk.split('\n').forEach(function (line) {
      if (line.startsWith('data: ')) {
        try { onEvent(JSON.parse(line.slice(6))); } catch (e) {}
      }
    });
  }

  // ---------- 会话历史 ----------
  // 对话页顶部"最近对话"入口：位于欢迎语内，随欢迎语一同出现/消失
  function loadRecentChat() {
    var bar = $('#recentBar');
    if (!bar) return;
    apiFetch('/api/sessions').then(function (r) { return r.json(); }).then(function (sessions) {
      if (!sessions || !sessions.length) return;
      var recent = sessions.slice().sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); })[0];
      $('#recentTitle').textContent = recent.title || '最近对话';
      $('#recentTime').textContent = fmtTime(recent.updatedAt);
      bar.hidden = false;
      bar.onclick = function () { openSession(recent.id); };
    }).catch(function () {});
  }
  function loadSessions() {
    var list = $('#sessionList');
    list.innerHTML = '<div class="skeleton" style="width:80%"></div><div class="skeleton" style="width:60%;margin-top:10px"></div>';
    apiFetch('/api/sessions').then(function (r) { return r.json(); }).then(function (sessions) {
      list.innerHTML = '';
      if (!sessions || !sessions.length) {
        list.appendChild(el('div', 'empty', '暂无历史对话'));
        return;
      }
      sessions.forEach(function (s) {
        var item = el('div', 'list-item');
        item.appendChild(iconEl('item-ico', 'chat'));
        var body = el('div', 'item-body');
        body.appendChild(el('div', 'item-title', s.title || '未命名会话'));
        body.appendChild(el('div', 'item-sub', fmtTime(s.updatedAt) + ' · ' + (s.messageCount || 0) + ' 轮对话'));
        item.appendChild(body);
        item.appendChild(el('div', 'item-right', '打开'));
        item.onclick = function () { openSession(s.id); };
        list.appendChild(item);
      });
    }).catch(function () {
      list.innerHTML = '<div class="empty">加载失败，请检查连接</div>';
    });
  }
  function openSession(id) {
    currentSessionId = id;
    switchTab('chat');
    chatList.innerHTML = '';
    addBubble('ai', '正在加载历史对话…');
    apiFetch('/api/sessions/' + id).then(function (r) { return r.json(); }).then(function (data) {
      chatList.innerHTML = '';
      var msgs = data.messages || [];
      if (!msgs.length) {
        addBubble('ai', '这个会话还没有消息，直接输入即可开始。');
        return;
      }
      msgs.forEach(function (m) {
        addBubble(m.role === 'user' ? 'me' : 'ai', renderMd(m.content || ''), fmtTime(m.timestamp));
      });
      scrollBottom(true); // 直接跳到最新消息，不用往上拉
      toast('已加载 ' + msgs.length + ' 条消息');
    }).catch(function () {
      chatList.innerHTML = '';
      addBubble('ai', '历史加载失败，但你可以直接继续对话。');
    });
  }

  // ---------- 文件树（与实体机目录同步） ----------
  function fileIconName(name) {
    if (/\.(docx?|xlsx?|pptx?|pdf)$/i.test(name)) return 'doc';
    if (/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(name)) return 'img';
    return 'file';
  }
  function renderTreeItem(node, root) {
    var item = el('div', 'tree-item' + (root ? ' open' : ''));
    var row = el('div', 'tree-row');
    var isDir = node.type === 'dir';
    var toggle = el('span', 'tree-toggle' + (isDir ? '' : ' leaf'));
    toggle.innerHTML = ICONS.chevron;
    row.appendChild(toggle);
    var ico = el('span', 'tree-ico' + (isDir ? ' folder' : ''));
    ico.innerHTML = isDir ? ICONS.folder : ICONS[fileIconName(node.name)];
    row.appendChild(ico);
    var body = el('div', 'tree-body');
    body.appendChild(el('div', 'tree-name', node.name));
    var sub = isDir
      ? ((node.children && node.children.length ? node.children.length + ' 项' : '空目录'))
      : fmtSize(node.size) + ' · ' + fmtTime(node.mtime);
    body.appendChild(el('div', 'tree-sub', sub));
    row.appendChild(body);
    if (!isDir) {
      var dl = el('span', 'tree-dl');
      dl.innerHTML = ICONS.download;
      dl.onclick = function (e) { e.stopPropagation(); downloadFile(node.path, node.name); };
      row.appendChild(dl);
      row.onclick = function () { downloadFile(node.path, node.name); };
    }
    item.appendChild(row);
    if (isDir && node.children && node.children.length) {
      var children = el('div', 'tree-children');
      node.children.forEach(function (c) { children.appendChild(renderTreeItem(c, false)); });
      item.appendChild(children);
      row.onclick = function () { item.classList.toggle('open'); };
    }
    return item;
  }
  function loadFiles() {
    var list = $('#fileList');
    list.innerHTML = '<div class="skeleton" style="width:70%"></div>';
    apiFetch('/api/files/tree').then(function (r) { return r.json(); }).then(function (trees) {
      list.innerHTML = '';
      if (!trees || !trees.length) {
        list.appendChild(el('div', 'empty', '暂无产出文件'));
        return;
      }
      var tree = el('div', 'tree');
      trees.forEach(function (root) { tree.appendChild(renderTreeItem(root, true)); });
      list.appendChild(tree);
    }).catch(function () {
      list.innerHTML = '<div class="empty">文件树加载失败</div>';
    });
  }
  function downloadFile(path, name) {
    window.open(url('/api/files/download?path=' + encodeURIComponent(path || name)), '_blank');
  }

  // ---------- 上传 ----------
  function uploadFiles(files) {
    if (!files || !files.length) return;
    Array.prototype.forEach.call(files, function (file) {
      var fd = new FormData();
      fd.append('file', file);
      fetch(url('/api/upload'), { method: 'POST', body: fd })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          pendingFiles.push(res.name || file.name);
          renderAttachmentBar();
          toast('已上传 ' + (res.name || file.name));
        })
        .catch(function () { toast('上传失败：' + file.name); });
    });
  }
  // 上传到文件夹（无需对话，直接存入 uploads 并刷新树）
  function uploadToFolder(files) {
    if (!files || !files.length) return;
    var list = Array.prototype.slice.call(files);
    var left = list.length;
    var btn = $('#uploadBtn');
    if (btn) btn.disabled = true;
    list.forEach(function (file) {
      var fd = new FormData();
      fd.append('file', file);
      fetch(url('/api/upload'), { method: 'POST', body: fd })
        .then(function (r) { return r.json(); })
        .then(function (res) { toast('已上传 ' + (res.name || file.name)); })
        .catch(function () { toast('上传失败：' + file.name); })
        .then(function () {
          left--;
          if (left <= 0) {
            if (btn) btn.disabled = false;
            loadFiles();
          }
        });
    });
  }

  function renderAttachmentBar() {
    var bar = $('#attachBar');
    if (!pendingFiles.length) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = el('div', 'attach-bar');
      bar.id = 'attachBar';
      $('#panel-chat').insertBefore(bar, $('.composer'));
    }
    bar.innerHTML = '';
    pendingFiles.forEach(function (n) {
      var c = el('span', 'attach-chip');
      c.innerHTML = ICONS.clip + esc(n);
      c.onclick = function () { pendingFiles = pendingFiles.filter(function (x) { return x !== n; }); renderAttachmentBar(); };
      bar.appendChild(c);
    });
  }

  // ---------- 模型 ----------
  var modelCache = null; // { current, groups }
  function fetchModels() {
    return apiFetch('/api/models').then(function (r) { return r.json(); }).then(function (data) {
      modelCache = data && data.groups ? data : null;
      return modelCache;
    });
  }
  function loadModels() {
    var list = $('#modelList');
    list.innerHTML = '<div class="skeleton" style="width:60%"></div>';
    fetchModels().then(function (data) {
      list.innerHTML = '';
      if (!data || !data.groups || !data.groups.length) {
        list.appendChild(el('div', 'empty', '暂无模型'));
        return;
      }
      data.groups.forEach(function (g) {
        var title = el('div', 'model-group-title', g.name || g.id);
        list.appendChild(title);
        var group = el('div', 'model-group');
        g.models.forEach(function (m) {
          var item = el('div', 'model-item' + (m.current ? ' current' : ''));
          item.dataset.provider = g.id;
          item.dataset.model = m.id;
          var left = el('div');
          left.appendChild(el('div', 'm-name', m.name || m.id));
          if (m.id !== m.name) left.appendChild(el('div', 'm-sub', m.id));
          item.appendChild(left);
          item.appendChild(el('div', 'dot'));
          item.onclick = function () { switchModel(g.id, m.id); };
          group.appendChild(item);
        });
        list.appendChild(group);
      });
    }).catch(function () { list.innerHTML = '<div class="empty">加载失败</div>'; });
  }
  function switchModel(provider, model) {
    fetch(url('/api/models/switch'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: provider, model: model })
    }).then(function (r) { return r.json(); }).then(function () {
      toast('已切换模型');
      modelCache = null;
      loadModels();
    }).catch(function () { toast('切换失败'); });
  }

  // ---------- 新会话 ----------
  function askNewSession() {
    var mask = $('#confirmMask');
    var dlg = $('#confirmDialog');
    if (!mask || !dlg) return;
    mask.hidden = false; dlg.hidden = false;
    requestAnimationFrame(function () { mask.classList.add('show'); dlg.classList.add('show'); });
  }
  function closeConfirm() {
    var mask = $('#confirmMask');
    var dlg = $('#confirmDialog');
    if (!mask || !dlg) return;
    mask.classList.remove('show'); dlg.classList.remove('show');
    setTimeout(function () { mask.hidden = true; dlg.hidden = true; }, 220);
  }
  function doNewSession() {
    closeConfirm();
    openSetupSheet();
  }
  function actuallyStartNew() {
    // 1) 让桥接创建新 DSH session
    fetch(url('/api/sessions/new'), { method: 'POST' }).catch(function () {});
    // 2) 清前端状态
    currentSessionId = null;
    pendingFiles = [];
    renderAttachmentBar();
    chatList.innerHTML = '';
    // 欢迎语
    var welcome = el('div', 'welcome');
    welcome.id = 'welcome';
    welcome.innerHTML =
      '<div class="welcome-badge" aria-hidden="true"><img src="' + avatarSrc() + '" alt=""></div>'
      + '<div class="welcome-text">大肥鲸摸鱼呢~有啥事快讲 (๑´ㅂ`๑)</div>';
    chatList.appendChild(welcome);
    loadRecentChat();
    switchTab('chat');
    setTimeout(function () { var inp = $('#input'); if (inp) inp.focus(); }, 300);
  }

  // ---------- 新会话前设置面板（模式 + 模型） ----------
  var setupState = { mode: 'chat', provider: '', model: '' };
  function openSetupSheet() {
    var mask = $('#setupMask');
    var sheet = $('#setupSheet');
    if (!mask || !sheet) return;
    setupState = { mode: 'chat', provider: '', model: '' };
    // 模式默认普通对话
    document.querySelectorAll('#modeRow .mode-chip').forEach(function (c) {
      c.classList.toggle('active', c.dataset.mode === 'chat');
    });
    var box = $('#setupModels');
    box.innerHTML = '<div class="skeleton" style="width:70%"></div>';
    mask.hidden = false; sheet.hidden = false;
    requestAnimationFrame(function () { mask.classList.add('show'); sheet.classList.add('show'); });
    fetchModels().then(function (data) {
      box.innerHTML = '';
      if (!data || !data.groups || !data.groups.length) {
        box.appendChild(el('div', 'empty', '暂无可用模型'));
        return;
      }
      // 默认选中当前模型
      if (data.current) {
        setupState.provider = data.current.provider || '';
        setupState.model = data.current.model || '';
      }
      data.groups.forEach(function (g) {
        var gt = el('div', 'setup-group-title', g.name || g.id);
        box.appendChild(gt);
        g.models.forEach(function (m) {
          var item = el('div', 'setup-model');
          item.dataset.provider = g.id;
          item.dataset.model = m.id;
          item.appendChild(el('div', 'sm-name', m.name || m.id));
          item.appendChild(el('div', 'sm-dot'));
          if (g.id === setupState.provider && m.id === setupState.model) item.classList.add('active');
          item.onclick = function () {
            setupState.provider = g.id;
            setupState.model = m.id;
            box.querySelectorAll('.setup-model').forEach(function (x) { x.classList.remove('active'); });
            item.classList.add('active');
            var start = $('#setupStart');
            if (start) start.disabled = false;
          };
          box.appendChild(item);
        });
      });
      var start = $('#setupStart');
      if (start) start.disabled = !(setupState.provider && setupState.model);
    }).catch(function () {
      box.innerHTML = '<div class="empty">模型列表加载失败</div>';
    });
  }
  function closeSetupSheet() {
    var mask = $('#setupMask');
    var sheet = $('#setupSheet');
    if (!mask || !sheet) return;
    mask.classList.remove('show'); sheet.classList.remove('show');
    setTimeout(function () { mask.hidden = true; sheet.hidden = true; }, 280);
  }
  function confirmSetup() {
    if (!setupState.provider || !setupState.model) return;
    // 先切模型，再真正开新会话
    fetch(url('/api/models/switch'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: setupState.provider, model: setupState.model })
    }).then(function (r) { return r.json(); }).catch(function () {}).then(function () {
      closeSetupSheet();
      modelCache = null;
      actuallyStartNew();
    });
  }

  // ---------- 主题 ----------
  var THEME_META = {
    'premium-black': { name: '高级黑', color: '#060708' },
    'frosted-glass': { name: '磨砂玻璃', color: '#0F0F1A' },
    'dreamy-gradient': { name: '梦幻渐变', color: '#0E0818' },
    'forest-green': { name: '清新自然', color: '#0C1812' },
    'ice-jelly': { name: '冰态果冻', color: '#EEF4F8' },
    'milk-tea': { name: '奶茶店', color: '#F5EEE8' },
    'pixel': { name: '像素风', color: '#0F0F1B' },
  };
  function setTheme(t) {
    currentTheme = t;
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('theme', t); } catch (e) {}
    var meta = document.querySelector('meta[name=theme-color]');
    var info = THEME_META[t] || { name: t, color: '#060708' };
    if (meta) meta.setAttribute('content', info.color);
    // 下拉框同步
    var nameEl = $('#themeSelectName');
    if (nameEl) nameEl.textContent = info.name;
    document.querySelectorAll('#themeSelectMenu .select-option').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-theme') === t);
    });
    // 头像跟随风格（像素风 → 像素鲸鱼）
    var src = avatarSrc();
    document.querySelectorAll('.logo img, .drawer-logo img, .welcome-badge img, .msg-avatar img').forEach(function (im) {
      im.src = src;
    });
    applyBg(); // 跟随主题的默认背景
  }

  // ---------- 界面偏好：毛玻璃 / 背景 / 花边 ----------
  function savePrefs() {
    try { localStorage.setItem('wb-prefs', JSON.stringify(prefs)); } catch (e) {}
  }
  function loadPrefs() {
    try {
      var p = JSON.parse(localStorage.getItem('wb-prefs') || '{}');
      if (typeof p.glass === 'number') prefs.glass = p.glass;
      if (typeof p.bgGlass === 'number') prefs.bgGlass = p.bgGlass;
      if (typeof p.bg === 'boolean') prefs.bg = p.bg;
      if (p.bgPreset) prefs.bgPreset = p.bgPreset;
      if (typeof p.flourish === 'boolean') prefs.flourish = p.flourish;
    } catch (e) {}
  }
  function applyGlass() {
    var g = Math.max(0, Math.min(100, prefs.glass));
    document.documentElement.style.setProperty('--glass', (g / 100).toFixed(2));
    var v = $('#glassValue');
    if (v) v.textContent = g + '%';
    var r = $('#glassRange');
    if (r) r.value = g;
  }
  function applyBgGlass() {
    var g = Math.max(0, Math.min(100, prefs.bgGlass));
    document.documentElement.style.setProperty('--bg-glass', (g / 100).toFixed(2));
    var v = $('#bgGlassValue');
    if (v) v.textContent = g + '%';
    var r = $('#bgGlassRange');
    if (r) r.value = g;
  }
  function applyBg() {
    document.body.classList.toggle('bg-off', !prefs.bg);
    var layer = $('#bgLayer');
    if (!layer) return;
    if (prefs.bgPreset === 'day') { layer.classList.add('bg-day'); layer.classList.remove('bg-night'); }
    else if (prefs.bgPreset === 'night') { layer.classList.add('bg-night'); layer.classList.remove('bg-day'); }
    else { layer.classList.remove('bg-day', 'bg-night'); }
    document.querySelectorAll('#bgPresets .bg-preset').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-bg') === prefs.bgPreset);
    });
    var tog = $('#bgToggle');
    if (tog) tog.checked = prefs.bg;
  }
  function applyFlourish() {
    document.body.classList.toggle('flourish-off', !prefs.flourish);
    var tog = $('#flourishToggle');
    if (tog) tog.checked = prefs.flourish;
  }

  // ---------- Tab（抽屉导航） ----------
  function openDrawer() {
    $('#drawer').classList.add('open');
    $('#drawer').setAttribute('aria-hidden', 'false');
  }
  function closeDrawer() {
    $('#drawer').classList.remove('open');
    $('#drawer').setAttribute('aria-hidden', 'true');
  }
  function switchTab(name) {
    document.querySelectorAll('.drawer-item').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === name);
    });
    document.querySelectorAll('.tab-panel').forEach(function (p) {
      p.classList.toggle('active', p.id === 'panel-' + name);
    });
    if (name === 'sessions') loadSessions();
    if (name === 'files') loadFiles();
    if (name === 'settings') loadModels();
    if (name === 'chat') scrollBottom(true);
    closeDrawer();
  }

  // ---------- Toast ----------
  var toastTimer;
  function toast(text) {
    var t = $('#toast');
    if (!t) {
      t = el('div'); t.id = 'toast'; t.className = 'toast';
      document.body.appendChild(t);
    }
    t.textContent = text;
    t.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.style.opacity = '0'; }, 1800);
  }

  // ---------- 事件绑定 ----------
  function bind() {
    // 抽屉
    $('#menuBtn').onclick = openDrawer;
    $('#drawerMask').onclick = closeDrawer;
    // 新会话按钮（顶栏右上角）→ 二次确认 → 设置面板
    var nsb = $('#newSessionBtn');
    if (nsb) nsb.onclick = askNewSession;
    var cOk = $('#confirmOk'); if (cOk) cOk.onclick = doNewSession;
    var cCancel = $('#confirmCancel'); if (cCancel) cCancel.onclick = closeConfirm;
    var cMask = $('#confirmMask'); if (cMask) cMask.onclick = closeConfirm;
    var sCancel = $('#setupCancel'); if (sCancel) sCancel.onclick = closeSetupSheet;
    var sClose = $('#setupClose'); if (sClose) sClose.onclick = closeSetupSheet;
    var sStart = $('#setupStart'); if (sStart) sStart.onclick = confirmSetup;
    var sMask = $('#setupMask'); if (sMask) sMask.onclick = closeSetupSheet;
    document.querySelectorAll('#modeRow .mode-chip').forEach(function (c) {
      c.onclick = function () {
        setupState.mode = c.dataset.mode;
        document.querySelectorAll('#modeRow .mode-chip').forEach(function (x) { x.classList.remove('active'); });
        c.classList.add('active');
      };
    });
    document.querySelectorAll('.drawer-item').forEach(function (b) {
      b.onclick = function () { switchTab(b.getAttribute('data-tab')); };
    });
    // 对话
    $('#sendBtn').onclick = function () { sendMessage($('#input').value); $('#input').value = ''; $('#input').style.height = 'auto'; };
    $('#input').addEventListener('input', function () {
      this.style.height = 'auto'; this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    });
    $('#input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#sendBtn').click(); }
    });
    $('#attachBtn').onclick = function () { $('#fileInput').click(); };
    $('#fileInput').onchange = function () { uploadFiles(this.files); this.value = ''; };
    // 历史 / 文件
    $('#refreshSessions').onclick = loadSessions;
    $('#refreshFiles').onclick = loadFiles;
    $('#uploadBtn').onclick = function () { $('#folderFileInput').click(); };
    $('#folderFileInput').onchange = function () { uploadToFolder(this.files); this.value = ''; };
    // 主题下拉框
    var themeSelect = $('#themeSelect');
    function closeThemeMenu() {
      if (themeSelect) themeSelect.classList.remove('open');
      var menu = $('#themeSelectMenu');
      if (menu) menu.hidden = true;
    }
    $('#themeSelectTrigger').onclick = function (e) {
      e.stopPropagation();
      var menu = $('#themeSelectMenu');
      if (!menu) return;
      menu.hidden = !menu.hidden;
      if (themeSelect) themeSelect.classList.toggle('open', !menu.hidden);
    };
    document.querySelectorAll('#themeSelectMenu .select-option').forEach(function (b) {
      b.onclick = function () {
        setTheme(b.getAttribute('data-theme'));
        closeThemeMenu();
      };
    });
    document.addEventListener('click', closeThemeMenu);
    // 设置：UI 毛玻璃 / 背景毛玻璃 / 背景 / 花边
    $('#glassRange').addEventListener('input', function () {
      prefs.glass = Number(this.value);
      applyGlass(); savePrefs();
    });
    $('#bgGlassRange').addEventListener('input', function () {
      prefs.bgGlass = Number(this.value);
      applyBgGlass(); savePrefs();
    });
    $('#bgToggle').addEventListener('change', function () {
      prefs.bg = this.checked;
      applyBg(); savePrefs();
    });
    document.querySelectorAll('#bgPresets .bg-preset').forEach(function (b) {
      b.onclick = function () {
        prefs.bgPreset = b.getAttribute('data-bg');
        applyBg(); savePrefs();
      };
    });
    $('#flourishToggle').addEventListener('change', function () {
      prefs.flourish = this.checked;
      applyFlourish(); savePrefs();
    });
    // 回顶部按钮
    var toTop = el('div', 'to-top', '↑');
    toTop.id = 'toTop';
    toTop.onclick = function () { chatScroll.scrollTop = 0; };
    $('#panel-chat').appendChild(toTop);
    chatScroll.addEventListener('scroll', updateToTop);
  }

  // ---------- 启动 ----------
  function boot() {
    bind();
    loadPrefs();
    var saved = null; try { saved = localStorage.getItem('theme'); } catch (e) {}
    setTheme(saved && themes.indexOf(saved) >= 0 ? saved : 'premium-black');
    applyGlass();
    applyBgGlass();
    applyBg();
    applyFlourish();
    checkHealth();
    setInterval(checkHealth, 15000);
    loadRecentChat();
    switchTab('chat');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
