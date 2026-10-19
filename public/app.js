/* 鸿德食堂打分工具 — 前端逻辑（零依赖，原生 JS） */
(function () {
  'use strict';

  var API = '';                       // 同源，留空即可；部署时可改绝对地址
  var LS_KEY = 'hd_rate_history_v1';  // 本地兜底防刷记录

  var state = {
    menu: null,
    campusId: null,
    canteenId: '',
    stallId: '',
    dishId: '',
    score: 0,
    submitting: false,
    boardCanteenId: ''
  };

  /* ---------------- 小工具 ---------------- */
  function $(id) { return document.getElementById(id); }

  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  function api(path, options) {
    options = options || {};
    var init = { method: options.method || 'GET', headers: {} };
    if (options.body) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    return fetch(API + path, init).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.error || ('请求失败（HTTP ' + res.status + '）'));
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  /** 演示数据横幅：只在还没有任何真实打分时出现 */
  function showDemoBanner(on) {
    var el = $('demoBanner');
    if (el) el.hidden = !on;
  }

  function refreshDemoBanner() {
    api('/api/stats').then(function (s) {
      showDemoBanner(!!s.isDemoData);
    }).catch(function () { /* 拿不到就不显示，不影响主流程 */ });
  }

  function starsMarkup(avg) {
    var full = Math.round(avg);
    var out = '';
    for (var i = 1; i <= 5; i++) out += i <= full ? '★' : '<span class="off">★</span>';
    return '<span class="stars-inline">' + out + '</span>';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** 价格文案，例如 "13.9元" / "1.78元/50克"；没填就不显示 */
  function priceText(item) {
    if (!item || item.price == null) return '';
    var n = item.price;
    var s = (Math.round(n * 100) % 100 === 0) ? String(Math.round(n)) : String(n);
    return s + (item.unit || '元');
  }

  /** 窗口号文案，例如 "14号窗口 · 花甲粉 · 螺蛳粉" */
  function stallLabel(stall) {
    if (!stall) return '';
    return stall.code ? (stall.code + ' · ' + stall.name) : stall.name;
  }

  /** 下拉框里的档口名（带上窗口号，方便同学照着找） */
  function stallOptionName(stall) {
    return stall.code ? (stall.code + ' ' + stall.name) : stall.name;
  }

  /** 下拉框里的菜品名（带上价格） */
  function dishOptionName(dish) {
    var p = priceText(dish);
    return p ? (dish.name + '　' + p) : dish.name;
  }

  function fillSelect(sel, items, placeholder, selectedId, labelFn) {
    sel.innerHTML = '';
    if (placeholder) {
      var o = document.createElement('option');
      o.value = ''; o.textContent = placeholder;
      sel.appendChild(o);
    }
    items.forEach(function (it) {
      var o = document.createElement('option');
      o.value = it.id;
      o.textContent = labelFn ? labelFn(it) : it.name;
      sel.appendChild(o);
    });
    sel.value = selectedId || '';
  }

  /* ---------------- 菜单联动 ---------------- */
  function stallsOf(canteenId) {
    return state.menu.stalls.filter(function (s) { return s.canteenId === canteenId; });
  }
  function dishesOf(stallId) {
    return state.menu.dishes.filter(function (d) { return d.stallId === stallId; });
  }
  function findStall(id) {
    return state.menu.stalls.filter(function (s) { return s.id === id; })[0] || null;
  }
  function findDish(id) {
    return state.menu.dishes.filter(function (d) { return d.id === id; })[0] || null;
  }
  function findCanteen(id) {
    return state.menu.canteens.filter(function (c) { return c.id === id; })[0] || null;
  }

  /** 这家店是不是"就一个菜单"（是的话页面自动跳过选档口这一步） */
  function isSingleMenu(canteenId) {
    var c = findCanteen(canteenId);
    if (c && c.stallMode) return c.stallMode === 'single-menu';
    // 没标 stallMode 的老数据：只有一个档口就当成一个菜单
    return canteenId ? stallsOf(canteenId).length <= 1 : false;
  }

  /** 选食堂 → 刷新档口，清空菜品 */
  function onCanteenChange(id) {
    state.canteenId = id;
    state.stallId = '';
    state.dishId = '';
    var selStall = $('selStall'), selDish = $('selDish');
    var stallField = $('stallField');
    var single = isSingleMenu(id);

    // 一家店的：藏掉「选档口」，自动帮同学选好，少点一次
    stallField.hidden = single;

    if (!id) {
      fillSelect(selStall, [], '请先选食堂', '');
      selStall.disabled = true;
      fillSelect(selDish, [], '请先选档口', '');
      selDish.disabled = true;
    } else if (single) {
      var only = stallsOf(id)[0];
      fillSelect(selStall, only ? [only] : [], '', only ? only.id : '');
      selStall.disabled = true;
      state.stallId = only ? only.id : '';
      if (only) {
        fillSelect(selDish, dishesOf(only.id), '请选择菜品', '', dishOptionName);
        selDish.disabled = false;
      } else {
        fillSelect(selDish, [], '这家店还没有菜品', '');
        selDish.disabled = true;
      }
    } else {
      fillSelect(selStall, stallsOf(id), '请选择窗口', '', stallOptionName);
      selStall.disabled = false;
      fillSelect(selDish, [], '请先选窗口', '');
      selDish.disabled = true;
    }
    updateSteps();
    updateSubmitState();
  }

  /** 选档口 → 刷新菜品 */
  function onStallChange(id) {
    state.stallId = id;
    state.dishId = '';
    var selDish = $('selDish');
    if (!id) {
      fillSelect(selDish, [], '请先选窗口', '');
      selDish.disabled = true;
    } else {
      fillSelect(selDish, dishesOf(id), '请选择菜品', '', dishOptionName);
      selDish.disabled = false;
    }
    updateSteps();
    updateSubmitState();
  }

  /** 选菜品 */
  function onDishChange(id) {
    state.dishId = id;
    var dish = findDish(id);
    var stall = dish ? findStall(dish.stallId) : null;
    var p = priceText(dish);

    $('rateDishName').textContent = dish ? (dish.name + (p ? '　' + p : '')) : '还没选菜品';
    $('rateDishHint').textContent = dish
      ? (stallLabel(stall) + ' · 给它打个分吧')
      : '选择菜品后给它打个分吧';

    // 本地兜底：同一天同一道菜只允许投一次
    if (dish && isRatedLocally(dish.id)) {
      $('rateDishHint').textContent = stallLabel(stall) + ' · 你今天已经给这道菜打过分了';
      $('formMsg').className = 'form-msg err';
      $('formMsg').textContent = '同一道菜每天只能打一次分，明天再来～';
    } else if (dish) {
      $('formMsg').textContent = '';
      $('formMsg').className = 'form-msg';
    }
    updateSteps();
    updateSubmitState();
  }

  /**
   * 更新顶部 4 个步骤指示灯。
   * 一家店的（single-menu）会把「选档口」那步隐藏起来，
   * 同学看到的就只有 3 步：选食堂 → 选菜品 → 打星提交。
   */
  function updateSteps() {
    var single = isSingleMenu(state.canteenId);
    var s1 = $('st1'), s2 = $('st2'), s3 = $('st3'), s4 = $('st4');
    s2.hidden = single;
    if (single) {
      s1.className = 'step' + (state.dishId ? ' is-done' : (state.canteenId ? ' is-on' : ''));
      s3.className = 'step' + (state.score ? ' is-done' : (state.dishId ? ' is-on' : ''));
      s4.className = 'step' + (state.score ? ' is-on' : '');
      return;
    }
    s1.className = 'step' + (state.stallId ? ' is-done' : (state.canteenId ? ' is-on' : ''));
    s2.className = 'step' + (state.dishId ? ' is-done' : (state.stallId ? ' is-on' : ''));
    s3.className = 'step' + (state.score ? ' is-done' : (state.dishId ? ' is-on' : ''));
    s4.className = 'step' + (state.score ? ' is-on' : '');
  }

  function updateSubmitState() {
    var btn = $('btnSubmit');
    var ready = !!(state.canteenId && state.stallId && state.dishId && state.score) && !state.submitting;
    btn.disabled = !ready;
  }

  /* ---------------- 星星 ---------------- */
  var SCORE_TEXT = ['点击星星打分', '1分 · 踩雷了', '2分 · 不太行', '3分 · 一般般', '4分 · 挺好吃', '5分 · 强烈推荐'];

  function paintStars(n) {
    var stars = $('stars').children;
    for (var i = 0; i < stars.length; i++) {
      stars[i].classList.toggle('on', (i + 1) <= n);
    }
    $('scoreText').textContent = SCORE_TEXT[n] || SCORE_TEXT[0];
  }

  function bindStars() {
    var box = $('stars');
    // 用事件委托 + 触摸起点，保证手机上点一下就有反应
    function hit(e) {
      var el = e.target.closest ? e.target.closest('.star') : null;
      if (!el) return;
      var n = parseInt(el.getAttribute('data-score'), 10);
      state.score = n;
      paintStars(n);
      updateSteps();
      updateSubmitState();
      var msg = $('formMsg');
      if (msg && !msg.textContent) msg.className = 'form-msg';
    }
    box.addEventListener('click', hit);
    box.addEventListener('touchstart', function (e) {
      var el = e.target.closest ? e.target.closest('.star') : null;
      if (el) el.classList.add('press');
    }, { passive: true });
    box.addEventListener('touchend', function (e) {
      var el = e.target.closest ? e.target.closest('.star') : null;
      if (el) el.classList.remove('press');
    }, { passive: true });
  }

  /* ---------------- 快捷评价词 ---------------- */
  function bindChips() {
    var box = $('quickComments');
    box.addEventListener('click', function (e) {
      var chip = e.target.closest ? e.target.closest('.chip') : null;
      if (!chip) return;
      var on = chip.classList.toggle('on');
      var input = $('commentInput');
      var words = Array.prototype.slice.call(box.querySelectorAll('.chip.on'))
        .map(function (c) { return c.getAttribute('data-c'); });
      // 快捷词是"补充"，用户手写的内容优先保留
      var handwritten = input.value.replace(/\s/g, '');
      var joined = words.join('、');
      input.value = (handwritten && words.length === 0) ? handwritten : joined;
      if (!on && words.length === 0) input.value = '';
    });
  }

  /* ---------------- 本地防刷记录 ---------------- */
  function today() {
    var d = new Date();
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + mm + '-' + dd;
  }
  function localHistory() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function isRatedLocally(dishId) {
    var h = localHistory();
    return !!(h[today()] && h[today()][dishId]);
  }
  function markRatedLocally(dishId) {
    try {
      var h = localHistory();
      // 只保留今天，避免越攒越多
      h = {}; h[today()] = {}; h[today()][dishId] = 1;
      localStorage.setItem(LS_KEY, JSON.stringify(h));
      localStorage.setItem('hd_has_rated', '1');   // 已投过票 -> 不再显示演示数据横幅
    } catch (e) { /* 隐私模式下忽略 */ }
  }

  /* ---------------- 提交打分 ---------------- */
  function submit() {
    if (state.submitting) return;
    if (!(state.canteenId && state.stallId && state.dishId && state.score)) return;

    if (isRatedLocally(state.dishId)) {
      $('formMsg').className = 'form-msg err';
      $('formMsg').textContent = '同一道菜每天只能打一次分，明天再来～';
      return;
    }

    state.submitting = true;
    updateSubmitState();
    var msg = $('formMsg');
    msg.className = 'form-msg';
    msg.textContent = '提交中…';

    api('/api/rate', {
      method: 'POST',
      body: {
        dishId: state.dishId,
        score: state.score,
        comment: ($('commentInput').value || '').trim().slice(0, 30)
      }
    }).then(function (data) {
      state.submitting = false;
      markRatedLocally(state.dishId);
      msg.className = 'form-msg ok';
      msg.textContent = '✓ 打分成功，感谢你帮同学避雷！（当前均分 '
        + (data && data.dishAverage != null ? data.dishAverage : '—') + '）';
      toast('打分成功，榜单已更新');
      showDemoBanner(false);   // 已经有真实数据了，演示提示立刻收起

      // 重置评分区，方便继续给下一道菜打分
      state.score = 0;
      paintStars(0);
      Array.prototype.forEach.call($('quickComments').querySelectorAll('.chip.on'), function (c) {
        c.classList.remove('on');
      });
      $('commentInput').value = '';
      updateSteps();
      updateSubmitState();
      refreshBoards();
    }).catch(function (err) {
      state.submitting = false;
      updateSubmitState();
      msg.className = 'form-msg err';
      msg.textContent = err.status === 409
        ? '你今天已经给这道菜打过分了，明天再来～'
        : ('提交失败：' + err.message + '（请检查网络后重试）');
      if (err.status === 409) markRatedLocally(state.dishId);
    });
  }

  /* ---------------- 问题反馈（同学只提交，改不了数据） ---------------- */
  /**
   * 为什么这么设计：菜单是拍照识别的，一定有错。但同学要是能直接改数据，
   * 榜单就谁都能篡改了。所以这里只做"收集意见"——提交给我，我核对后改菜单。
   */
  var fb = { open: false, kind: '', kinds: [] };

  /** 打开反馈弹层，自动带上当前选中的菜品 */
  function openFeedback() {
    var dish = state.dishId ? findDish(state.dishId) : null;
    var stall = dish ? findStall(dish.stallId) : null;
    var p = priceText(dish);

    fb.open = true;
    $('fbMask').hidden = false;
    $('fbDishLine').textContent = dish
      ? ('这道菜：' + (stall ? stallLabel(stall) + ' · ' : '') + dish.name + (p ? '　' + p : ''))
      : '还没选菜品 —— 可以先在上面选好哪道菜，或者直接写清楚是哪家哪个菜';

    // 没选菜时，"还有菜没录进来"和"其他问题"照样能报
    $('fbMsg').textContent = '';
    $('fbMsg').className = 'form-msg';
    $('fbSubmit').disabled = false;
    paintKinds();
    // 手机上弹出键盘会挡住按钮，所以不自动聚焦，让同学先看清选项
  }

  function closeFeedback() {
    fb.open = false;
    $('fbMask').hidden = true;
    $('fbText').value = '';
    $('fbCount').textContent = '0';
    fb.kind = '';
    $('fbMsg').textContent = '';
    $('fbMsg').className = 'form-msg';
  }

  /** 渲染问题类型按钮（文案由后端给，只维护一份） */
  function paintKinds() {
    var box = $('fbKinds');
    box.innerHTML = '';
    fb.kinds.forEach(function (k) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'fb-kind' + (fb.kind === k.key ? ' on' : '');
      b.setAttribute('data-kind', k.key);
      b.textContent = k.text;
      box.appendChild(b);
    });
  }

  function bindFeedback() {
    $('btnFeedback').addEventListener('click', openFeedback);
    $('fbClose').addEventListener('click', closeFeedback);
    // 点遮罩空白处也能关（手机上很自然的手势）
    $('fbMask').addEventListener('click', function (e) {
      if (e.target === $('fbMask')) closeFeedback();
    });

    $('fbKinds').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.fb-kind') : null;
      if (!b) return;
      fb.kind = b.getAttribute('data-kind');
      paintKinds();
      $('fbMsg').textContent = '';
      $('fbMsg').className = 'form-msg';
    });

    $('fbText').addEventListener('input', function () {
      $('fbCount').textContent = String(this.value.length);
    });

    $('fbSubmit').addEventListener('click', submitFeedback);
  }

  function submitFeedback() {
    if (!fb.kind) {
      $('fbMsg').className = 'form-msg err';
      $('fbMsg').textContent = '请先选一下哪里不对';
      return;
    }
    var text = ($('fbText').value || '').trim();
    if (!text) {
      $('fbMsg').className = 'form-msg err';
      $('fbMsg').textContent = '请简单写一句哪里不对（比如"实际卖 12 元"）';
      return;
    }

    var btn = $('fbSubmit');
    btn.disabled = true;
    $('fbMsg').className = 'form-msg';
    $('fbMsg').textContent = '提交中…';

    api('/api/feedback', {
      method: 'POST',
      body: { kind: fb.kind, dishId: state.dishId || '', text: text }
    }).then(function (data) {
      btn.disabled = false;
      $('fbMsg').className = 'form-msg ok';
      $('fbMsg').textContent = '✓ ' + (data.message || '收到！');
      toast('已提交，谢谢反馈');
      setTimeout(closeFeedback, 1600);
    }).catch(function (err) {
      btn.disabled = false;
      $('fbMsg').className = 'form-msg err';
      $('fbMsg').textContent = err.status === 429
        ? err.message
        : ('提交失败：' + err.message);
    });
  }

  /** 拉一次类型列表（后端改文案，前端不用动） */
  function loadFeedbackKinds() {
    api('/api/feedback/kinds').then(function (data) {
      fb.kinds = (data && data.kinds) || [];
      paintKinds();
    }).catch(function () {
      // 拿不到就用一套兜底文案，不能让按钮点开是空的
      fb.kinds = [
        { key: 'price', text: '价格不对' },
        { key: 'name', text: '菜名写错了' },
        { key: 'extra', text: '这家没这道菜' },
        { key: 'missing', text: '还有菜没录进来' },
        { key: 'stall', text: '档口/窗口写错了' },
        { key: 'other', text: '其他问题' }
      ];
      paintKinds();
    });
  }

  /* ---------------- 榜单渲染 ---------------- */
  function refreshBoards() {
    loadCanteenBoard();
    loadAllBoard();
  }

  function loadCanteenBoard() {
    var box = $('canteenBoard');
    var cid = state.boardCanteenId || state.menu.canteens[0].id;
    state.boardCanteenId = cid;
    $('selCanteenBoard').value = cid;
    box.innerHTML = '<div class="empty">榜单加载中…</div>';

    api('/api/board/canteen?canteenId=' + encodeURIComponent(cid) + '&t=' + Date.now())
      .then(function (data) { renderCanteenBoard(data); })
      .catch(function (err) {
        box.innerHTML = '<div class="empty">榜单加载失败<br>' + esc(err.message) + '</div>';
      });
  }

  function renderCanteenBoard(data) {
    var box = $('canteenBoard');
    var html = '';
    var demoNote = data.isDemoData ? '（演示数据）' : '';

    html += '<div class="canteen-hero"><div class="t">' + esc(data.canteenName)
      + (data.canteenAverage != null ? '　均分 ' + data.canteenAverage : '')
      + '</div><div class="s">按档口下所有菜品的平均分排名 · 至少 '
      + data.minVotes + ' 人打分才进榜' + demoNote + '</div></div>';

    if (!data.stalls.length) {
      html += '<div class="empty">这个食堂还没有菜品进榜<br>快去<b>我要打分</b>给它投第一票吧';
      // 有打分但还没攒够人时，明确告诉同学还差几票，激励投票
      if (data.pending && data.pending.length) {
        html += '<div style="margin-top:14px;text-align:left">';
        data.pending.slice(0, 5).forEach(function (p) {
          html += '<div class="row" style="border:0;padding:8px 2px">'
            + '<div class="row-main"><div class="row-name" style="font-size:14px;font-weight:400">'
            + esc(p.dishName) + '</div></div>'
            + '<div class="row-score"><span>还差 ' + (data.minVotes - p.votes) + ' 人</span></div>'
            + '</div>';
        });
        html += '</div>';
      }
      html += '</div>';
    } else {
      html += '<div class="board-head">本食堂档口榜<small>共 ' + data.stalls.length + ' 家进榜</small></div>';
      data.stalls.forEach(function (s, i) {
        var rankCls = i === 0 ? ' r1' : i === 1 ? ' r2' : i === 2 ? ' r3' : '';
        html += '<div class="row">'
          + '<div class="rank' + rankCls + '">' + (i + 1) + '</div>'
          + '<div class="row-main">'
          + '<div class="row-name">' + esc(stallLabel(s)) + '</div>'
          + '<div class="row-meta">' + starsMarkup(s.average) + '　' + s.qualifiedDishes
          + ' 道菜进榜 · 共 ' + s.votes + ' 人打分</div>'
          + '</div>'
          + '<div class="row-score"><b>' + s.average.toFixed(1) + '</b><span>均分</span></div>'
          + '</div>';

        // 档口详情：他家菜品排行（这属于"对应档口的详情页"）
        if (s.dishes.length) {
          s.dishes.forEach(function (d, j) {
            var p = priceText(d);
            html += '<div class="row" style="padding-left:44px;background:#fcfcfc">'
              + '<div class="rank" style="background:transparent;color:#c0c0c0;font-weight:400">'
              + (j + 1) + '</div>'
              + '<div class="row-main"><div class="row-name" style="font-size:15px;font-weight:400">'
              + esc(d.dishName) + (p ? '　<span style="color:#999;font-size:13px">' + p + '</span>' : '')
              + '</div>'
              + '<div class="row-meta">' + starsMarkup(d.average) + '　' + d.votes + ' 人打分</div></div>'
              + '<div class="row-score"><b style="font-size:16px">' + d.average.toFixed(1) + '</b></div>'
              + '</div>';
          });
        }
      });
    }
    box.innerHTML = html;
  }

  function loadAllBoard() {
    var box = $('allBoard');
    box.innerHTML = '<div class="empty">榜单加载中…</div>';
    api('/api/board/all?limit=20&t=' + Date.now())
      .then(function (data) { renderAllBoard(data); })
      .catch(function (err) {
        box.innerHTML = '<div class="empty">榜单加载失败<br>' + esc(err.message) + '</div>';
      });
  }

  function renderAllBoard(data) {
    var box = $('allBoard');
    $('allSub').textContent = data.campusName + '全部食堂混排 · 至少 ' + data.minVotes
      + ' 人打分才进榜' + (data.isDemoData ? '　（演示数据）' : '');
    if (!data.dishes.length) {
      box.innerHTML = '<div class="empty">还没有菜品满足 <b>' + data.minVotes
        + ' 人打分</b> 的门槛<br>快去<b>我要打分</b>贡献第一票吧</div>';
      return;
    }
    var html = '<div class="board-head">鸿德必吃 Top' + data.dishes.length
      + '<small>已排除打分人数不足的菜品</small></div>';
    data.dishes.forEach(function (d, i) {
      var rankCls = i === 0 ? ' r1' : i === 1 ? ' r2' : i === 2 ? ' r3' : '';
      var p = priceText(d);
      var where = esc(d.canteenName) + (d.stallCode ? ' ' + esc(d.stallCode) : '') + ' · ' + esc(d.stallName);
      html += '<div class="row">'
        + '<div class="rank' + rankCls + '">' + (i + 1) + '</div>'
        + '<div class="row-main">'
        + '<div class="row-name">' + esc(d.dishName)
        + (p ? '　<span style="color:#999;font-size:13px;font-weight:400">' + p + '</span>' : '')
        + '</div>'
        + '<div class="row-meta">' + where + '　' + d.votes + ' 人打分</div>'
        + '</div>'
        + '<div class="row-score"><b>' + d.average.toFixed(1) + '</b><span>' + starsMarkup(d.average).replace(/<[^>]+>/g, '') + '</span></div>'
        + '</div>';
    });
    // 食堂小榜附在末尾，方便一眼看"哪个食堂值得去"
    if (data.canteens && data.canteens.length) {
      html += '<div class="board-head" style="border-top:1px solid var(--line)">主校区食堂榜'
        + '<small>按食堂所有档口平均分</small></div>';
      data.canteens.forEach(function (c, i) {
        var rankCls = i === 0 ? ' r1' : i === 1 ? ' r2' : i === 2 ? ' r3' : '';
        html += '<div class="row">'
          + '<div class="rank' + rankCls + '">' + (i + 1) + '</div>'
          + '<div class="row-main"><div class="row-name">' + esc(c.canteenName) + '</div>'
          + '<div class="row-meta">' + c.stallCount + ' 家档口进榜 · 共 ' + c.votes + ' 人打分</div></div>'
          + '<div class="row-score"><b>' + c.average.toFixed(1) + '</b><span>均分</span></div>'
          + '</div>';
      });
    }
    box.innerHTML = html;
  }

  /* ---------------- Tab 切换 ---------------- */
  function switchTab(name) {
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.classList.toggle('is-active', t.getAttribute('data-tab') === name);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.screen'), function (s) {
      s.classList.toggle('is-active', s.id === 'screen-' + name);
    });
    window.scrollTo(0, 0);
    if (name === 'canteen') loadCanteenBoard();
    if (name === 'all') loadAllBoard();
    refreshDemoBanner();
  }

  function bindTabs() {
    document.querySelector('.tabbar').addEventListener('click', function (e) {
      var tab = e.target.closest ? e.target.closest('.tab') : null;
      if (tab) switchTab(tab.getAttribute('data-tab'));
    });
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    api('/api/menu').then(function (menu) {
      state.menu = menu;

      // 校区：默认锁主校区（一期只有主校区，所以不占用点击次数）
      var active = menu.campuses.filter(function (c) { return c.active; })[0] || menu.campuses[0];
      state.campusId = active.id;
      $('topbarSub').textContent = active.name + '　·　' + menu.canteens.length + ' 个食堂';

      // 为了"3次点击打完分"，食堂只有一个时直接预选好
      var canChangeCanteen = menu.canteens.length > 1;
      fillSelect($('selCanteen'), menu.canteens, canChangeCanteen ? '请选择食堂' : '', canChangeCanteen ? '' : menu.canteens[0].id);
      $('selCanteen').disabled = !canChangeCanteen;
      state.canteenId = canChangeCanteen ? '' : menu.canteens[0].id;
      if (state.canteenId) onCanteenChange(state.canteenId);

      fillSelect($('selCanteenBoard'), menu.canteens, '', menu.canteens[0].id);
      state.boardCanteenId = menu.canteens[0].id;

      $('selCanteen').addEventListener('change', function () { onCanteenChange(this.value); });
      $('selStall').addEventListener('change', function () { onStallChange(this.value); });
      $('selDish').addEventListener('change', function () { onDishChange(this.value); });
      $('selCanteenBoard').addEventListener('change', function () {
        state.boardCanteenId = this.value;
        loadCanteenBoard();
      });
      $('btnSubmit').addEventListener('click', submit);

      bindStars();
      bindChips();
      bindTabs();
      bindFeedback();
      loadFeedbackKinds();
      paintStars(0);

      // 菜单接口里就带了这个标记，省一次请求
      showDemoBanner(!!menu.isDemoData && !localStorage.getItem('hd_has_rated'));

      loadCanteenBoard();
      loadAllBoard();
    }).catch(function (err) {
      $('main').innerHTML = '<div class="card"><div class="empty">页面初始化失败<br>'
        + esc(err.message) + '<br><br>请确认本地服务已启动（node server/local.js）</div></div>';
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
