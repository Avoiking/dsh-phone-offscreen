/**
 * dsh-phone-bg —— 手机的「不打扰模式」。
 *
 * 在手机上开一块**看不见的虚拟屏**（Android Virtual Display），把 app 放进去跑；
 * 截图、点击、输入都发生在那块屏里，**物理屏（用户正在用的界面）从头到尾不动**。
 *
 * 与生态里其它手机插件的关键区别：那些插件都是「看/点主屏」（镜像 + 无障碍/uiautomator），
 * 点击必然作用于设备当前前台；这一份是「另开一块屏」，所以能真的不打扰用户。
 *
 * 实现要点（都是踩出来的，改之前先读）：
 * - 手机侧跑 `assets/phone-bg.dex`（bg.Shell），app_process 起，shell 身份，**不需要 root、不需要无障碍**
 * - 建屏用 DisplayManager 私有构造 + hidden `createVirtualDisplay(name,w,h,dpi,surface,flags)`，
 *   flags = 0xcb | 0xfc00；用 DisplayManagerGlobal 或静态版本都建不出「可承载任务」的屏
 * - 截图走 ImageReader（`screencap -d` 不认虚拟屏）
 * - 输入走 `input -d <displayId>`，只作用在后台屏
 * - 命令通道走 /data/local/tmp/phone-bg/cmd，绕开 shell 身份 bind 端口的权限问题
 */

import os from 'node:os';
import path from 'node:path';
import { join } from 'node:path';

import {
  ensureDaemon, displayState, getDisplayId, launch as adbLaunch,
  physicalTop, resolveSerial, shell, snap, stopDaemon,
} from './adb.js';
import { loadDefineTool } from './define-tool.js';

export const name = 'phone-bg';
export const inject = ['tools'];

const DEFAULT_SHOT_DIR = join(os.tmpdir(), 'dsh-phone-bg');

async function withDevice(args) {
  const serial = await resolveSerial(args?.serial);
  return { args, serial };
}

/** 所有「要动手」的工具共用的一段前置：确保后台屏在、拿到 display id。 */
async function withDisplay(args) {
  const serial = await resolveSerial(args?.serial);
  const display = await ensureDaemon(serial, { size: args?.size, dpi: args?.dpi });
  return { serial, display };
}

const STUB_OUTPUT = (text) => ({
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string', required: true } },
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
});

/** 加载自检：宿主 register() 抛错时不再静默，落盘一行，便于事后查。 */
async function logApply(line) {
  try {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(join(os.tmpdir(), 'dsh-phone-bg-apply.log'), `${new Date().toISOString()} [pid ${process.pid}] ${line}\n`);
  } catch { /* 日志失败不影响加载 */ }
}

export async function apply(ctx) {
  try {
    const dispose = await registerAll(ctx);
    await logApply('apply OK');
    return dispose;
  } catch (e) {
    // 不吞异常：fiber 显示 failed 比「active 但一个工具都没注册」可诊断得多。
    await logApply(`apply FAILED: ${e?.stack ?? e}`);
    throw e;
  }
}

async function registerAll(ctx) {
  const defineTool = await loadDefineTool();
  const disposers = [];

  const tools = [
    // ── 状态 ──────────────────────────────────────────────
    defineTool({
      name: 'phone_bg_status',
      description: '查看手机两块屏的状态：物理屏（用户正在用的界面）顶层是哪个 app、后台虚拟屏是否在跑、'
        + '后台屏里现在是什么。动手前先调一次，收尾再调一次确认没打扰到用户。',
      parameters: { serial: { type: 'string', description: 'adb 设备序列号，省略则用默认设备' } },
      output: STUB_OUTPUT(),
      timeoutMs: 20000,
      isConcurrencySafe: () => true,
      async execute(args) {
        const { serial } = await withDevice(args);
        const states = await displayState(serial);
        const phys = states.find((d) => d.display === 0);
        const vd = await getDisplayId(serial);
        const lines = [
          `物理屏(DISPLAY 0): ${phys?.top || '(未知)'}`,
          vd === null ? '后台屏: 未启动' : `后台屏: display=${vd} top=${states.find((d) => d.display === vd)?.top || '(空)'}`,
        ];
        return { text: lines.join('\n') };
      },
    }),

    // ── 建屏 / 关屏 ────────────────────────────────────────
    defineTool({
      name: 'phone_bg_start',
      description: '建立（或复用）后台虚拟屏。默认用手机物理分辨率与密度。不需要 root、不需要无障碍。',
      parameters: {
        serial: { type: 'string', description: 'adb 序列号，省略用默认设备' },
        size: { type: 'string', description: '如 1080x2400，省略用手机物理分辨率' },
        dpi: { type: 'integer', description: '屏幕密度，省略用手机物理密度' },
      },
      output: STUB_OUTPUT(),
      timeoutMs: 60000,
      isConcurrencySafe: () => false,
      async execute(args) {
        const display = await withDisplay(args);
        return { text: `后台屏已就绪 display=${display.display}` };
      },
    }),

    defineTool({
      name: 'phone_bg_stop',
      description: '关闭后台屏。会先 force-stop 后台屏里正在跑的 app，避免任务被系统迁回物理屏。',
      parameters: { serial: { type: 'string', description: 'adb 序列号' } },
      output: STUB_OUTPUT(),
      timeoutMs: 30000,
      isConcurrencySafe: () => false,
      async execute(args) {
        const { serial } = await withDevice(args);
        await stopDaemon(serial);
        return { text: '后台屏已关闭' };
      },
    }),

    // ── 启动 app ──────────────────────────────────────────
    defineTool({
      name: 'phone_bg_launch',
      description: '把 app 启动到后台屏（不影响物理屏）。塞不进去的 app（不支持缩放）会被自动撤回并把'
        + '前台还原，工具返回失败原因——此时直接向用户报告，不要改用前台方式硬上。',
      parameters: {
        component: { type: 'string', description: '完整组件名，如 com.android.settings/.Settings', required: true },
        serial: { type: 'string', description: 'adb 序列号' },
      },
      output: STUB_OUTPUT(),
      timeoutMs: 60000,
      isConcurrencySafe: () => false,
      async execute(args) {
        const { serial } = await withDevice(args);
        const r = await adbLaunch(serial, args.component);
        if (!r.ok) return { text: `失败：${r.warning}` };
        return { text: `已在后台屏(display=${r.display})启动 ${args.component}` };
      },
    }),

    // ── 截图 ──────────────────────────────────────────────
    defineTool({
      name: 'phone_bg_shot',
      description: '截取后台屏画面并存成 PNG（默认放系统临时目录）。返回文件路径，可直接用 read_image 查看。'
        + '注意：这不是物理屏截图。',
      parameters: {
        path: { type: 'string', description: '本地保存路径，省略则自动生成' },
        serial: { type: 'string', description: 'adb 序列号' },
      },
      output: STUB_OUTPUT(),
      timeoutMs: 60000,
      isConcurrencySafe: () => false,
      async execute(args) {
        const { serial } = await withDevice(args);
        await ensureDaemon(serial);
        const local = args.path || path.join(DEFAULT_SHOT_DIR, `shot-${Date.now()}.png`);
        await snap(serial, local);
        return { text: local };
      },
    }),

    // ── 操作 ──────────────────────────────────────────────
    defineTool({
      name: 'phone_bg_tap',
      description: '在后台屏上点击一个坐标（坐标与 phone_bg_shot 的截图一致，无需换算）。物理屏不受影响。',
      parameters: {
        x: { type: 'integer', description: '横坐标像素', required: true },
        y: { type: 'integer', description: '纵坐标像素', required: true },
        serial: { type: 'string', description: 'adb 序列号' },
      },
      output: STUB_OUTPUT(),
      timeoutMs: 30000,
      isConcurrencySafe: () => false,
      async execute(args) {
        const { serial, display } = await withDisplay(args);
        await shell(serial, `input -d ${display} tap ${args.x} ${args.y}`);
        return { text: `已点击 (${args.x}, ${args.y}) @display=${display}` };
      },
    }),

    defineTool({
      name: 'phone_bg_swipe',
      description: '在后台屏上滑动。物理屏不受影响。',
      parameters: {
        x1: { type: 'integer', description: '起点 x', required: true },
        y1: { type: 'integer', description: '起点 y', required: true },
        x2: { type: 'integer', description: '终点 x', required: true },
        y2: { type: 'integer', description: '终点 y', required: true },
        durationMs: { type: 'integer', description: '时长毫秒，默认 300' },
        serial: { type: 'string', description: 'adb 序列号' },
      },
      output: STUB_OUTPUT(),
      timeoutMs: 30000,
      isConcurrencySafe: () => false,
      async execute(args) {
        const { serial, display } = await withDisplay(args);
        await shell(serial, `input -d ${display} swipe ${args.x1} ${args.y1} ${args.x2} ${args.y2} ${args.durationMs ?? 300}`);
        return { text: `已滑动 @display=${display}` };
      },
    }),

    defineTool({
      name: 'phone_bg_text',
      description: '往后台屏的输入框里打字（先 tap 过输入框再用）。物理屏不受影响。',
      parameters: {
        text: { type: 'string', description: '要输入的文本（空格会转成 %s）', required: true },
        serial: { type: 'string', description: 'adb 序列号' },
      },
      output: STUB_OUTPUT(),
      timeoutMs: 30000,
      isConcurrencySafe: () => false,
      async execute(args) {
        const { serial, display } = await withDisplay(args);
        const escaped = String(args.text).replace(/ /g, '%s').replace(/'/g, "'\\''");
        await shell(serial, `input -d ${display} text '${escaped}'`);
        return { text: '已输入' };
      },
    }),

    defineTool({
      name: 'phone_bg_key',
      description: '在后台屏上按键。常用：4=返回、3=Home、26=电源、66=回车、187=最近任务。',
      parameters: {
        code: { type: 'integer', description: 'KeyEvent 键码', required: true },
        serial: { type: 'string', description: 'adb 序列号' },
      },
      output: STUB_OUTPUT(),
      timeoutMs: 30000,
      isConcurrencySafe: () => false,
      async execute(args) {
        const { serial, display } = await withDisplay(args);
        await shell(serial, `input -d ${display} keyevent ${args.code}`);
        return { text: `已按键 ${args.code} @display=${display}` };
      },
    }),

    // ── 安全确认 ──────────────────────────────────────────
    defineTool({
      name: 'phone_bg_verify',
      description: '收尾自检：确认物理屏顶层没有被本次操作改变（应与操作前记下的值一致）。',
      parameters: {
        expect: { type: 'string', description: '操作前记录的物理屏顶层组件名', required: true },
        serial: { type: 'string', description: 'adb 序列号' },
      },
      output: STUB_OUTPUT(),
      timeoutMs: 20000,
      isConcurrencySafe: () => true,
      async execute(args) {
        const { serial } = await withDevice(args);
        const now = await physicalTop(serial);
        return { text: now === args.expect
          ? `物理屏未变：${now}`
          : `警告：物理屏顶层从 ${args.expect} 变成了 ${now}` };
      },
    }),
  ];

  // 逐个注册：一个工具的 spec 不合法不该拖垮其余九个。
  const failures = [];
  for (const tool of tools) {
    try {
      disposers.push(ctx.tools.register(tool));
    } catch (e) {
      failures.push(`${tool.name}: ${e?.message ?? e}`);
      await logApply(`register(${tool.name}) FAILED: ${e?.message ?? e}`);
    }
  }
  await logApply(`registered ${tools.length - failures.length}/${tools.length} tools`
    + (failures.length ? ` | failures: ${failures.join(' ; ')}` : ''));
  if (disposers.length === 0) throw new Error(`no tool registered (${failures.join(' ; ')})`);
  return () => { for (const off of disposers) { try { off?.(); } catch { /* ignore */ } } };
}
