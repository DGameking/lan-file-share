/* 主题切换（v1.15.0）：system / light / dark 三态循环，localStorage 记忆。
 * 须在 <head> 内同步加载（防首屏闪烁）。用法：
 *   LfsTheme.get() → 当前模式
 *   LfsTheme.cycle() → 切换到下一模式并返回
 *   LfsTheme.icon() → 当前模式下切换按钮应显示的图标 */
(function () {
  'use strict';
  var KEY = 'lfs_theme';
  function get() {
    try { return localStorage.getItem(KEY) || 'system'; } catch (e) { return 'system'; }
  }
  function apply(mode) {
    var root = document.documentElement;
    if (mode === 'dark') root.setAttribute('data-theme', 'dark');
    else if (mode === 'light') root.setAttribute('data-theme', 'light');
    else root.removeAttribute('data-theme');
  }
  apply(get());
  window.LfsTheme = {
    get: get,
    set: function (m) { try { localStorage.setItem(KEY, m); } catch (e) {} apply(m); },
    cycle: function () {
      var cur = get();
      var next = cur === 'system' ? 'dark' : cur === 'dark' ? 'light' : 'system';
      window.LfsTheme.set(next);
      return next;
    },
    icon: function () {
      var m = get();
      return m === 'dark' ? '☀️' : m === 'light' ? '🌙' : '🌓';
    },
    label: function () {
      var m = get();
      return m === 'dark' ? '深色' : m === 'light' ? '浅色' : '跟随系统';
    },
  };
})();
