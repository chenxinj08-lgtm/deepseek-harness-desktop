// 预加载:向页面暴露应用内角标的"下载安装/重启"点击 → 主进程(确认后执行)
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('dsh', {
  apply: () => ipcRenderer.send('apply-update'),
  reboot: () => ipcRenderer.send('dsh-reboot'),
})
