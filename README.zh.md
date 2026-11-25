# dsh-phone-bg

[English](README.md) · **中文**

**把 Android app 放进一块看不见的屏里操作——手机屏幕上正在发生的事，一行都不会被打断。**

> **`bg` 是 background（后台）**，指「后台屏」，不是「背景图」。`phone-bg` 读作
> *手机 → 后台那块屏*；所有工具名沿用同一个词根：`phone_bg_start`、`phone_bg_tap`、`phone_bg_shot`……

生态里现有的手机插件（dsh-phone-control / dsh-mobile-use / dsh-android-tool）都是「把手机镜像进
DSH，然后点主屏」：镜像只是让你看见，点击永远落在设备**当前前台**那个窗口上。用户正在用的东西
必然被顶走。

dsh-phone-bg 走的是另一条路：用 Android 的 **Virtual Display** 另开一块屏，把目标 app 启动到那块屏上。
截图、点击、输入全部发生在后台屏里，**物理屏（DISPLAY 0）从头到尾不动**。

```
物理屏 Display #0 → 用户正在用的 app（钉钉/微信/词典……不变）
后台屏 Display #2x → 你要操作的 app（截图/点击都在这里）
```

不需要 root，不需要无障碍服务，不需要装任何手机端 APK。

## 安装

```bash
npm install dsh-phone-bg --prefix ~/.dsh/profiles/web
# 把 "dsh-phone-bg" 加进该 profile 的 package.json → dsh.profile.bundles，然后重启 DSH
```

要求：宿主能跑 `adb`（Android platform-tools），手机打开 USB 调试并 `adb devices` 可见。
`ADB` / `ANDROID_SERIAL` 环境变量可选。

## 工具

| 工具 | 作用 |
|---|---|
| `phone_bg_status` | 看物理屏在跑什么 + 后台屏状态（动手前、收尾各一次） |
| `phone_bg_start` | 建/复用后台屏（默认手机物理分辨率与密度） |
| `phone_bg_launch` | 把 app 启动到后台屏；塞不进去的 app 自动撤回并把前台还原 |
| `phone_bg_shot` | 截后台屏，存 PNG，返回路径 |
| `phone_bg_tap` / `phone_bg_swipe` / `phone_bg_text` / `phone_bg_key` | 在后台屏操作 |
| `phone_bg_verify` | 收尾自检：确认物理屏顶层没被改变 |
| `phone_bg_stop` | 关屏（先杀掉后台屏栈顶的 app，避免任务被系统迁回主屏） |

## 为什么不能用更简单的做法

| 做法 | 结果 |
|---|---|
| `adb shell input tap` | 只能打到当前焦点窗口 → 等于抢前台 |
| `screencap -d <虚拟屏 id>` | Android 16 报 `Display Id is not valid`，只认物理 display |
| `DisplayManager.createVirtualDisplay(String,int,int,int,Surface)`（静态 5 参） | 能建屏，但 `FLAG_PRIVATE` + `canHostTasks=false`，app 放不上去 |
| `DisplayManagerGlobal.createVirtualDisplayWrapper(...)` | Android 16 上返回对象但 display 从未真正创建，回调也不触发 |
| **`DisplayManager` 私有构造 + 6 参 `createVirtualDisplay(..., flags)`** | ✅ 能承载任务；flags = `0xcb \| 0xfc00` |

截图同理：虚拟屏的帧只能从 `ImageReader` 取（所以手机侧常驻一个小 dex，
持续把最新帧落到 `live.png`，静态界面也不会等死）。

手机侧程序是 `assets/phone-bg.dex`（约 13 KB，由 `bg.Shell` 编译而来），
以 `app_process` + shell 身份运行，首次调用自动推送。

## 限制

- 虚拟屏没有状态栏/导航栏：返回用 `phone_bg_key 4`，回桌面用 `3`。
- 不支持缩放的 app（部分银行、部分聊天类）放不进后台屏，工具会直接报失败，不会硬来。
- 与主屏共享同一份数据和登录态——它不是"第二台手机"。
- 手机重启后守护进程消失，下一次调用自动重建。

## 版本策略

**刻意停在 `0.x`。** 工具名、参数形状、手机侧的命令协议都还允许改——真实设备上总会冒出
没预料到的情况（不支持缩放的 app、各家 ROM 的差异、Android 版本行为变化）。
`0.x` 内部约定：**patch** 不改工具签名，**minor** 可以改。

`1.0.0` 是挣来的，不是排期排出来的——等它在一个完整的 minor 周期里、跨多台设备都没出正确性问题，
才配叫 1.0。

## 许可

Apache-2.0。见 [`LICENSE`](LICENSE) 与 [`NOTICE`](NOTICE)。
相比 MIT，它多了第 3 条明确的**专利授权**（以及商标、免责的明确定义）——对一个要驱动真实设备的
项目，这层保障值得多出来的那两百行。
