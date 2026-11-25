# dsh-phone-bg

**English** · [中文说明](README.zh.md)

**Operate Android apps on a hidden virtual display — whatever is on the phone's own screen never moves.**

> **`bg` = background** (as in foreground/background display), not "background image".
> `phone-bg` reads as *phone → background display*, and every tool keeps that root:
> `phone_bg_start`, `phone_bg_tap`, `phone_bg_shot`, …

Existing phone plugins for DSH (dsh-phone-control / dsh-mobile-use / dsh-android-tool) mirror the device
into DSH and then tap the *main* display: the mirror is only for viewing, and every tap lands on whatever
window currently has focus, so the user gets interrupted.

dsh-phone-bg does the other thing: it creates an Android **Virtual Display** and launches the target app
there. Screenshots, taps and typing all happen on that background display. **Physical DISPLAY 0 is never
touched.**

No root, no accessibility service, no APK to install on the phone.

## Install

```bash
npm install dsh-phone-bg --prefix ~/.dsh/profiles/web
# add "dsh-phone-bg" to that profile's package.json → dsh.profile.bundles, then restart DSH
```

Requires `adb` on the host and one authorised device. `ADB` / `ANDROID_SERIAL` env vars are optional.

## Tools

`phone_bg_status` · `phone_bg_start` · `phone_bg_launch` · `phone_bg_shot` · `phone_bg_tap` ·
`phone_bg_swipe` · `phone_bg_text` · `phone_bg_key` · `phone_bg_verify` · `phone_bg_stop`

`phone_bg_launch` refuses to fight the system: if the app can't live on a virtual display, it is
force-stopped and the previous foreground activity is restored, then the tool reports the failure.

## Implementation notes

- Display creation: private `DisplayManager(Context)` ctor + hidden instance method
  `createVirtualDisplay(name, w, h, dpi, surface, flags)` with `flags = 0xcb | 0xfc00`.
  The static 5-arg variant yields a `FLAG_PRIVATE`, `canHostTasks=false` display; `DisplayManagerGlobal`
  on Android 16 returns an object but never actually adds the display.
- Frames: `ImageReader` on the phone side (a ~13 KB dex push on first use), because
  `screencap -d <virtual id>` only accepts physical displays.
- Input: `adb shell input -d <displayId> ...` — works on virtual displays and stays there.
- Command channel: files under `/data/local/tmp/phone-bg/` (shell identity binding a socket is
  routinely blocked).

## Limits

- No status bar / navigation bar on the virtual display (`phone_bg_key 4` for back, `3` for home).
- Non-resizable apps can't be hosted; the tool says so instead of hijacking the foreground.
- Same user data and logins as the main screen — this is not a second phone.

## Versioning

Stays in `0.x` on purpose. The tool names, the parameter shape and the on-phone command protocol are
still allowed to change while real devices surface edge cases (non-resizable apps, OEM quirks, Android
revisions). Inside `0.x`: a **patch** release never changes a tool signature, a **minor** release may.

`1.0.0` is earned, not scheduled — it happens once the plugin has survived a full minor cycle on a
range of devices with no open correctness bugs.

## License

Apache-2.0 — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). Compared with MIT it adds an explicit
patent grant (section 3), which is worth having for anything that drives real devices.
