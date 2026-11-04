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

      // 启动即静默检查更新（引擎侧 24h 节流；发现新版本仅提示不打扰）
      onMounted(() => {
        api.invoke('engine:checkUpdate', { auto: true }).then((r) => {
          if (r.ok && r.data && r.data.checked && r.data.hasUpdate) toast(`🎉 发现新版本 v${r.data.latest}，可在「设置 → 更新」中下载`, 'ok');
        }).catch(() => {});
      });

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

      // 其他设备的共享（桥接联邦自动同步 + 打开页面时主动拉快照/补拉）
      const remoteShares = ref([]); // [{deviceName, deviceId, shares:[{id,name,permission,hasPassword}]}]
      onMounted(async () => {
        api.on('remote.shares', (list) => (remoteShares.value = Array.isArray(list) ? list : []));
        try {
          const snap = await api.invoke('engine:remoteSharesSnapshot');
          if (snap.ok && Array.isArray(snap.data) && snap.data.length) remoteShares.value = snap.data;
          else {
            // 快照为空：向所有在线对端补拉一次目录（对端稍后经 remote.shares 事件回填）
            api.invoke('engine:refreshRemoteShares');
          }
        } catch (e) {}
      });
      function devUrl(deviceId) {
        const d = store.devices.find((x) => x.device_id === deviceId);
        return d && d.host ? `http://${d.host}:${d.port}` : '';
      }
      function remoteLink(entry, s) {
        const base = devUrl(entry.deviceId);
        return base ? `${base}/s/${s.id}` : '';
      }
      function openRemote(entry, s) {
        const u = remoteLink(entry, s);
        if (!u) return toast('设备不在线或地址未知', 'warn');
        api.invoke('engine:openExternal', u);
      }

      // ---- 挂载为本地磁盘（WebDAV） ----
      const mountTarget = ref(null); // {name, url, hasPassword}
      const mountPwd = ref('');
      const mounting = ref(false);
      function askMount(entry, s) {
        const u = remoteLink(entry, s);
        if (!u) return toast('设备不在线或地址未知', 'warn');
        mountTarget.value = { name: `${entry.deviceName} / ${s.name}`, url: `${u}/s/${s.id}/webdav`, hasPassword: !!s.hasPassword };
        mountPwd.value = '';
      }
      async function doMount() {
        if (!mountTarget.value) return;
        mounting.value = true;
        const r = await api.invoke('engine:mountWebdav', { url: mountTarget.value.url, password: mountPwd.value || '' });
        mounting.value = false;
        if (r.ok && r.data && r.data.letter) {
          toast(`已挂载为本地磁盘 ${r.data.letter}`, 'ok');
          api.invoke('engine:openFolder', r.data.letter + '\\');
          mountTarget.value = null;
        } else {
          const hint = r.hint || (r.data && r.data.hint) || r.error || '';
          toast('挂载失败：' + hint, 'warn');
        }
      }

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

      return { store, name, path, permission, password, showPwd, qr, qrName, pick, add, remove, toggle, openFolder, showQr, link, copy,
               remoteShares, remoteLink, openRemote, askMount, mountTarget, mountPwd, mounting, doMount };
    },
    template: `
      <div>
        <div class="card">
          <h3>添加共享</h3>
          <div class="muted" style="margin-bottom:10px">提示：想挂载其他电脑的 D 盘 / E 盘？在那台电脑上把整个盘符根目录（如 D:\\）添加为共享即可，本机就能在下方挂载为本地磁盘。</div>
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

        <div class="card">
          <h3>其他设备的共享（{{ remoteShares.reduce((n, e) => n + e.shares.length, 0) }}）</h3>
          <div class="muted" style="margin-bottom:10px">局域网内其他设备共享的文件夹会自动出现在这里，可直接打开浏览，或挂载为本机磁盘</div>
          <div v-if="remoteShares.length === 0" class="empty">暂无其他设备的共享 — 设备上线并添加共享后会自动显示</div>
          <table v-else>
            <thead><tr><th>设备</th><th>共享名称</th><th>权限</th><th>操作</th></tr></thead>
            <tbody>
              <template v-for="entry in remoteShares" :key="entry.deviceId">
                <tr v-for="s in entry.shares" :key="entry.deviceId + '/' + s.id">
                  <td>{{ entry.deviceName }}<div class="muted" v-if="!devUrl(entry.deviceId)">（离线）</div></td>
                  <td>{{ s.name }} <span class="muted" v-if="s.hasPassword">🔒</span></td>
                  <td><span class="tag blue">{{ s.permission }}</span></td>
                  <td>
                    <div class="row">
                      <button class="btn sm" @click="askMount(entry, s)">💾 挂载为磁盘</button>
                      <button class="btn sm ghost" @click="openRemote(entry, s)">浏览器打开</button>
                      <button class="btn sm ghost" @click="copy(remoteLink(entry, s))" v-if="remoteLink(entry, s)">复制链接</button>
                    </div>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>

        <div class="modal-mask" v-if="mountTarget" @click.self="mountTarget = null">
          <div class="modal">
            <h3>挂载为本地磁盘 — {{ mountTarget.name }}</h3>
            <div class="muted" style="margin:8px 0 14px;text-align:center">将以 WebDAV 方式挂载一个网络盘符（Windows 自动配置，可能弹出一次管理员授权）</div>
            <div class="row" style="justify-content:center" v-if="mountTarget.hasPassword">
              <label class="field">访问密码<input type="password" v-model="mountPwd" placeholder="该共享设置的密码" /></label>
            </div>
            <div class="actions">
              <button class="btn" @click="doMount" :disabled="mounting">{{ mounting ? '挂载中…' : '挂载' }}</button>
              <button class="btn ghost" @click="mountTarget = null">取消</button>
            </div>
          </div>
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

      // 识别码格式化：8 位指纹 → LF-XXXX-XXXX（IP 变化后凭此确认设备身份）
      function fpFmt(fp) {
        const s = String(fp || '').replace(/[^0-9a-fA-F]/g, '');
        if (!s) return 'LF-????-????';
        return ('LF-' + s.slice(0, 4) + '-' + s.slice(4, 8)).toUpperCase();
      }
      const typeIcon = (d) => {
        const t = String(d.device_type || '').toLowerCase();
        if (d.os === 'android' || t === 'phone') return '📱';
        if (t === 'laptop' || d.os === 'darwin') return '💻';
        if (t === 'nas' || d.os === 'linux') return '🖥️';
        if (d.os === 'win32') return '🖥️';
        return '🔌';
      };

      const sortedDevices = computed(() => {
        return [...store.devices].sort((a, b) => {
          if ((b.starred ? 1 : 0) !== (a.starred ? 1 : 0)) return (b.starred ? 1 : 0) - (a.starred ? 1 : 0); // 收藏置顶（v1.20.0）
          if (a.is_online !== b.is_online) return a.is_online ? -1 : 1; // 在线优先
          if (a.is_blacklisted !== b.is_blacklisted) return a.is_blacklisted ? 1 : -1;
          return String(a.device_name || '').localeCompare(String(b.device_name || ''), 'zh');
        });
      });
      const onlineCount = computed(() => store.devices.filter((d) => d.is_online).length);

      async function ping(id) {
        const r = await api.invoke('engine:pingDevice', id);
        toast('延迟: ' + (r.ok ? r.data + ' ms' : '不可达'), r.ok && r.data >= 0 ? 'ok' : 'warn');
      }
      async function trust(id, v) { await api.invoke('engine:trustDevice', id, v); }
      async function blacklist(id, v) { await api.invoke('engine:blacklistDevice', id, v); }
      async function star(d) {
        const r = await api.invoke('engine:starDevice', d.device_id, !d.starred);
        if (r.ok) { d.starred = !d.starred ? 1 : 0; toast(d.starred ? '已收藏，将置顶显示' : '已取消收藏', 'ok'); }
      }
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
      function copyFp() {
        const s = String(store.self.fingerprint || '');
        if (s) { copy(s); toast('识别码已复制，对方可通过它确认本机身份', 'ok'); }
      }

      return { store, host, port, inviteCode, myInvite, ping, trust, blacklist, star, connect, discover, createInvite, joinInvite, copy,
               fpFmt, sortedDevices, onlineCount, copyFp, typeIcon };
    },
    template: `
      <div>
        <!-- 本机识别卡 -->
        <div class="card self-card">
          <div class="dc-head">
            <div class="dc-avatar">本</div>
            <div class="dc-info">
              <div class="dc-name">{{ store.self.deviceName || '本机' }} <span class="tag blue">本机</span></div>
              <div class="muted">识别码 <b class="mono" style="color:var(--primary);letter-spacing:1px">{{ fpFmt(store.self.fingerprint) }}</b>
                <button class="btn sm ghost" style="margin-left:6px" @click="copyFp">复制</button></div>
              <div class="muted mono">{{ store.self.host }}:{{ store.self.port }} · 版本 v{{ store.self.version }}</div>
            </div>
            <span style="flex:1"></span>
            <button class="btn ghost" @click="discover">📡 探测局域网</button>
          </div>
          <div class="muted" style="margin-top:10px">💡 每台设备有唯一识别码。对方 IP 变化后，软件会自动重新连接，无需手动操作；识别码用于确认「这就是那台设备」。</div>
        </div>

        <!-- 手动连接 / 邀请 -->
        <div class="card">
          <h3>添加设备</h3>
          <div class="two-col">
            <div>
              <div class="muted" style="margin-bottom:8px">方式一 · 按 IP 直连（同网段可用）</div>
              <div class="row" style="align-items:flex-end">
                <label class="field">主机地址<input type="text" v-model="host" placeholder="例如 192.168.1.20" /></label>
                <label class="field">端口<input type="text" v-model="port" placeholder="默认 8080" style="width:90px" /></label>
                <button class="btn" @click="connect">连接</button>
              </div>
            </div>
            <div>
              <div class="muted" style="margin-bottom:8px">方式二 · 邀请码配对（对方生成，你填入）</div>
              <div class="row" style="align-items:flex-end">
                <label class="field">对方邀请码<input type="text" v-model="inviteCode" placeholder="6 位数字" style="width:130px" /></label>
                <button class="btn" @click="joinInvite">加入</button>
                <span style="flex:1"></span>
                <button class="btn ghost" @click="createInvite">{{ myInvite ? '重新生成' : '生成我的邀请码' }}</button>
              </div>
              <div v-if="myInvite" class="row" style="margin-top:10px">
                <span class="muted">我的邀请码：</span>
                <span class="mono" style="font-size:18px;letter-spacing:3px;color:var(--green)">{{ myInvite }}</span>
                <button class="btn sm ghost" @click="copy(myInvite)">复制</button>
                <span class="muted">10 分钟内有效</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 设备网格 -->
        <div class="card">
          <h3>局域网设备（<span style="color:var(--green)">{{ onlineCount }}</span> 在线 / 共 {{ store.devices.length }} 台）</h3>
          <div v-if="store.devices.length === 0" class="empty">还没有发现设备 — 同一局域网内的设备会自动出现，也可以用上方邀请码或 IP 添加</div>
          <div v-else class="device-grid">
            <div class="dev-card" v-for="d in sortedDevices" :key="d.device_id" :class="{ off: !d.is_online }">
              <div class="dc-head">
                <div class="dc-avatar" :style="d.is_online ? '' : 'filter:grayscale(1);opacity:.45'">{{ (d.alias || d.device_name || '?').slice(0,1).toUpperCase() }}</div>
                <div class="dc-info">
                  <div class="dc-name">{{ d.alias || d.device_name }}<span v-if="d.alias" class="muted" style="font-size:11px">（{{ d.device_name }}）</span> <span class="dot" :class="d.is_online ? 'on' : 'off2'"></span></div>
                  <div class="dc-os">{{ typeIcon(d) }} {{ d.os || '-' }} · <span class="mono">{{ fpFmt(d.fingerprint) }}</span></div>
                  <div class="dc-os muted">{{ d.host }}:{{ d.port }}</div>
                </div>
              </div>
              <div class="row" style="margin-top:8px;gap:6px">
                <span class="tag" :class="d.is_online ? 'green' : 'gray'">{{ d.is_online ? '在线' : '离线' }}</span>
                <span class="tag blue" v-if="d.is_trusted">已信任</span>
                <span class="tag red" v-if="d.is_blacklisted">已拉黑</span>
                <span class="spacer" style="flex:1"></span>
                <button class="btn sm ghost" :title="d.starred ? '取消收藏' : '收藏置顶'" @click="star(d)">{{ d.starred ? '★' : '☆' }}</button>
              </div>
              <div class="dc-actions">
                <button class="btn sm ghost" @click="ping(d.device_id)">Ping</button>
                <button class="btn sm ghost" v-if="!d.is_trusted && !d.is_blacklisted" @click="trust(d.device_id, true)">信任</button>
                <button class="btn sm ghost" v-if="d.is_trusted" @click="trust(d.device_id, false)">取消信任</button>
                <button class="btn sm danger" v-if="!d.is_blacklisted" @click="blacklist(d.device_id, true)">拉黑</button>
                <button class="btn sm ghost" v-if="d.is_blacklisted" @click="blacklist(d.device_id, false)">解除</button>
              </div>
            </div>
          </div>
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
      // 主题切换：保存设置并立即生效（无需重启）
      function onTheme(e) {
        applyTheme(e.target.value);
        save({ theme: e.target.value });
      }
      const fps = computed(() => store.self.fingerprint || '-');
      const httpsChanged = ref(false);
      async function onHttps(e) {
        await save({ https: e.target.checked });
        httpsChanged.value = true;
      }
      function relaunch() {
        if (window.lan && window.lan.relaunch) window.lan.relaunch();
      }
      const diag = ref(null);
      const diagRunning = ref(false);
      async function runDiag() {
        diagRunning.value = true;
        const r = await api.invoke('engine:diagnose');
        if (r.ok) diag.value = r.data;
        else toast('自检失败: ' + (r.error || ''), 'warn');
        diagRunning.value = false;
        if (diag.value) toast(diag.value.summary, diag.value.ok ? 'ok' : 'warn');
      }
      function openLogsDir() {
        api.invoke('engine:openLogsDir');
      }

      // ---- 更新检查 ----
      const updateInfo = ref(null);
      const checking = ref(false);
      async function checkUpdate(auto) {
        checking.value = true;
        const r = await api.invoke('engine:checkUpdate', { auto: !!auto });
        checking.value = false;
        if (r.ok) {
          updateInfo.value = r.data;
          if (r.data.checked && r.data.hasUpdate) toast(`发现新版本 v${r.data.latest}`, 'ok');
          else if (r.data.checked) toast('已是最新版本', 'ok');
        }
      }
      function openUpdateUrl() {
        if (updateInfo.value && updateInfo.value.url) api.invoke('engine:openExternal', updateInfo.value.url);
      }

      // ---- 应用内下载与安装 ----
      const dl = ref(null); // {starting} | {name,received,total,pct} | {done,version}
      async function startDownload() {
        dl.value = { starting: true };
        const r = await api.invoke('engine:update:download');
        const d = (r && r.data) || {};
        if (!d.ok) {
          dl.value = null;
          toast('下载失败：' + (d.hint || d.error || ''), 'warn');
        }
      }
      function abortDownload() {
        api.invoke('engine:update:abort');
        dl.value = null;
      }
      async function installNow() {
        const r = await api.invoke('engine:update:install');
        const d = (r && r.data) || {};
        if (d.ok && d.mode === 'auto') toast('正在静默安装，完成后应用将自动重启…', 'ok');
        else if (d.ok && d.mode === 'manual') toast('已打开安装文件，请手动完成安装', 'ok');
        else toast('安装失败：' + ((r && r.error) || d.error || '请先下载更新包'), 'warn');
      }
      onMounted(() => {
        api.on('update.progress', (p) => {
          if (p.aborted) { dl.value = null; return; }
          dl.value = { name: p.name, received: p.received, total: p.total, pct: p.pct };
        });
        api.on('update.downloaded', (p) => {
          dl.value = { done: true, name: p.name, version: p.version };
          toast(`v${p.version} 安装包下载完成，可以安装`, 'ok');
        });
        api.on('update.error', (p) => {
          dl.value = null;
          toast('下载失败：' + (p.message || ''), 'warn');
        });
        pollRz();
        setInterval(pollRz, 5000);
      });

      // ---- 服务器模式 ----
      const serverAddr = computed(() => `${store.settings.localIp || store.self.host}:${store.self.port}`);
      async function copyServerAddr() {
        await api.invoke('clip:write', `http://${serverAddr.value}`);
        toast('服务地址已复制', 'ok');
      }

      // ---- 会合点状态灯 ----
      const rzStatus = ref(null); // {enabled, connected, lastSync, lastError, peers}
      async function pollRz() {
        try {
          const r = await fetch(`http://127.0.0.1:${store.self.port}/api/rendezvous/status`);
          if (r.ok) rzStatus.value = await r.json();
        } catch (e) {}
      }
      const fmtTs = (ts) => {
        if (!ts) return '从未';
        const s = Math.round((Date.now() - ts) / 1000);
        return s < 60 ? `${s}s 前` : s < 3600 ? `${Math.round(s / 60)}min 前` : `${Math.round(s / 3600)}h 前`;
      };
      function openAdmin() {
        api.invoke('engine:openExternal', `http://${serverAddr.value}/admin`);
      }
      // 启动时静默自动检查（24h 节流，由引擎控制）
      checkUpdate(true);

      return { store, save, onText, onCheck, onTheme, fps, copy, onHttps, httpsChanged, relaunch, diag, diagRunning, runDiag, openLogsDir, rzStatus, fmtTs,
               updateInfo, checking, checkUpdate, openUpdateUrl, serverAddr, copyServerAddr, openAdmin,
               dl, startDownload, abortDownload, installNow };
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
            <label class="field">主题
              <select :value="store.settings.theme || 'system'" @change="onTheme($event)" style="width:110px">
                <option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option>
              </select>
            </label>
          </div>
          <div class="muted" style="margin-top:6px">主题切换即时生效；「跟随系统」下界面随操作系统的浅/深色自动切换</div>
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
          <h3>同步与投送</h3>
          <div class="row">
            <label class="row" style="gap:6px"><input type="checkbox" :checked="store.settings.clipboardSync" @change="onCheck($event,'clipboardSync')" /> 跨设备同步剪贴板（复制即同步）</label>
            <label class="row" style="gap:6px"><input type="checkbox" :checked="store.settings.autoAcceptDrop" @change="onCheck($event,'autoAcceptDrop')" /> 自动接收其他设备的投送文件</label>
            <label class="field">接收配额（GB，超出按最旧文件自动清理）<input type="number" min="0.5" step="0.5" style="width:100px" :value="store.settings.dropQuotaGB" @change="onText($event,'dropQuotaGB')" /></label>
            <label class="field">投送 PIN（对方投送给本机时需提供；本机投送给对方时自动携带）<input type="text" :value="store.settings.dropPin" @change="onText($event,'dropPin')" style="width:160px" placeholder="留空不启用" /></label>
            <label class="row" style="gap:6px"><input type="checkbox" :checked="store.settings.upnp !== false" @change="onCheck($event,'upnp')" /> UPnP 自动端口映射（路由器支持时跨网段可直连满速传输；失败自动走会合点中继）</label>
            <label class="row" style="gap:6px"><input type="checkbox" :checked="store.settings.localsend !== false" @change="onCheck($event,'localsend')" /> LocalSend 互通（与 LocalSend 官方客户端互相发现、互传文件；切换后重启生效）</label>
            <label class="field">设备别名（对端看到的友好名称，留空用主机名）<input type="text" :value="store.settings.deviceAlias" @change="onText($event,'deviceAlias')" style="width:180px" placeholder="例：书房台式机" /></label>
            <label class="field">设备类型<select :value="store.settings.deviceType" @change="onText($event,'deviceType')" style="width:130px"><option value="">自动（按系统推断）</option><option value="pc">台式机</option><option value="laptop">笔记本</option><option value="phone">手机/平板</option><option value="nas">NAS/服务器</option></select></label>
            <label class="field">跨网段会合点（中心端 IP:端口，逗号分隔；填光猫层 NAS 地址即可打通双路由器不同网段）<input type="text" :value="store.settings.rendezvous" @change="onText($event,'rendezvous')" placeholder="例：192.168.10.5:8080" /></label>
          </div>
          <div class="muted" style="margin-top:6px" v-if="rzStatus && rzStatus.enabled">
            <span :style="{color: rzStatus.connected ? '#1a9e55' : '#d9534f'}">{{ rzStatus.connected ? '● 已连接' : '● 不可达' }}</span>
            <span v-if="rzStatus.connected">对端 {{ rzStatus.peers }} 台 · 最后同步 {{ fmtTs(rzStatus.lastSync) }}</span>
            <span v-else>原因：{{ rzStatus.lastError || '未知' }}（检查中心端地址/防火墙/服务是否启动）</span>
          </div>
          <div class="muted" style="margin-top:8px">剪贴板同步仅在桌面客户端之间生效；接收的文件保存在数据目录的 received 文件夹</div>
        </div>

        <div class="card">
          <h3>启动与托盘</h3>
          <div class="row">
            <label class="row" style="gap:6px"><input type="checkbox" :checked="store.settings.startup" @change="onCheck($event,'startup')" /> 开机自启动</label>
            <label class="row" style="gap:6px"><input type="checkbox" :checked="store.settings.minimizeToTray" @change="onCheck($event,'minimizeToTray')" /> 关闭时最小化到托盘</label>
          </div>
        </div>

        <div class="card">
          <h3>传输与安全</h3>
          <div class="row">
            <label class="row" style="gap:6px"><input type="checkbox" :checked="store.settings.https" @change="onHttps($event)" /> HTTPS 加密传输（自签证书，重启生效）</label>
            <button class="btn sm ghost" @click="relaunch" v-if="httpsChanged">🔄 立即重启生效</button>
          </div>
          <div class="muted" style="margin-top:8px">开启后：屏幕共享与“添加到主屏幕（PWA）”可用，传输全程加密；手机首次访问需在浏览器中信任证书警告</div>
        </div>

        <div class="card">
          <h3>服务器模式</h3>
          <div class="row" style="align-items:center">
            <label class="row" style="gap:6px"><input type="checkbox" :checked="store.settings.serverMode" @change="onCheck($event,'serverMode')" /> 以文件服务器方式运行（启动时不弹主界面，后台共享服务持续运行）</label>
          </div>
          <div class="row" style="margin-top:8px;align-items:center">
            <span class="muted">服务地址：</span><span class="mono" style="font-size:12px">http://{{ serverAddr }}</span>
            <button class="btn ghost sm" @click="copyServerAddr">复制</button>
            <button class="btn ghost sm" @click="openAdmin">打开管理控制台</button>
          </div>
          <div class="muted" style="margin-top:6px">开启后可把本机当作局域网文件服务器：配合开机自启动，设备开机即自动提供共享与会话服务；管理/设置随时通过托盘或管理控制台完成。会话中的文件由发送方设备点对点提供下载。</div>
        </div>

        <div class="card">
          <h3>更新</h3>
          <div class="row" style="align-items:center">
            <span class="muted">当前版本 v{{ store.self.version }}</span>
            <button class="btn sm" @click="checkUpdate(false)" :disabled="checking">{{ checking ? '检查中…' : '检查更新' }}</button>
            <label class="row" style="gap:6px"><input type="checkbox" :checked="store.settings.autoUpdateCheck" @change="onCheck($event,'autoUpdateCheck')" /> 自动检查（每天一次）</label>
          </div>
          <div v-if="updateInfo && updateInfo.checked && updateInfo.hasUpdate" class="row" style="margin-top:8px;align-items:center">
            <span style="color:var(--ok,#16a34a);font-weight:600">🎉 新版本 v{{ updateInfo.latest }} 可用</span>
            <template v-if="!dl">
              <button class="btn sm" @click="startDownload">⬇ 下载并安装</button>
              <button class="btn sm ghost" @click="openUpdateUrl">前往网页下载</button>
            </template>
          </div>
          <div v-else-if="updateInfo && updateInfo.checked" class="muted" style="margin-top:8px">已是最新版本</div>
          <div v-if="dl && dl.starting" class="muted" style="margin-top:8px">正在获取下载地址…</div>
          <div v-if="dl && dl.pct != null" style="margin-top:10px">
            <div class="t-row">
              <span style="font-size:13px;font-weight:600">{{ dl.name }}</span>
              <span class="muted">{{ formatBytes(dl.received) }} / {{ formatBytes(dl.total) }}（支持断点续传）</span>
              <span style="flex:1"></span>
              <button class="btn ghost sm" @click="abortDownload">取消</button>
            </div>
            <div class="t-bar"><div class="t-fill" :style="{ width: dl.pct + '%' }"></div></div>
          </div>
          <div v-if="dl && dl.done" class="row" style="margin-top:10px;align-items:center">
            <span style="color:var(--ok,#16a34a);font-weight:600">✅ v{{ dl.version }} 安装包已就绪</span>
            <button class="btn" @click="installNow">🔄 安装并重启</button>
          </div>
          <div class="muted" style="margin-top:6px">版本发布地址：github.com/DGameking/lan-file-share/releases</div>
        </div>

        <div class="card">
          <h3>诊断与修复</h3>
          <div class="row" style="align-items:center">
            <button class="btn sm" @click="runDiag" :disabled="diagRunning">{{ diagRunning ? '自检中…' : '🔍 一键自检与修复' }}</button>
            <button class="btn ghost sm" @click="openLogsDir">打开运行日志文件夹</button>
            <span v-if="diag" :style="{ color: diag.ok ? 'var(--ok,#16a34a)' : '#dc2626', fontWeight: 600 }">{{ diag.summary }}</span>
          </div>
          <table v-if="diag && diag.checks.length" style="margin-top:10px">
            <thead><tr><th>检查项</th><th>状态</th><th>说明</th></tr></thead>
            <tbody>
              <tr v-for="(c, i) in diag.checks" :key="i">
                <td>{{ c.name }}</td>
                <td><span class="tag" :class="c.ok ? 'green' : 'red'">{{ c.ok ? '正常' : '异常' }}</span><span v-if="c.fixed" class="tag green" style="margin-left:4px">已自动修复</span></td>
                <td class="muted" style="font-size:12px">{{ c.detail }}</td>
              </tr>
            </tbody>
          </table>
          <div class="muted" style="margin-top:8px">自检覆盖：数据目录 / 数据库 / 发现服务 / 会话桥 / 接收目录 / 磁盘空间，可修复项自动处理</div>
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

  // ---------------- 投送（一拖一放发文件到指定设备） ----------------
  const DropView = defineComponent({
    setup() {
      const dragDevice = ref(null); // 正被拖拽悬停的设备 id
      const dragAny = ref(false);
      const transfers = ref([]); // {key,name,size,pct,to,status}
      const received = ref([]); // 收到的投送 {from, files, ts}
      const clipText = ref('');
      let seq = 0;

      const onlineDevices = computed(() =>
        store.devices.filter((d) => d.is_online && !d.is_blacklisted && d.device_id !== store.self.deviceId)
      );

      async function loadClip() {
        const r = await api.invoke('clip:read');
        if (r.ok) clipText.value = r.data || '';
      }

      function sendToDevice(d, files) {
        // v1.19.0：LocalSend 互通设备走专属通道（主进程代发，自签 HTTPS）
        if (d.via === 'localsend') {
          sendViaLocalSend(d, files);
          return;
        }
        for (const f of files) {
          const t = reactive({ key: ++seq, name: f.name, size: f.size, pct: 0, to: d.device_name, status: 'uploading' });
          transfers.value.unshift(t);
          if (transfers.value.length > 30) transfers.value.pop();
          uploadOne(d, f, t);
        }
      }

      // LocalSend 设备投送：逐文件经主进程 prepare→upload
      async function sendViaLocalSend(d, files) {
        for (const f of files) {
          const t = reactive({ key: ++seq, name: f.name, size: f.size, pct: 50, to: d.device_name + '（LocalSend）', status: 'uploading' });
          transfers.value.unshift(t);
          if (transfers.value.length > 30) transfers.value.pop();
          try {
            const r = await api.invoke('localsend:send', {
              host: d.host,
              port: d.port || 53317,
              protocol: d.ls_protocol || 'https',
              files: [{ path: f.path || '', name: f.name, size: f.size, mime: f.type || '' }],
            });
            if (r && r.ok) {
              t.pct = 100;
              t.status = 'done';
            } else {
              t.status = 'failed';
              t.error = (r && r.error) || '发送失败';
              toast(`向「${d.device_name}」投送失败：${t.error}`, 'warn');
            }
          } catch (e) {
            t.status = 'failed';
            t.error = e.message;
            toast(`向「${d.device_name}」投送失败：${e.message}`, 'warn');
          }
        }
      }

      // 单文件上传：小文件直传；大文件（>16MB）自动分块（8MB/块），失败重试、支持断点续传
      const CHUNK_THRESHOLD = 16 * 1024 * 1024;
      const CHUNK_SIZE = 8 * 1024 * 1024;
      const base = (d) => `http://${d.host}:${d.port}`;

      // PIN 改走请求头传递（避免明文出现在 URL 被日志/嗅探泄露）
      const pinHeaders = () => (store.settings.dropPin ? { 'X-LFS-Pin': store.settings.dropPin } : {});

      // 小文件（≤64MB）计算 sha256 用于接收端完整性校验
      async function sha256Hex(f) {
        if (f.size > 64 * 1024 * 1024) return '';
        try {
          const buf = await f.arrayBuffer();
          const h = await crypto.subtle.digest('SHA-256', buf);
          return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
        } catch (e) { return ''; }
      }

      // 元数据先行：请求对端审批（对方关闭自动接收时会弹确认框），返回 sessionId
      async function prepareDrop(d, files, text) {
        let r;
        try {
          r = await fetch(`${base(d)}/api/drop/prepare`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...pinHeaders() },
            body: JSON.stringify({ from: store.self.deviceName || '', files, text: !!text }),
          });
        } catch (e) { throw new Error('network'); }
        if (r.status === 401) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error === 'bad_pin' ? 'PIN 码不正确' : '对方要求 PIN，请让对方在设置中告知，或在本机"设置→投送 PIN"填写后重试');
        }
        if (!r.ok && r.status !== 202) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        if (j.accepted) return j.sessionId;
        const sid = j.sessionId;
        toast(`等待「${d.device_name}」确认接收…`, 'warn');
        for (let i = 0; i < 40; i++) {
          await new Promise((res2) => setTimeout(res2, 1500));
          try {
            const st = await (await fetch(`${base(d)}/api/drop/session?sessionId=${sid}`)).json();
            if (st.status === 'accepted') return sid;
            if (st.status === 'declined') throw new Error('对方已拒绝');
            if (st.status === 'expired') throw new Error('对方未响应，已超时');
          } catch (e) {
            if (String(e.message).indexOf('network') === -1) throw e;
          }
        }
        throw new Error('等待确认超时');
      }

      function stableUploadId(d, f) {
        const s = `${d.device_id}|${f.name}|${f.size}|${f.lastModified || ''}`;
        let h = 5381;
        for (let i = 0; i < s.length; i++) h = (((h << 5) + h + s.charCodeAt(i)) >>> 0);
        return 'u' + h.toString(36) + s.length.toString(36);
      }

      // 中继路由：对端跨网段（经会合点发现）；大文件（>16MB）分块上传支持断点续传，小文件整文件直传
      async function relayOne(d, fileLike, name) {
        const hub = d.relay_hub || d.relayHub || `${d.host}:${d.port}`;
        if (fileLike.size > CHUNK_THRESHOLD) {
          const uploadId = 'r' + stableUploadId(d, fileLike).slice(1);
          const total = Math.ceil(fileLike.size / CHUNK_SIZE);
          let have = new Set();
          try {
            const st = await (await fetch(`http://${hub}/api/hub/relay-chunk/status?uploadId=${uploadId}`)).json();
            if (st.ok) have = new Set(st.received || []);
          } catch (e) {}
          for (let i = 0; i < total; i++) {
            if (have.has(i)) continue;
            const blob = fileLike.slice(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, fileLike.size));
            const csha = await sha256Hex(blob);
            let ok = false, lastErr = null;
            for (let retry = 0; retry < 3 && !ok; retry++) {
              try {
                const res = await fetch(`http://${hub}/api/hub/relay-chunk?uploadId=${uploadId}&index=${i}${csha ? `&sha256=${csha}` : ''}`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/octet-stream' },
                  body: blob,
                });
                ok = res.ok;
                if (!ok) lastErr = new Error('HTTP ' + res.status);
              } catch (e) { lastErr = e; }
              if (!ok) await new Promise((r) => setTimeout(r, 800 * (retry + 1)));
            }
            if (!ok) throw lastErr || new Error('relay_chunk_failed');
          }
          const fsha = await sha256Hex(fileLike); // ≤64MB 时提供全量校验
          const fin = await fetch(`http://${hub}/api/hub/relay-chunk/finish?target=${encodeURIComponent(d.device_id)}&from=${encodeURIComponent(store.self.deviceName || '')}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uploadId, name: name || fileLike.name, total, size: fileLike.size, sha256: fsha, mtime: fileLike.lastModified || 0 }),
          });
          if (!fin.ok) throw new Error('relay_finish HTTP ' + fin.status);
          return;
        }
        const sha = await sha256Hex(fileLike);
        await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          const fd = new FormData();
          fd.append('file', fileLike, name || fileLike.name);
          xhr.open('POST', `http://${hub}/api/hub/relay?target=${encodeURIComponent(d.device_id)}&from=${encodeURIComponent(store.self.deviceName || '')}&sha256=${sha}&mtime=${fileLike.lastModified || ''}`);
          xhr.onload = () => (xhr.status === 200 ? resolve() : reject(new Error('HTTP ' + xhr.status)));
          xhr.onerror = () => reject(new Error('network'));
          xhr.send(fd);
        });
      }

      // 中继设备直连探测：对端有 UPnP 映射（direct_port=网关 WAN 侧端口）时优先直连（满速），失败回退中继
      const directCache = new Map(); // deviceId -> true/false
      async function directView(d) {
        if (!d.relay || !d.direct_port) return d;
        if (directCache.get(d.device_id)) return { ...d, port: d.direct_port, relay: false, viaDirect: true };
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 1500);
          const r = await fetch(`http://${d.host}:${d.direct_port}/api/self`, { signal: ctrl.signal });
          clearTimeout(t);
          if (r.ok) {
            directCache.set(d.device_id, true);
            return { ...d, port: d.direct_port, relay: false, viaDirect: true };
          }
        } catch (e) {}
        directCache.set(d.device_id, false);
        return d;
      }

      async function uploadOne(d0, f, t) {
        const d = await directView(d0);
        try {
          if (d.relay) {
            await relayOne(d, f, f.name);
            t.status = 'done'; t.pct = 100;
            toast(`已中继投送给「${d.device_name}」：${f.name}`, 'ok');
            return;
          }
          const viaTag = d.viaDirect ? '（直连）' : '';
          if (f.size <= CHUNK_THRESHOLD) {
            const sha = await sha256Hex(f);
            const sid = await prepareDrop(d, [{ name: f.name, size: f.size, sha256: sha, mime: f.type || 'application/octet-stream' }], false);
            await new Promise((resolve, reject) => {
              const xhr = new XMLHttpRequest();
              const fd = new FormData();
              fd.append('file', f, f.name);
              xhr.open('POST', `${base(d)}/api/drop?from=${encodeURIComponent(store.self.deviceName || '')}&sessionId=${sid}&sha256=${sha}&mtime=${f.lastModified || ''}`);
              if (store.settings.dropPin) xhr.setRequestHeader('X-LFS-Pin', store.settings.dropPin);
              xhr.upload.onprogress = (e) => { if (e.lengthComputable) t.pct = Math.round((e.loaded / e.total) * 100); };
              xhr.onload = () => (xhr.status === 200 ? resolve() : reject(new Error('HTTP ' + xhr.status)));
              xhr.onerror = () => reject(new Error('network'));
              xhr.send(fd);
            });
            t.status = 'done'; t.pct = 100;
            toast(`已投送给「${d.device_name}」${viaTag}：${f.name}`, 'ok');
            return;
          }

          // 分块续传
          const sid = await prepareDrop(d, [{ name: f.name, size: f.size, sha256: '', mime: f.type || 'application/octet-stream' }], false);
          const uploadId = stableUploadId(d, f);
          const total = Math.ceil(f.size / CHUNK_SIZE);
          let have = new Set();
          try {
            const st = await (await fetch(`${base(d)}/api/drop/chunk/status?uploadId=${uploadId}`)).json();
            if (st.ok) have = new Set(st.received || []);
          } catch (e) {}
          for (let i = 0; i < total; i++) {
            if (have.has(i)) { t.pct = Math.round(((i + 1) / total) * 100); continue; }
            const start = i * CHUNK_SIZE;
            const blob = f.slice(start, Math.min(start + CHUNK_SIZE, f.size));
            const csha = await sha256Hex(blob); // 逐块摘要，接收端逐块校验
            let ok = false, lastErr = null;
            for (let retry = 0; retry < 3 && !ok; retry++) {
              try {
                const res = await fetch(`${base(d)}/api/drop/chunk?uploadId=${uploadId}&index=${i}&sessionId=${sid}${csha ? `&sha256=${csha}` : ''}`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/octet-stream', ...pinHeaders() },
                  body: blob,
                });
                ok = res.ok;
                if (!ok) lastErr = new Error('HTTP ' + res.status);
              } catch (e) { lastErr = e; }
              if (!ok) await new Promise((r) => setTimeout(r, 800 * (retry + 1)));
            }
            if (!ok) throw lastErr || new Error('chunk_failed');
            t.pct = Math.round(((i + 1) / total) * 100);
          }
          const fin = await fetch(`${base(d)}/api/drop/finish?from=${encodeURIComponent(store.self.deviceName || '')}&sessionId=${sid}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...pinHeaders() },
            body: JSON.stringify({ uploadId, name: f.name, total, size: f.size, from: store.self.deviceName || '', mtime: f.lastModified || 0 }),
          });
          if (!fin.ok) throw new Error('finish HTTP ' + fin.status);
          t.status = 'done'; t.pct = 100;
          toast(`已投送给「${d.device_name}」${viaTag}：${f.name}`, 'ok');
        } catch (e) {
          t.status = 'error';
          toast(`投送失败：${f.name}（${e.message || '网络错误'}）`, 'warn');
        }
      }

      function onDropDevice(d, e) {
        e.preventDefault();
        dragDevice.value = null; dragAny.value = false;
        const files = [...(e.dataTransfer ? e.dataTransfer.files : [])];
        if (files.length) sendToDevice(d, files);
      }
      function onDragOver(d, e) { e.preventDefault(); dragDevice.value = d.device_id; }
      function onDragLeave() { dragDevice.value = null; }

      async function sendClip(d0) {
        const d = await directView(d0);
        const r = await api.invoke('clip:read');
        if (!r.ok || !r.data) return toast('本机剪贴板为空', 'warn');
        try {
          if (d.relay) {
            const file = new File([new Blob([r.data], { type: 'text/plain' })], '剪贴板.txt', { type: 'text/plain', lastModified: Date.now() });
            await relayOne(d, file, '剪贴板.txt');
            toast(`剪贴板已中继投送给「${d.device_name}」`, 'ok');
            return;
          }
          const sid = await prepareDrop(d, [], true);
          const res = await fetch(`${base(d)}/api/drop?from=${encodeURIComponent(store.self.deviceName || '')}&sessionId=${sid}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...pinHeaders() },
            body: JSON.stringify({ text: r.data, from: store.self.deviceName || '' }),
          });
          if (res.ok) toast(`剪贴板已投送给「${d.device_name}」`, 'ok');
          else toast('投送失败', 'warn');
        } catch (e) { toast('投送失败: ' + e.message, 'warn'); }
      }

      async function openReceived() { await api.invoke('engine:openReceivedFolder'); }
      async function openRecvFile(f) {
        const r = await api.invoke('engine:openReceivedFile', f.fileId);
        if (!r.ok) toast('打开失败（文件可能已被移动或删除）', 'warn');
      }
      async function saveRecvAs(f) {
        const r = await api.invoke('engine:saveReceivedAs', f.fileId);
        if (r.ok && r.data) toast('已另存到 ' + r.data, 'ok');
        else if (!r.ok) toast('另存失败', 'warn');
      }
      async function delRecvFile(f, r) {
        const res = await api.invoke('engine:deleteReceivedFile', f.fileId);
        if (res.ok) {
          const i = r.files.indexOf(f);
          if (i > -1) r.files.splice(i, 1);
          toast('已删除（移入回收站）', 'ok');
        } else toast('删除失败', 'warn');
      }
      async function clearReceivedHistory() {
        try { await fetch(`http://127.0.0.1:${store.self.port}/api/drop/history`, { method: 'DELETE' }); } catch (e) {}
        received.value = [];
        toast('接收记录已清空（文件仍保留在接收文件夹中）', 'ok');
      }

      onMounted(() => {
        loadClip();
        // 启动时加载持久化接收历史（重启不丢），按 3 秒窗口聚合同批文件
        (async () => {
          try {
            const r = await fetch(`http://127.0.0.1:${store.self.port}/api/drop/history?limit=200`);
            if (!r.ok) return;
            const j = await r.json();
            const groups = [];
            for (const it of (j.items || []).slice().reverse()) {
              const last = groups[groups.length - 1];
              const f = { fileId: it.file_id, name: it.name, size: it.size, isText: !!it.is_text };
              if (last && last.from === it.from_name && Math.abs(last.ts - it.ts) < 3000) last.files.push(f);
              else groups.push({ from: it.from_name || '未知设备', ts: it.ts, files: [f] });
            }
            received.value = groups.reverse();
          } catch (e) {}
        })();
        api.on('drop.incoming', (p) => {
          received.value.unshift(p);
          if (received.value.length > 200) received.value.length = 200;
          const names = (p.files || []).map((f) => f.name).join('、');
          toast(`「${p.from}」投送了 ${p.files.length} 个文件：${names}`, 'ok');
        });
        // 投送审批：对方关闭自动接收时，本机弹确认框
        api.on('drop.request', async (p) => {
          const names = (p.files || []).map((f) => f.name).join('、') || '（无文件名）';
          const desc = p.text ? '剪贴板文本' : `${(p.files || []).length} 个文件：${names}`;
          let ok = false;
          try { ok = window.confirm(`「${p.from}」想投送${desc}\n是否接收？`); } catch (e) { ok = true; }
          try {
            await fetch(`http://127.0.0.1:${store.self.port}/api/drop/decision`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionId: p.sessionId, accept: ok }),
            });
          } catch (e) {}
          toast(ok ? `已同意「${p.from}」的投送` : `已拒绝「${p.from}」的投送`, ok ? 'ok' : 'warn');
        });
        api.on('clip-incoming', (p) => toast(`已同步「${p.deviceName}」的剪贴板`, 'ok'));
      });

      // v1.20.0 LocalSend 拉取链接：选文件生成 URL，LS 设备/浏览器可下载
      async function createLsOffer() {
        const r = await api.invoke('localsend:createOffer', {});
        if (!r.ok) { toast('生成失败：' + (r.error === 'no_valid_files' ? '没有可用文件' : r.error), 'warn'); return; }
        if (!r.data) return; // 用户取消
        try { await navigator.clipboard.writeText(r.data.url); } catch (e) {}
        toast(`拉取链接已复制（${Object.keys(r.data.files).length} 个文件，10 分钟内有效）：${r.data.url}`, 'ok');
      }

      return { store, onlineDevices, dragDevice, dragAny, transfers, received, clipText, onDropDevice, onDragOver, onDragLeave, sendClip, openReceived, clearReceivedHistory, openRecvFile, saveRecvAs, delRecvFile, createLsOffer };
    },
    template: `
      <div>
        <div class="card drop-card">
          <h3>🚀 快速投送 <button class="btn sm ghost" style="float:right" @click="createLsOffer">🔗 LocalSend 拉取链接</button></h3>
          <div class="muted" style="margin-bottom:12px">把文件拖到下方设备卡片上即可直接发送，对方立即收到并弹出通知（无需共享文件夹）；也可生成拉取链接让 LocalSend 设备来下载</div>
          <div v-if="onlineDevices.length === 0" class="empty">局域网中暂无其他在线设备 — 等待设备自动发现…</div>
          <div v-else class="device-grid">
            <div v-for="d in onlineDevices" :key="d.device_id" class="device-card"
                 :class="{ hover: dragDevice === d.device_id }"
                 @dragover="onDragOver(d, $event)" @dragleave="onDragLeave" @drop="onDropDevice(d, $event)">
              <div class="dc-head">
                <span class="dc-avatar">{{ (d.device_name || '?').slice(0,1).toUpperCase() }}</span>
                <div class="dc-info">
                  <div class="dc-name">{{ d.device_name }} <span v-if="d.via === 'localsend'" class="tag blue" title="LocalSend 互通设备">LS</span></div>
                  <div class="dc-os">{{ d.os || '-' }} · {{ d.host }}</div>
                </div>
                <span class="tag green">在线</span>
              </div>
              <div class="dc-actions">
                <button class="btn sm ghost" @click="sendClip(d)">📋 投送剪贴板</button>
              </div>
              <div class="dc-hint">{{ d.via === 'localsend' ? '拖放文件（经 LocalSend 协议发送）' : '拖放文件到此处发送' }}</div>
            </div>
          </div>
        </div>

        <div class="card" v-if="transfers.length">
          <h3>传输记录</h3>
          <div class="transfer" v-for="t in transfers" :key="t.key">
            <div class="t-row">
              <span class="t-name">{{ t.name }}</span>
              <span class="muted">→ {{ t.to }} · {{ formatBytes(t.size) }}</span>
              <span style="flex:1"></span>
              <span class="tag" :class="t.status==='done' ? 'green' : t.status==='error' ? 'red' : 'blue'">
                {{ t.status==='done' ? '完成' : t.status==='error' ? '失败' : t.pct + '%' }}
              </span>
            </div>
            <div class="t-bar"><div class="t-fill" :class="{ err: t.status==='error' }" :style="{ width: (t.status==='done' ? 100 : t.pct) + '%' }"></div></div>
          </div>
        </div>

        <div class="card">
          <div class="row" style="justify-content:space-between">
            <h3 style="margin:0">📥 收到的投送（{{ received.length }}）</h3>
            <div class="row" style="gap:6px">
              <button class="btn ghost sm" @click="clearReceivedHistory">清空记录</button>
              <button class="btn ghost sm" @click="openReceived">打开接收文件夹</button>
            </div>
          </div>
          <div v-if="received.length === 0" class="empty">暂无收到文件 — 其他设备投送的文件会保存在这里</div>
          <div v-else class="recv-list">
            <div v-for="(r, i) in received" :key="i" class="recv-item">
              <span class="tag blue">{{ r.from }}</span>
              <span v-for="f in r.files" :key="f.fileId" class="recv-file">{{ f.name }} <span class="muted">({{ formatBytes(f.size) }})</span>
                <a class="recv-act" @click="openRecvFile(f)">打开</a><a class="recv-act" @click="saveRecvAs(f)">另存</a><a class="recv-act" style="color:#d9534f" @click="delRecvFile(f, r)">删除</a>
              </span>
            </div>
          </div>
        </div>
      </div>
    `,
  });

  // ---------------- 主题（v1.15.0：跟随系统/浅色/深色） ----------------
  // settings.theme: 'system' | 'light' | 'dark'；system 时移除 data-theme 交给 prefers-color-scheme
  function applyTheme(mode) {
    const m = mode || 'system';
    const root = document.documentElement;
    root.removeAttribute('data-theme');
    if (m === 'dark') root.setAttribute('data-theme', 'dark');
    else if (m === 'light') root.setAttribute('data-theme', 'light');
    if (window.lan && window.lan.setTheme) window.lan.setTheme(m); // 同步标题栏配色
  }

  // ---------------- 根组件 ----------------
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
