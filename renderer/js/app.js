'use strict';

/* 桌面客户端渲染层 — 根组件与应用装配 */
(function () {
  const { createApp, ref, onMounted, computed, defineComponent } = Vue;
  const { api, store, refresh, applyTheme, fmtTime, formatBytes, formatSpeed } = window.LfsCore;
  const { Dashboard, SharesView, DevicesView, SettingsView, LogsView, ChatView, DropView } = window.LfsViews;

  const App = defineComponent({
    components: { Dashboard, SharesView, DevicesView, SettingsView, LogsView, ChatView, DropView },
    setup() {
      const tab = ref('dashboard');
      const navs = [
        { id: 'dashboard', label: '概览', ic: '🏠' },
        { id: 'drop', label: '投送', ic: '🚀' },
        { id: 'chat', label: '会话', ic: '💬' },
        { id: 'shares', label: '共享', ic: '📁' },
        { id: 'devices', label: '设备', ic: '🖥️' },
        { id: 'settings', label: '设置', ic: '⚙️' },
        { id: 'logs', label: '日志', ic: '📜' },
      ];

      function setTab(t) { tab.value = t; }

      onMounted(() => {
        refresh();
        // 主题与平台适配：settings.theme 驱动双主题；darwin 加 body.darwin（红绿灯占位）
        applyTheme(store.settings && store.settings.theme);
        if (window.lan && window.lan.platform === 'darwin') document.body.classList.add('darwin');
        // 兜底轮询：事件推送之外，每 5 秒对齐一次全量快照，保证信息始终统一
        setInterval(() => refresh().catch(() => {}), 5000);
        api.on('nav', (t) => { if (t) tab.value = t; }); // 托盘/全局快捷键跳转
        // v1.21.0 设备卡右键菜单「去投送」等页内跳转（组件间解耦走 window 事件）
        window.addEventListener('lfs-nav', (e) => { if (e.detail) setTab(e.detail); });
        // v1.18.0 通知中心：设备上下线（按在线状态变化去重）
        let prevOnline = null; // Map<deviceId, bool>
        api.on('devices', (list) => {
          const arr = Array.isArray(list) ? list : [];
          const key = (d) => d.deviceId || d.device_id || d.id || d.deviceName;
          const online = (d) => d.isOnline === true || d.is_online === 1 || d.is_online === true || d.online === true;
          const now = new Map();
          arr.forEach((d) => now.set(String(key(d)), online(d)));
          if (prevOnline) {
            now.forEach((on, k) => {
              const was = prevOnline.get(k);
              if (was === undefined || was === on) return;
              const d = arr.find((x) => String(key(x)) === k) || {};
              pushNotif(on ? '🟢' : '⚪', on ? '设备上线' : '设备离线', d.deviceName || d.name || k, 'devices');
            });
          }
          prevOnline = now;
          store.devices = arr;
        });
        api.on('shares', (list) => (store.shares = list));
        api.on('settings', (s) => { store.settings = s; applyTheme(s && s.theme); });
        api.on('settings', (s) => (store.settings = s));
        api.on('stats', (s) => (store.stats = s));
        api.on('ready', (snap) => { if (snap) Object.assign(store, snap); });
        api.on('logs', (entry) => { store.logs.unshift(entry); if (store.logs.length > 300) store.logs.pop(); });
        api.on('pairing-request', (d) => { pushNotif('🤝', '配对请求', '来自「' + (d.device_name || '未知设备') + '」的连接请求', 'devices'); toast('收到来自「' + (d.device_name || '未知设备') + '」的连接请求', 'ok'); });
        api.on('warn', (m) => toast(String(m), 'warn'));
        // v1.18.0 通知中心事件源：投送接收 / 剪贴板同步
        api.on('drop.incoming', (p) => {
          const names = (p.files || []).map((f) => f.name).join('、');
          pushNotif('📥', '收到投送', '「' + (p.from || '未知设备') + '」投送了 ' + (p.files || []).length + ' 个文件：' + names, 'drop');
        });
        api.on('clip-incoming', (p) => pushNotif('📋', '剪贴板同步', '来自「' + (p.deviceName || '其他设备') + '」的文本已写入本机剪贴板', null));
      });

      // ---- 通知中心状态（v1.18.0） ----
      const notifs = ref([]);
      const notifOpen = ref(false);
      const notifUnread = ref(0);
      function pushNotif(ic, title, desc, nav) {
        notifs.value.unshift({ id: Date.now() + Math.random(), ic, title, desc, nav, ts: Date.now() });
        if (notifs.value.length > 50) notifs.value.length = 50;
        if (!notifOpen.value) notifUnread.value++;
      }
      function toggleNotif() {
        notifOpen.value = !notifOpen.value;
        if (notifOpen.value) notifUnread.value = 0;
      }
      function clearNotifs() { notifs.value = []; notifOpen.value = false; }
      function openNotif(n) {
        notifOpen.value = false;
        notifUnread.value = 0;
        if (n && n.nav) setTab(n.nav);
      }

      const selfText = computed(() => (store.self.deviceName ? store.self.deviceName + ' · ' + (store.self.host || '') + ':' + (store.self.port || '') : '加载中…'));

      function winMin() { window.lan.minimize(); }
      function winClose() { window.lan.toggleVisible(); }

      return { tab, navs, setTab, store, selfText, winMin, winClose, notifs, notifOpen, notifUnread, toggleNotif, clearNotifs, openNotif };
    },
    template: `
      <div>
        <div class="topbar">
          <span class="title">局域网文件共享</span>
          <span class="self">本机：<b>{{ selfText }}</b></span>
          <span class="spacer"></span>
          <div class="bell-wrap">
            <button class="winbtn bell" @click="toggleNotif" title="通知中心">🔔<span v-if="notifUnread" class="badge">{{ notifUnread > 99 ? '99+' : notifUnread }}</span></button>
            <div v-if="notifOpen" class="notif-panel">
              <div class="n-head"><b>通知中心</b><span class="sp"></span><button class="n-clear" @click="clearNotifs">清空</button></div>
              <div v-if="!notifs.length" class="n-empty">暂无通知</div>
              <div v-for="n in notifs" :key="n.id" class="n-item" @click="openNotif(n)">
                <span class="n-ic">{{ n.ic }}</span>
                <div class="n-body"><div class="n-title">{{ n.title }}</div><div class="n-desc">{{ n.desc }}</div></div>
                <span class="n-ts">{{ fmtTime(n.ts) }}</span>
              </div>
            </div>
          </div>
          <button class="winbtn" @click="winMin" title="最小化">—</button>
          <button class="winbtn" @click="winClose" title="隐藏到托盘">▢</button>
        </div>
        <div class="layout">
          <div class="sidebar">
            <div v-for="n in navs" :key="n.id" class="nav-item" :class="{ active: tab === n.id }" @click="setTab(n.id)">
              <span class="ic">{{ n.ic }}</span><span>{{ n.label }}</span>
            </div>
          </div>
          <div class="content">
            <component :is="tab === 'dashboard' ? 'Dashboard'
              : tab === 'drop' ? 'DropView'
              : tab === 'chat' ? 'ChatView'
              : tab === 'shares' ? 'SharesView'
              : tab === 'devices' ? 'DevicesView'
              : tab === 'settings' ? 'SettingsView'
              : 'LogsView'" />
          </div>
        </div>
      </div>
    `,
  });


  const app = createApp(App);
  app.mixin({ methods: { fmtTime, formatBytes, formatSpeed } });
  app.mount('#app');
})();
