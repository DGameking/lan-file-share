// 深度装配冒烟：加载全部分层文件后，逐个真实调用组件 setup()，捕捉未定义引用
const fs = require('fs'), vm = require('vm');
const Vue = {
  createApp: (comp) => { Vue.__APP__ = comp; return { mixin(){}, mount(){} }; },
  reactive: (x) => x,
  ref: (x) => ({ value: x }),
  computed: (f) => ({ value: (() => { try { return f(); } catch (e) { return undefined; } })() }),
  onMounted: (cb) => undefined,
  defineComponent: (o) => o,
};
const els = () => ({ style: {}, classList: { add(){}, remove(){}, toggle(){} }, remove() {}, appendChild() {}, addEventListener() {}, setAttribute() {}, textContent: '' });
const document = {
  querySelector: () => null,
  createElement: els,
  body: { appendChild() {}, classList: { add(){}, remove(){} } },
  documentElement: { removeAttribute() {}, setAttribute() {}, getAttribute: () => null },
  addEventListener() {},
};
const ctx = vm.createContext({
  window: { lan: { invoke: async () => ({ ok: true, data: {} }), onEvent: () => () => {}, setTheme() {} } },
  document, navigator: {}, console, setTimeout, setInterval, clearInterval, clearTimeout,
  Vue,
});
ctx.window.window = ctx.window;
for (const f of ['js/core.js','js/views/dashboard.js','js/views/shares.js','js/views/devices.js','js/views/settings.js','js/views/logs.js','js/views/chat.js','js/views/drop.js','js/app.js']) {
  vm.runInContext(fs.readFileSync('renderer/' + f, 'utf8'), ctx, { filename: f });
}
let fails = 0;
for (const n of Object.keys(vm.runInContext('window.LfsViews', ctx))) {
  try {
    const c = vm.runInContext(`window.LfsViews.${n}`, ctx);
    if (typeof c.setup === 'function') c.setup();
    console.log('OK  setup', n);
  } catch (e) { fails++; console.log('FAIL setup', n, '→', e.message); }
}
try { Vue.__APP__.setup(); console.log('OK  setup App'); }
catch (e) { fails++; console.log('FAIL setup App →', e.message); }
console.log(fails ? 'DEEP-SMOKE FAILED' : 'DEEP-SMOKE ALL OK');
process.exit(fails ? 1 : 0);
