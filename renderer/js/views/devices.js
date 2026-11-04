'use strict';

/* 设备视图 */
(function () {
  const { defineComponent, ref, reactive, onMounted, computed } = Vue;
  const { api, toast, copy, store, refresh, fmtTime, formatBytes, formatSpeed, applyTheme } = window.LfsCore;

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

      // ---- v1.21.0 设备卡右键菜单 ----
      const ctx = ref(null); // { x, y, d }
      const aliasEdit = ref(null); // { id, value }
      function openCtx(d, e) { ctx.value = { x: e.clientX, y: e.clientY, d }; }
      function closeCtx() { ctx.value = null; }
      async function ctxStar(d) { await star(d); }
      function ctxAlias(d) { aliasEdit.value = { id: d.device_id, value: d.alias || '' }; }
      async function aliasSave() {
        const a = aliasEdit.value; if (!a) return;
        const v = String(a.value || '').trim();
        const r = await api.invoke('engine:setDeviceAlias', a.id, v);
        if (r.ok) {
          const d = store.devices.find((x) => x.device_id === a.id);
          if (d) d.alias = v;
          toast(v ? '别名已保存' : '已恢复设备原名', 'ok');
        } else toast('保存失败: ' + r.error, 'warn');
        aliasEdit.value = null;
      }
      function ctxGoDrop() { closeCtx(); window.dispatchEvent(new CustomEvent('lfs-nav', { detail: 'drop' })); }
      function ctxCopyAddr(d) { copy(d.host + ':' + d.port); toast('地址已复制：' + d.host + ':' + d.port, 'ok'); }
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

      // 右键菜单点击他处/ESC 关闭
      onMounted(() => {
        document.addEventListener('click', closeCtx);
        document.addEventListener('contextmenu', (e) => { if (!e.target.closest('.dev-card')) closeCtx(); });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeCtx(); aliasEdit.value = null; } });
      });

      return { store, host, port, inviteCode, myInvite, ping, trust, blacklist, star, connect, discover, createInvite, joinInvite, copy,
               fpFmt, sortedDevices, onlineCount, copyFp, typeIcon,
               ctx, aliasEdit, openCtx, closeCtx, ctxStar, ctxAlias, aliasSave, ctxGoDrop, ctxCopyAddr };
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
            <div class="dev-card" v-for="d in sortedDevices" :key="d.device_id" :class="{ off: !d.is_online }"
                 @contextmenu.prevent="openCtx(d, $event)">
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
          <div class="muted" style="margin-top:8px">💡 右键点击设备卡片可打开快捷菜单（收藏 / 别名 / 复制地址 / 信任 / 拉黑 / 去投送）</div>
        </div>

        <!-- v1.21.0 设备卡右键菜单 -->
        <div v-if="ctx" class="ctx-menu" :style="{ left: ctx.x + 'px', top: ctx.y + 'px' }" @click.stop>
          <div class="ctx-title">{{ ctx.d.alias || ctx.d.device_name }}</div>
          <button class="ctx-item" @click="ctxStar(ctx.d); closeCtx()">{{ ctx.d.starred ? '☆ 取消收藏' : '★ 收藏置顶' }}</button>
          <button class="ctx-item" @click="ctxAlias(ctx.d); closeCtx()">✏️ 设置别名…</button>
          <button class="ctx-item" @click="ping(ctx.d.device_id); closeCtx()">📡 Ping 测延迟</button>
          <button class="ctx-item" @click="ctxCopyAddr(ctx.d); closeCtx()">📋 复制 IP:端口</button>
          <button class="ctx-item" @click="ctxGoDrop()">🚀 去投送</button>
          <div class="ctx-sep"></div>
          <button class="ctx-item" v-if="!ctx.d.is_trusted" @click="trust(ctx.d.device_id, true); closeCtx()">🤝 信任此设备</button>
          <button class="ctx-item" v-else @click="trust(ctx.d.device_id, false); closeCtx()">🔓 取消信任</button>
          <button class="ctx-item danger" v-if="!ctx.d.is_blacklisted" @click="blacklist(ctx.d.device_id, true); closeCtx()">🚫 拉黑此设备</button>
          <button class="ctx-item" v-else @click="blacklist(ctx.d.device_id, false); closeCtx()">✅ 解除拉黑</button>
        </div>

        <!-- v1.21.0 别名编辑弹窗 -->
        <div v-if="aliasEdit" class="modal-mask" @click.self="aliasEdit = null">
          <div class="modal" style="width:360px">
            <h3 style="margin-top:0">✏️ 设置设备别名</h3>
            <div class="muted" style="margin-bottom:10px">仅本机显示的友好名称，留空恢复设备原名</div>
            <input type="text" v-model="aliasEdit.value" style="width:100%" maxlength="40"
                   placeholder="例：客厅电视 / 老爸手机" @keydown.enter="aliasSave" />
            <div class="row" style="justify-content:flex-end;margin-top:14px;gap:8px">
              <button class="btn ghost" @click="aliasEdit = null">取消</button>
              <button class="btn" @click="aliasSave">保存</button>
            </div>
          </div>
        </div>
      </div>
    `,
  });


  (window.LfsViews = window.LfsViews || {}).DevicesView = DevicesView;
})();
