'use strict';

/* 桌面客户端渲染层 — 共享基础：API 桥 / 全局状态 / 通用工具（被各视图文件引用） */
(function () {
  const { createApp, reactive, ref, onMounted, computed, defineComponent } = Vue;

  const api = {
    invoke(channel, ...args) {
      return window.lan.invoke(channel, ...args);
    },
    on(event, cb) {
      return window.lan.onEvent(event, cb);
    },
  };

  function toast(msg, type) {
    const el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = msg;
    let wrap = document.querySelector('.toast-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'toast-wrap';
      document.body.appendChild(wrap);
    }
    wrap.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 300);
    }, 2800);
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制到剪贴板', 'ok');
    } catch (e) {
      toast('复制失败', 'warn');
    }
  }

  // ---------------- 共享状态 ----------------
  const store = reactive({
    self: {},
    shares: [],
    devices: [],
    stats: {},
    settings: {},
    logs: [],
  });

  async function refresh() {
    const r = await api.invoke('engine:snapshot');
    if (r.ok && r.data) Object.assign(store, r.data);
  }


  // settings.theme: 'system' | 'light' | 'dark'；system 时移除 data-theme 交给 prefers-color-scheme
  function applyTheme(mode) {
    const m = mode || 'system';
    const root = document.documentElement;
    root.removeAttribute('data-theme');
    if (m === 'dark') root.setAttribute('data-theme', 'dark');
    else if (m === 'light') root.setAttribute('data-theme', 'light');
    if (window.lan && window.lan.setTheme) window.lan.setTheme(m); // 同步标题栏配色
  }


  function fmtTime(ts) {
    if (!ts) return '-';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  function formatBytes(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (i === 0 ? v : v.toFixed(1)) + ' ' + u[i];
  }
  function formatSpeed(n) {
    return formatBytes(n || 0) + '/s';
  }


  Object.assign((window.LfsCore = window.LfsCore || {}), { api, toast, copy, store, refresh, applyTheme, fmtTime, formatBytes, formatSpeed });
})();
