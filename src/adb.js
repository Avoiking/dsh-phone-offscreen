/**
 * adb.js —— 和手机说话的那一层。
 *
 * 设计约束（都是踩出来的）：
 * - **只用 adb，不需要 root、不需要无障碍服务**。手机侧跑的是 `bg.Shell`（app_process + shell 身份）。
 * - **截图走 ImageReader，不走 screencap**：`screencap -d <虚拟屏>` 在 Android 16 上直接报
 *   "Display Id is not valid"，它只认物理 display。
 * - **命令通道走文件**：shell 身份 bind 端口容易被 SELinux 卡，写 /data/local/tmp 永远可行。
 */

import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEX_ASSET = path.join(HERE, '..', 'assets', 'phone-bg.dex');

const REMOTE_DIR = '/data/local/tmp/phone-bg';
const REMOTE_DEX = `${REMOTE_DIR}/phone-bg.dex`;

/** adb 可执行文件：优先 env.ADB，其次 PATH 里的 adb。 */
const ADB = process.env.ADB || 'adb';

/** 设备序列号：env.ANDROID_SERIAL 或第一台在线设备。 */
export async function resolveSerial(explicit) {
  if (explicit) return explicit;
  if (process.env.ANDROID_SERIAL) return process.env.ANDROID_SERIAL;
  const out = await run(['devices']);
  const devices = out
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 2 && p[1] === 'device')
    .map((p) => p[0]);
  if (devices.length === 0) throw new Error('没有在线的 adb 设备（android: adb devices 看看）');
  return devices[0];
}

function run(args, { serial, binary = false, timeout = 30000 } = {}) {
  const full = serial ? ['-s', serial, ...args] : args;
  return new Promise((resolve, reject) => {
    execFile(ADB, full, { timeout, maxBuffer: 32 * 1024 * 1024, encoding: binary ? 'buffer' : 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout?.toString?.() ?? '';
          err.stderr = stderr?.toString?.() ?? '';
          return reject(err);
        }
        resolve(binary ? stdout : stdout.toString());
      });
  });
}

const sh = (serial, cmd) => run(['shell', cmd], { serial }).catch((e) => e.stdout || '');

async function readRemote(serial, rel) {
  const out = await run(['shell', `cat ${REMOTE_DIR}/${rel}`], { serial }).catch((e) => e.stdout || '');
  return out.replace(/\r/g, '');
}

async function waitFor(fn, { tries = 60, delay = 150 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, delay));
  }
  return null;
}

/** 守护进程活着吗（进程 + display.info 都在才算）。 */
export async function daemonAlive(serial) {
  const pid = (await sh(serial, "pgrep -f 'bg.Shell'")).trim();
  if (!pid) return false;
  const info = await readRemote(serial, 'display.info');
  return /DISPLAY_ID=\d+/.test(info);
}

export async function getDisplayId(serial) {
  const info = await readRemote(serial, 'display.info');
  const m = info.match(/DISPLAY_ID=(\d+)/);
  return m ? Number(m[1]) : null;
}

/** 起守护进程（已存在则直接返回 display id）。 */
export async function ensureDaemon(serial, { size, dpi } = {}) {
  if (await daemonAlive(serial)) return getDisplayId(serial);

  const info = await sh(serial, `wm size`).catch(() => '');
  const mSize = String(info).match(/Physical size:\s*(\d+)x(\d+)/);
  const wmDensity = String(await sh(serial, 'wm density')).match(/Physical density:\s*(\d+)/);

  const finalSize = size || (mSize ? `${mSize[1]}x${mSize[2]}` : '1080x2400');
  const finalDpi = dpi || (wmDensity ? Number(wmDensity[1]) : 420);

  await sh(serial, `mkdir -p ${REMOTE_DIR}`);
  await run(['push', DEX_ASSET, REMOTE_DEX], { serial });
  await sh(serial, `rm -f ${REMOTE_DIR}/display.info ${REMOTE_DIR}/cmd ${REMOTE_DIR}/out`);
  await sh(serial,
    `cd ${REMOTE_DIR} && (CLASSPATH=${REMOTE_DEX} setsid app_process /system/bin bg.Shell `
    + `--size=${finalSize} --dpi=${finalDpi} > ${REMOTE_DIR}/shell.log 2>&1 < /dev/null &)`);

  const id = await waitFor(async () => (await daemonAlive(serial)) ? getDisplayId(serial) : null);
  if (!id) {
    const log = await readRemote(serial, 'shell.log');
    throw new Error(`后台屏启动失败：${log.slice(0, 600) || '无日志'}`);
  }
  return id;
}

export async function stopDaemon(serial) {
  const id = await getDisplayId(serial);
  if (id) {
    // 只杀后台屏**栈顶**那个 app（topResumedActivity 是可靠来源）。
    // 早先按 display 段落里的 A= 包名批量 force-stop，那个解析会把钉钉/桌面/Shizuku 一起算进来 —— 会误杀。
    const top = (await displayState(serial)).find((d) => d.display === id)?.top || '';
    const pkg = top.split('/')[0];
    if (pkg && !['com.hihonor.android.launcher', 'com.android.launcher3'].includes(pkg)) {
      await sh(serial, `am force-stop ${pkg}`);
    }
  }
  await sh(serial, `echo quit > ${REMOTE_DIR}/cmd`);
  await new Promise((r) => setTimeout(r, 600));
  await sh(serial, `rm -f ${REMOTE_DIR}/display.info`);
}

/** 截虚拟屏，返回本地 PNG 路径。 */
export async function snap(serial, localPath) {
  await ensureDaemon(serial);
  await sh(serial, `rm -f ${REMOTE_DIR}/out ${REMOTE_DIR}/shot.png; echo snap > ${REMOTE_DIR}/cmd`);
  const ok = await waitFor(async () => {
    const out = (await readRemote(serial, 'out')).trim();
    return out.startsWith('OK') ? out : null;
  });
  if (!ok) throw new Error('截屏超时：守护进程没回 OK');
  await run(['pull', `${REMOTE_DIR}/shot.png`, localPath], { serial });
  return localPath;
}

/** 解析 `dumpsys activity activities` → [{display, top, pkgs}] */
export async function displayState(serial) {
  const raw = await sh(serial, 'dumpsys activity activities');
  const result = [];
  let cur = null;
  let inStack = false;
  for (const line of String(raw).split('\n')) {
    const m = line.match(/^Display #(\d+) \(activities from top to bottom\)/);
    if (m) {
      cur = { display: Number(m[1]), top: '', pkgs: new Set() };
      result.push(cur);
      inStack = true;
      continue;
    }
    if (/^Display #\d+/.test(line) || /^ActivityTaskSupervisor state:/.test(line)) {
      // 切到别的 display 段或离开活动栈段：之后的内容不属于这个屏
      inStack = false;
      cur = null;
      continue;
    }
    if (!cur || !inStack) continue;
    if (!cur.top && line.includes('topResumedActivity=')) {
      const a = line.match(/u0 ([^\s]+) /);
      cur.top = a ? a[1] : '';
    }
    for (const pkg of line.matchAll(/A=\d+:([A-Za-z0-9_.]+)/g)) cur.pkgs.add(pkg[1]);
  }
  return result.map((d) => ({ display: d.display, top: d.top, pkgs: [...d.pkgs] }));
}

export async function physicalTop(serial) {
  const d = (await displayState(serial)).find((x) => x.display === 0);
  return d?.top ?? '';
}

export async function packagesOnDisplay(serial, displayId) {
  const d = (await displayState(serial)).find((x) => x.display === displayId);
  return d?.pkgs ?? [];
}

/**
 * 把 app 放到后台屏。
 * 返回 {ok, display, warning}；塞不进去时**不硬来**，撤回并把前台还原。
 */
export async function launch(serial, component) {
  const display = await ensureDaemon(serial);
  const pkg = component.split('/')[0];
  const before = await physicalTop(serial);
  const physPkgs = (await displayState(serial)).find((x) => x.display === 0)?.pkgs ?? [];
  if (physPkgs.includes(pkg)) {
    return { ok: false, display, warning: `${pkg} 正在物理屏运行，单实例 app 会被顶到前台；先 force-stop 它再来` };
  }
  await sh(serial, `am start --display ${display} -n ${component} -f 0x10000000`);
  await new Promise((r) => setTimeout(r, 1500));
  const now = await physicalTop(serial);
  if (now.includes(pkg) && !before.includes(pkg)) {
    await sh(serial, `am force-stop ${pkg}`);
    if (before) await sh(serial, `am start -n ${before}`);
    return { ok: false, display, warning: `${pkg} 不支持在后台屏缩放，被系统顶回物理屏；已撤回并把前台还原成 ${before}` };
  }
  return { ok: true, display };
}

export async function ensureDir(p) {
  await mkdir(p, { recursive: true });
}

export async function readLocal(p) {
  return readFile(p);
}

export async function writeLocal(p, data) {
  await writeFile(p, data);
}

export async function rmLocal(p) {
  await rm(p, { force: true });
}

export { run as rawAdb, sh as shell };
