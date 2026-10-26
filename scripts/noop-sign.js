'use strict';
// 自定义 Windows 签名脚本（no-op）。
// 作用：让 electron-builder 跳过默认的 doSign 流程，
// 因而不再下载/解压 winCodeSign 工具链（沙箱环境无法创建其中的 darwin .dylib 符号链接）。
// 代价：产物不做 Authenticode 代码签名 —— 对本地分发/比赛演示无影响。
// rcedit 图标注入仍由 electron-builder 独立执行，不受此脚本影响。
module.exports = async function customSign(configuration) {
  // configuration.path 为待签名的文件；此处直接放行，不做任何签名操作。
  return;
};
