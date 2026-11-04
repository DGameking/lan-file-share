'use strict';

/* 投送视图 */
(function () {
  const { defineComponent, ref, reactive, onMounted, computed } = Vue;
  const { api, toast, copy, store, refresh, fmtTime, formatBytes, formatSpeed, applyTheme } = window.LfsCore;

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
      // v1.21.0 自动附加设置里的拉取 PIN（offerPin），无 PIN 的链接持有人即可下载
      async function createLsOffer() {
        const pin = String((store.settings && store.settings.offerPin) || '').trim();
        const r = await api.invoke('localsend:createOffer', { pin });
        if (!r.ok) { toast('生成失败：' + (r.error === 'no_valid_files' ? '没有可用文件' : r.error), 'warn'); return; }
        if (!r.data) return; // 用户取消
        try { await navigator.clipboard.writeText(r.data.url); } catch (e) {}
        toast(`拉取链接已复制（${Object.keys(r.data.files).length} 个文件，10 分钟内有效${pin ? '，需 PIN ' + pin : '，⚠️ 未设 PIN 任何持链接者可下载'}）：${r.data.url}`, 'ok');
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


  (window.LfsViews = window.LfsViews || {}).DropView = DropView;
})();
