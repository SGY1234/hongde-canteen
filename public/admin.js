/* 菜单问题反馈 · 管理页逻辑（零依赖，原生 JS） */
(function () {
  'use strict';

  var scope = 'open';   // open=只看待处理，all=全部

  function $(id) { return document.getElementById(id); }

  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () { t.classList.remove('show'); }, 2000);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function api(path, options) {
    options = options || {};
    var init = { method: options.method || 'GET', headers: {} };
    if (options.body) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    return fetch(path, init).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.error || ('请求失败（HTTP ' + res.status + '）'));
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  /** 时间显示成"今天 18:42"这种人话，而不是一串 ISO 字符串 */
  function whenText(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var now = new Date();
    var sameDay = d.getFullYear() === now.getFullYear()
      && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    var hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    if (sameDay) return '今天 ' + hm;
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
  }

  function load() {
    var list = $('admList');
    list.innerHTML = '<div class="adm-empty">加载中…</div>';
    api('/api/feedback/list?all=' + (scope === 'all' ? '1' : '0') + '&limit=200')
      .then(render)
      .catch(function (err) {
        list.innerHTML = '<div class="adm-empty">读不到反馈<br>' + esc(err.message) + '</div>';
        $('admSub').textContent = err.status === 403 ? '权限不足（只能在本机打开）' : '出错了';
      });
  }

  function render(data) {
    var c = data.counts || {};
    $('admSub').textContent = '待处理 ' + (c.open || 0) + ' 条　·　已处理 '
      + (c.done || 0) + ' 条　·　已忽略 ' + (c.ignored || 0) + ' 条';
    $('admCount').textContent = '当前显示 ' + data.items.length + ' 条';

    var list = $('admList');
    if (!data.items.length) {
      list.innerHTML = '<div class="adm-empty">'
        + (scope === 'open' ? '没有待处理的反馈 👍<br>同学报的错会出现在这里' : '还没有任何反馈')
        + '</div>';
      return;
    }

    var html = '';
    data.items.forEach(function (it) {
      var where = [it.canteenName, it.stallName, it.dishName].filter(Boolean).join(' · ');
      html += '<div class="fb-item' + (it.status === 'done' ? ' done' : '') + '">'
        + '<div class="fb-head">'
        + '<span class="fb-tag">' + esc(it.kindText) + '</span>'
        + '<span class="fb-tag st-' + esc(it.status) + '">' + esc(it.statusText) + '</span>'
        + '</div>'
        + (where ? '<div class="fb-where">' + esc(where) + '</div>' : '')
        + '<div class="fb-what">' + esc(it.text) + '</div>'
        + '<div class="fb-when">' + esc(whenText(it.at)) + '　编号 ' + esc(it.id) + '</div>'
        + '<div class="fb-acts">'
        + (it.status === 'open'
          ? '<button class="fb-btn primary" data-act="done" data-id="' + esc(it.id) + '" type="button">已改好</button>'
            + '<button class="fb-btn" data-act="ignored" data-id="' + esc(it.id) + '" type="button">不用改</button>'
          : '<button class="fb-btn" data-act="open" data-id="' + esc(it.id) + '" type="button">撤回到待处理</button>')
        + '</div>'
        + '</div>';
    });
    list.innerHTML = html;
  }

  function resolve(id, status) {
    api('/api/feedback/resolve', { method: 'POST', body: { id: id, status: status } })
      .then(function () {
        toast(status === 'done' ? '已标记为改好' : status === 'ignored' ? '已忽略' : '已撤回');
        load();
      })
      .catch(function (err) { toast('操作失败：' + err.message); });
  }

  function bind() {
    $('admRefresh').addEventListener('click', load);
    Array.prototype.forEach.call(document.querySelectorAll('.adm-tab'), function (b) {
      b.addEventListener('click', function () {
        scope = this.getAttribute('data-scope');
        Array.prototype.forEach.call(document.querySelectorAll('.adm-tab'), function (x) {
          x.classList.toggle('on', x === this);
        }, this);
        load();
      });
    });
    $('admList').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.fb-btn') : null;
      if (!b) return;
      resolve(b.getAttribute('data-id'), b.getAttribute('data-act'));
    });
  }

  bind();
  load();
  // 每 30 秒自动刷一次，方便挂着页面等同学报错
  setInterval(load, 30000);
})();
