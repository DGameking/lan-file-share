'use strict';

/* 设置视图 */
(function () {
  const { defineComponent, ref, reactive, onMounted, computed } = Vue;
  const { api, toast, copy, store, refresh, fmtTime, formatBytes, formatSpeed, applyTheme } = window.LfsCore;

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
            <label class="field">LocalSend 拉取 PIN（生成拉取链接时自动附加，对方下载前需提供；留空则链接持有人即可下载）<input type="text" :value="store.settings.offerPin" @change="onText($event,'offerPin')" style="width:160px" placeholder="例：826419" /></label>
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


  (window.LfsViews = window.LfsViews || {}).SettingsView = SettingsView;
})();
