'use strict';

/* 会话视图 */
(function () {
  const { defineComponent, ref, reactive, onMounted, computed } = Vue;
  const { api, toast, copy, store, refresh, fmtTime, formatBytes, formatSpeed, applyTheme } = window.LfsCore;

  const ChatView = defineComponent({
    setup() {
      const chatUrl = computed(() => {
        const s = store.self;
        if (!s.host || !s.port) return '';
        // 桌面端内嵌页以设备名+独立身份入会（与浏览器打开的会话页互不覆盖）；HTTPS 时同步协议
        const proto = s.useHttps ? 'https' : 'http';
        const name = s.deviceName ? `&name=${encodeURIComponent(s.deviceName)}` : '';
        return `${proto}://${s.host}:${s.port}/chat?kind=desktop${name}`;
      });
      const loaded = ref(false);
      function openBubble() { if (window.lan && window.lan.openChat) window.lan.openChat(); }
      return { chatUrl, loaded, openBubble };
    },
    template: `
      <div class="card" style="padding:0;overflow:hidden;height:calc(100vh - 96px);display:flex;flex-direction:column">
        <div style="flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border)">
          <span class="muted" style="font-size:12px">会话运行于本机服务，也可独立成窗常驻桌面</span>
          <span style="flex:1"></span>
          <button class="btn sm ghost" @click="openBubble">🫧 气泡窗口</button>
        </div>
        <iframe
          v-if="chatUrl"
          :src="chatUrl"
          @load="loaded = true"
          style="flex:1;border:none;width:100%;height:100%"
          allow="microphone; camera; clipboard-read; clipboard-write"
        ></iframe>
        <div v-else class="empty" style="margin:auto">引擎启动中…</div>
      </div>
    `,
  });


  (window.LfsViews = window.LfsViews || {}).ChatView = ChatView;
})();
