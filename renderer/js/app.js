'use strict';

/* 局域网文件共享 — 桌面客户端渲染层（Vue 3 全局构建，无打包器） */
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

  // ---------------- 概览 ----------------
  const Dashboard = defineComponent({
    setup() {
      const homeUrl = computed(() => {
        const s = store.self;
        return s.host && s.port ? `http://${s.host}:${s.port}` : '';
      });
      const trafficUp = computed(() => formatBytes(store.stats.traffic ? store.stats.traffic.up : 0));
      const trafficDown = computed(() => formatBytes(store.stats.traffic ? store.stats.traffic.down : 0));
      const speedUp = computed(() => formatSpeed(store.stats.speed ? store.stats.speed.up : 0));
      const speedDown = computed(() => formatSpeed(store.stats.speed ? store.stats.speed.down : 0));
      const recentLogs = computed(() => store.logs.slice(0, 8));

      return { store, homeUrl, trafficUp, trafficDown, speedUp, speedDown, recentLogs, copy, toast };
    },
    template: `
      <div>
        <div class="stats">
          <div class="stat"><div class="n">{{ store.stats.onlineDevices || 0 }}</div><div class="l">在线设备</div></div>
          <div class="stat"><div class="n">{{ store.stats.shares || 0 }}</div><div class="l">已共享文件夹</div></div>
          <div class="stat"><div class="n">{{ trafficUp }}</div><div class="l">累计上传</div></div>
          <div class="stat"><div class="n">{{ trafficDown }}</div><div class="l">累计下载</div></div>
        </div>

        <div class="card">
          <h3>本机信息</h3>
          <div class="row" style="gap:24px">
            <div>
              <div class="muted">设备名称</div>
              <div style="font-size:15px">{{ store.self.deviceName || '-' }}</div>
            </div>
            <div>
              <div class="muted">访问地址</div>
              <div class="row">
                <span class="mono">{{ homeUrl }}</span>
                <button class="btn sm ghost" @click="copy(homeUrl)" v-if="homeUrl">复制</button>
              </div>
            </div>
            <div>
              <div class="muted">设备指纹</div>
              <div class="mono" style="font-size:12px">{{ store.self.fingerprint || '-' }}</div>
            </div>
          </div>
          <div class="row" style="margin-top:14px">
            <div class="muted">实时速度 ↑ {{ speedUp }} ↓ {{ speedDown }}</div>
          </div>
        </div>

        <div class="card">
          <h3>最近活动</h3>
          <div v-if="recentLogs.length === 0" class="empty">暂无活动</div>
          <table v-else>
            <thead><tr><th>时间</th><th>事件</th><th>目标</th><th>大小</th></tr></thead>
            <tbody>
              <tr v-for="(l, i) in recentLogs" :key="i">
                <td class="muted">{{ fmtTime(l.timestamp) }}</td>
                <td>{{ l.event_type }}</td>
                <td class="mono" style="font-size:12px">{{ l.target || '-' }}</td>
                <td class="muted">{{ l.size ? formatBytes(l.size) : '-' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    `,
  });

  // ---------------- 共享管理 ----------------
  const SharesView = defineComponent({
    setup() {
      const name = ref('');
      const path = ref('');
      const permission = ref('read');
      const password = ref('');
      const showPwd = ref(false);
      const qr = ref(null);
      const qrName = ref('');

      async function pick() {
        const r = await api.invoke('engine:pickFolder');
        if (r.ok && r.data) path.value = r.data;
      }
      async function add() {
        if (!path.value) return toast('请先选择文件夹', 'warn');
        const r = await api.invoke('engine:addShare', {
          name: name.value || undefined,
          path: path.value,
          permission: permission.value,
          password: password.value || undefined,
        });
        if (r.ok) {
          toast('已添加共享', 'ok');
          name.value = ''; path.value = ''; password.value = '';
        } else toast('添加失败: ' + r.error, 'warn');
      }
      async function remove(id) {
        const r = await api.invoke('engine:removeShare', id);
        if (!r.ok) toast('删除失败: ' + r.error, 'warn');
      }
      async function toggle(id, enabled) {
        const r = enabled
          ? await api.invoke('engine:stopShare', id)
          : await api.invoke('engine:startShare', id);
        if (!r.ok) toast('操作失败: ' + r.error, 'warn');
      }
      async function openFolder(p) {
        await api.invoke('engine:openFolder', p);
      }
      async function showQr(s) {
        qrName.value = s.name;
        const r = await api.invoke('engine:getShareQrcode', s.id);
        if (r.ok) { qr.value = r.data; } else qr.value = null;
      }
      function link(s) {
        return `http://${store.self.host}:${store.self.port}/s/${s.id}`;
      }

      return { store, name, path, permission, password, showPwd, qr, qrName, pick, add, remove, toggle, openFolder, showQr, link, copy };
    },
    template: `
      <div>
        <div class="card">
          <h3>添加共享</h3>
          <div class="row" style="align-items:flex-end">
            <label class="field">名称<input type="text" v-model="name" placeholder="默认使用文件夹名" /></label>
            <label class="field" style="min-width:280px">文件夹
              <div class="row">
                <input type="text" :value="path" readonly placeholder="未选择" style="min-width:220px" />
                <button class="btn ghost sm" @click="pick">选择…</button>
              </div>
            </label>
            <label class="field">权限
              <select v-model="permission">
                <option value="read">只读</option>
                <option value="write">可写</option>
                <option value="admin">管理</option>
              </select>
            </label>
            <label class="field">访问密码
              <div class="row">
                <input :type="showPwd ? 'text' : 'password'" v-model="password" placeholder="可选" />
                <button class="btn ghost sm" @click="showPwd = !showPwd">{{ showPwd ? '隐藏' : '显示' }}</button>
              </div>
            </label>
            <button class="btn" @click="add">添加共享</button>
          </div>
        </div>

        <div class="card">
          <h3>共享列表（{{ store.shares.length }}）</h3>
          <div v-if="store.shares.length === 0" class="empty">还没有共享任何文件夹</div>
          <table v-else>
            <thead><tr><th>名称</th><th>路径</th><th>权限</th><th>状态</th><th>链接 / 操作</th></tr></thead>
            <tbody>
              <tr v-for="s in store.shares" :key="s.id">
                <td>
                  <div>{{ s.name }}</div>
                  <div class="muted" v-if="s.hasPassword">🔒 已加密</div>
                </td>
                <td class="mono" style="font-size:12px;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ s.path }}</td>
                <td><span class="tag blue">{{ s.permission }}</span></td>
                <td>
                  <span class="tag" :class="s.enabled ? 'green' : 'gray'">{{ s.enabled ? '共享中' : '已停止' }}</span>
                </td>
                <td>
                  <div class="row">
                    <button class="btn sm ghost" @click="toggle(s.id, s.enabled)">{{ s.enabled ? '停止' : '启动' }}</button>
                    <button class="btn sm ghost" @click="showQr(s)">二维码</button>
                    <button class="btn sm ghost" @click="copy(link(s))">复制链接</button>
                    <button class="btn sm ghost" @click="openFolder(s.path)">打开</button>
                    <button class="btn sm danger" @click="remove(s.id)">删除</button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="modal-mask" v-if="qr" @click.self="qr = null">
          <div class="modal">
            <h3>共享二维码 — {{ qrName }}</h3>
            <div class="qr"><img :src="qr" style="width:200px;height:200px" /></div>
            <div class="muted" style="text-align:center">用手机或浏览器扫码即可访问（需在同一个局域网）</div>
            <div class="actions"><button class="btn" @click="qr = null">关闭</button></div>
          </div>
        </div>
      </div>
    `,
  });

  // ---------------- 设备 ----------------
  const DevicesView = defineComponent({
    setup() {
      const host = ref('');
      const port = ref('');
      const inviteCode = ref('');
      const myInvite = ref('');

      async function ping(id) {
        const r = await api.invoke('engine:pingDevice', id);
        toast('延迟: ' + (r.ok ? r.data + ' ms' : '不可达'), r.ok && r.data >= 0 ? 'ok' : 'warn');
      }
      async function trust(id, v) { await api.invoke('engine:trustDevice', id, v); }
      async function blacklist(id, v) { await api.invoke('engine:blacklistDevice', id, v); }
      async function connect() {
        if (!host.value) return toast('请输入主机地址', 'warn');
        const r = await api.invoke('engine:connectManual', { host: host.value, port: port.value ? Number(port.value) : undefined });
        if (r.ok) toast('已添加: ' + (r.data.deviceName || host.value), 'ok');
        else toast('连接失败: ' + r.error, 'warn');
      }
      async function discover() { await api.invoke('engine:discover'); toast('已发起探测', 'ok'); }
      async function createInvite() {
        const r = await api.invoke('engine:inviteCreate');
        if (r.ok) { myInvite.value = r.data; } else toast('生成失败', 'warn');
      }
      async function joinInvite() {
        if (!inviteCode.value) return;
        const r = await api.invoke('engine:inviteJoin', inviteCode.value);
        if (r.ok) toast('已加入设备: ' + (r.data.device ? r.data.device.device_name : ''), 'ok');
        else toast('加入失败: ' + (r.error || '未知'), 'warn');
      }

      return { store, host, port, inviteCode, myInvite, ping, trust, blacklist, connect, discover, createInvite, joinInvite, copy };
    },
    template: `
      <div>
        <div class="card">
          <h3>手动连接 / 邀请</h3>
          <div class="row" style="align-items:flex-end">
            <label class="field">主机地址<input type="text" v-model="host" placeholder="例如 192.168.1.20" /></label>
            <label class="field">端口<input type="text" v-model="port" placeholder="默认 8080" style="width:90px" /></label>
            <button class="btn" @click="connect">连接</button>
            <button class="btn ghost" @click="discover">探测局域网</button>
            <span style="flex:1"></span>
            <button class="btn ghost" @click="createInvite">生成邀请码</button>
            <label class="field">邀请码<input type="text" v-model="inviteCode" placeholder="6 位" style="width:110px" /></label>
            <button class="btn" @click="joinInvite">加入</button>
          </div>
          <div v-if="myInvite" class="row" style="margin-top:12px">
            <span class="muted">我的邀请码：</span>
            <span class="mono" style="font-size:18px;letter-spacing:2px">{{ myInvite }}</span>
            <button class="btn sm ghost" @click="copy(myInvite)">复制</button>
            <span class="muted">（10 分钟内有效，发给同一局域网的好友）</span>
          </div>
        </div>

        <div class="card">
          <h3>发现的设备（{{ store.devices.length }}）</h3>
          <div v-if="store.devices.length === 0" class="empty">暂无设备，点击「探测局域网」试试</div>
          <table v-else>
            <thead><tr><th>名称</th><th>系统</th><th>地址</th><th>共享</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-for="d in store.devices" :key="d.device_id">
                <td>{{ d.device_name }}<div class="muted" v-if="d.is_trusted">已信任</div></td>
                <td>{{ d.os || '-' }}</td>
                <td class="mono" style="font-size:12px">{{ d.host }}:{{ d.port }}</td>
                <td>{{ d.sharedCount || 0 }}</td>
                <td>
                  <span class="tag" :class="d.is_online ? 'green' : 'gray'">{{ d.is_online ? '在线' : '离线' }}</span>
                  <span v-if="d.is_blacklisted" class="tag red">已拉黑</span>
                </td>
                <td>
                  <div class="row">
                    <button class="btn sm ghost" @click="ping(d.device_id)">Ping</button>
                    <button class="btn sm ghost" v-if="!d.is_trusted && !d.is_blacklisted" @click="trust(d.device_id, true)">信任</button>
                    <button class="btn sm ghost" v-if="d.is_trusted" @click="trust(d.device_id, false)">取消信任</button>
                    <button class="btn sm danger" v-if="!d.is_blacklisted" @click="blacklist(d.device_id, true)">拉黑</button>
                    <button class="btn sm ghost" v-if="d.is_blacklisted" @click="blacklist(d.device_id, false)">解除</button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    `,
  });

  // ---------------- 设置 ----------------
  const SettingsView = defineComponent({
    setup() {
      async function save(patch) {
        const r = await api.invoke('engine:updateSettings', patch);
        if (!r.ok) toast('保存失败: ' + r.error, 'warn');
      }
      function onText(e, key) {
        save({ [key]: e.target.value });
      }
      function onCheck(e, key) {
        save({ [key]: e.target.checked });
      }
      const fps = computed(() => store.self.fingerprint || '-');
      return { store, save, onText, onCheck, fps, copy };
    },
    template: `
      <div>
        <div class="card">
          <h3>通用</h3>
          <div class="row" style="align-items:flex-end">
            <label class="field">设备名称<input type="text" :value="store.settings.deviceName" @change="onText($event,'deviceName')" /></label>
            <label class="field">心跳间隔(秒)<input type="number" min="1" max="30" :value="store.settings.heartbeatInterval" @change="onText($event,'heartbeatInterval')" style="width:90px" /></label>
            <label class="field">离线判定(秒)<input type="number" min="3" max="120" :value="store.settings.offlineTimeout" @change="onText($event,'offlineTimeout')" style="width:90px" /></label>
            <label class="field">默认权限
              <select :value="store.settings.defaultPermission" @change="onText($event,'defaultPermission')">
                <option value="read">只读</option><option value="write">可写</option><option value="admin">管理</option>
              </select>
            </label>
          </div>
        </div>

        <div class="card">
          <h3>发现与连接</h3>
          <div class="row">
            <label class="row" style="gap:6px"><input type="checkbox" :checked="store.settings.mdns" @change="onCheck($event,'mdns')" /> mDNS 发现</label>
            <label class="row" style="gap:6px"><input type="checkbox" :checked="store.settings.udp" @change="onCheck($event,'udp')" /> UDP 广播发现</label>
            <label class="row" style="gap:6px"><input type="checkbox" :checked="store.settings.allowBeDiscovered" @change="onCheck($event,'allowBeDiscovered')" /> 允许被其他设备发现</label>
            <label class="row" style="gap:6px"><input type="checkbox" :checked="store.settings.firstConnectConfirm" @change="onCheck($event,'firstConnectConfirm')" /> 首次连接需确认</label>
            <label class="row" style="gap:6px"><input type="checkbox" :checked="store.settings.autoTrust" @change="onCheck($event,'autoTrust')" /> 自动信任已发现设备</label>
          </div>
        </div>

        <div class="card">
          <h3>启动与托盘</h3>
          <div class="row">
            <label class="row" style="gap:6px"><input type="checkbox" :checked="store.settings.startup" @change="onCheck($event,'startup')" /> 开机自启动</label>
            <label class="row" style="gap:6px"><input type="checkbox" :checked="store.settings.minimizeToTray" @change="onCheck($event,'minimizeToTray')" /> 关闭时最小化到托盘</label>
          </div>
        </div>

        <div class="card">
          <h3>安全</h3>
          <div class="row">
            <span class="muted">本机 RSA 指纹：</span>
            <span class="mono" style="font-size:12px">{{ fps }}</span>
            <button class="btn sm ghost" @click="copy(fps)">复制</button>
            <span class="muted">（用于确认对端设备身份，防止中间人）</span>
          </div>
        </div>
      </div>
    `,
  });

  // ---------------- 日志 ----------------
  const LogsView = defineComponent({
    setup() {
      async function clear() {
        const r = await api.invoke('engine:clearLogs');
        if (r.ok) toast('日志已清空', 'ok');
      }
      return { store, clear };
    },
    template: `
      <div>
        <div class="card">
          <div class="row" style="justify-content:space-between">
            <h3 style="margin:0">访问日志</h3>
            <button class="btn ghost sm" @click="clear">清空</button>
          </div>
          <div v-if="store.logs.length === 0" class="empty">暂无日志</div>
          <table v-else>
            <thead><tr><th>时间</th><th>事件</th><th>设备</th><th>目标</th><th>大小</th><th>结果</th></tr></thead>
            <tbody>
              <tr v-for="(l, i) in store.logs" :key="i">
                <td class="muted">{{ fmtTime(l.timestamp) }}</td>
                <td>{{ l.event_type }}</td>
                <td>{{ l.device_name || l.device_id || '-' }}</td>
                <td class="mono" style="font-size:12px">{{ l.target || '-' }}</td>
                <td class="muted">{{ l.size ? formatBytes(l.size) : '-' }}</td>
                <td><span class="tag" :class="l.result === 'success' ? 'green' : 'red'">{{ l.result }}</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    `,
  });

  // ---------------- 会话（聊天 / 文件 / 音视频） ----------------
  const ChatView = defineComponent({
    setup() {
      const chatUrl = computed(() => {
        const s = store.self;
        return s.host && s.port ? `http://${s.host}:${s.port}/chat` : '';
      });
      const loaded = ref(false);
      return { chatUrl, loaded };
    },
    template: `
      <div class="card" style="padding:0;overflow:hidden;height:calc(100vh - 96px);display:flex;flex-direction:column">
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

  // ---------------- 根组件 ----------------
  const App = defineComponent({
    components: { Dashboard, SharesView, DevicesView, SettingsView, LogsView, ChatView },
    setup() {
      const tab = ref('dashboard');
      const navs = [
        { id: 'dashboard', label: '概览', ic: '🏠' },
        { id: 'chat', label: '会话', ic: '💬' },
        { id: 'shares', label: '共享', ic: '📁' },
        { id: 'devices', label: '设备', ic: '🖥️' },
        { id: 'settings', label: '设置', ic: '⚙️' },
        { id: 'logs', label: '日志', ic: '📜' },
      ];

      function setTab(t) { tab.value = t; }

      onMounted(() => {
        refresh();
        api.on('devices', (list) => (store.devices = list));
        api.on('shares', (list) => (store.shares = list));
        api.on('settings', (s) => (store.settings = s));
        api.on('stats', (s) => (store.stats = s));
        api.on('ready', (snap) => { if (snap) Object.assign(store, snap); });
        api.on('logs', (entry) => { store.logs.unshift(entry); if (store.logs.length > 300) store.logs.pop(); });
        api.on('pairing-request', (d) => toast('收到来自「' + (d.device_name || '未知设备') + '」的连接请求', 'ok'));
        api.on('warn', (m) => toast(String(m), 'warn'));
      });

      const selfText = computed(() => (store.self.deviceName ? store.self.deviceName + ' · ' + (store.self.host || '') + ':' + (store.self.port || '') : '加载中…'));

      function winMin() { window.lan.minimize(); }
      function winClose() { window.lan.toggleVisible(); }

      return { tab, navs, setTab, store, selfText, winMin, winClose };
    },
    template: `
      <div>
        <div class="topbar">
          <span class="title">局域网文件共享</span>
          <span class="self">本机：<b>{{ selfText }}</b></span>
          <span class="spacer"></span>
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

  // ---------------- 通用格式化（通过 mixin 暴露给模板） ----------------
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

  const app = createApp(App);
  app.mixin({ methods: { fmtTime, formatBytes, formatSpeed } });
  app.mount('#app');
})();
