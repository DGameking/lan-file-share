'use strict';

/* 日志视图 */
(function () {
  const { defineComponent, ref, reactive, onMounted, computed } = Vue;
  const { api, toast, copy, store, refresh, fmtTime, formatBytes, formatSpeed, applyTheme } = window.LfsCore;

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


  (window.LfsViews = window.LfsViews || {}).LogsView = LogsView;
})();
