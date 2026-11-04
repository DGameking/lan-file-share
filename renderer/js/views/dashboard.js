'use strict';

/* 概览视图 */
(function () {
  const { defineComponent, ref, reactive, onMounted, computed } = Vue;
  const { api, toast, copy, store, refresh, fmtTime, formatBytes, formatSpeed, applyTheme } = window.LfsCore;

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


  (window.LfsViews = window.LfsViews || {}).Dashboard = Dashboard;
})();
