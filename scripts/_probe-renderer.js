// 最小复现：加载 renderer/index.html，捕获渲染层 console/错误，输出到 stdout
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 800 });
  const wc = win.webContents;
  wc.on('console-message', (_e, level, message, line, sourceId) => {
    console.log('[console][' + level + '] ' + message + '  @' + sourceId + ':' + line);
  });
  wc.on('did-fail-load', (_e, code, desc, url) => {
    console.log('[did-fail-load]', code, desc, url);
  });
  wc.on('render-process-gone', (_e, details) => {
    console.log('[render-process-gone]', JSON.stringify(details));
  });
  wc.on('preload-error', (_e, p, err) => {
    console.log('[preload-error]', p, err.message);
  });
  wc.on('did-finish-load', () => {
    // 检查 Vue 是否真的挂载：读取 #app 的 innerHTML 长度与关键节点
    wc.executeJavaScript(`
      (function(){
        const app=document.querySelector('#app');
        return {
          title: document.title,
          hasVue: typeof window.Vue !== 'undefined',
          appChildCount: app ? app.children.length : -1,
          appHtmlLen: app ? app.innerHTML.length : -1,
          bodyText: (document.body.innerText||'').slice(0,120)
        };
      })()
    `).then(r => {
      console.log('[DOM probe]', JSON.stringify(r));
      app.quit();
    }).catch(e => { console.log('[probe error]', e.message); app.quit(); });
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  setTimeout(() => { console.log('[timeout] quitting'); app.quit(); }, 15000);
});
