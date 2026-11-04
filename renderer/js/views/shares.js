'use strict';

/* 共享管理视图 */
(function () {
  const { defineComponent, ref, reactive, onMounted, computed } = Vue;
  const { api, toast, copy, store, refresh, fmtTime, formatBytes, formatSpeed, applyTheme } = window.LfsCore;

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


  (window.LfsViews = window.LfsViews || {}).SharesView = SharesView;
})();
