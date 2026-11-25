/**
 * define-tool.js —— 宿主的 `defineTool()` 兜底实现 + 可靠加载。
 *
 * 背景（踩过，别改回去）：
 * 宿主把 `@deepseek-ai/dsh-tools` 装在 harness 自己的 node_modules 下，插件从自己的
 * 目录往上解析**常常找不到它** → import 抛错。所以这里按优先级找：
 *   1) 包名 `@deepseek-ai/dsh-tools`（插件被装在 profile 里、peer 可解析时命中）
 *   2) `$DSH_TOOLS_PATH`（显式指定，调试用）
 *   3) 常见 harness 安装位置的**绝对路径**（npm 全局 / electron 自带 / 本仓库）
 * 都找不到才退化成下面的 compat 实现。
 *
 * 兜底实现必须产出**宿主 register() 认得的形状**，两条硬约束（宿主源码里写死的）：
 *   - `output.render` 必须是函数
 *   - `parameters` / `output.schema` 必须能过 `assertSupportedJsonSchema`
 *     即：顶层 object 带 `properties`，`required` 是**字符串数组**；
 *     property 里不能出现 `required: true` 这种 author-spec 写法。
 *   这正是第一版静默失效的原因：output.schema 原样透传，`required: true` 进了
 *   校验器 → 抛错 → apply 的 try/catch 吞掉 → fiber 显示 active，但一个工具都没注册。
 *
 * author spec 支持：
 *   { type: 'string'|'number'|'integer'|'boolean'|'null', description?, enum?, required? }
 *   { type: 'array', items: <spec>, description?, required? }
 *   { type: 'object', properties: {..}, additionalProperties?, description?, required? }
 *   { type: 'json', description?, required? }  // 任意 JSON
 */

import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const JSON_TYPES = ['object', 'array', 'string', 'number', 'boolean', 'null'];

/** 把 author spec 编译成合法 JSON Schema（递归）。 */
function compile(spec, isTopLevel = false) {
  if (!spec || typeof spec !== 'object') return isTopLevel ? { type: 'object', properties: {} } : {};
  const out = {};
  if (spec.description) out.description = spec.description;
  if (spec.enum) out.enum = spec.enum;

  switch (spec.type) {
    case 'json':
      // 任意 JSON：不做类型限制，只保留描述
      out.description = spec.description || '任意 JSON 值';
      break;
    case 'array':
      out.type = 'array';
      out.items = compile(spec.items || {}, false);
      break;
    case 'object': {
      const { properties, required } = compilePropertyMap(spec.properties || {});
      out.type = 'object';
      out.properties = properties;
      if (required.length) out.required = required;
      out.additionalProperties = spec.additionalProperties === undefined
        ? false
        : (typeof spec.additionalProperties === 'object'
          ? compile(spec.additionalProperties, false)
          : Boolean(spec.additionalProperties));
      break;
    }
    default:
      if (spec.type && JSON_TYPES.includes(spec.type)) out.type = spec.type;
      else if (isTopLevel) {
        out.type = 'object';
        out.properties = {};
        out.additionalProperties = false;
      }
  }
  return out;
}

function compilePropertyMap(map) {
  const properties = {};
  const required = [];
  for (const [key, value] of Object.entries(map)) {
    properties[key] = compile(value, false);
    if (value && value.required) {
      required.push(key);
      delete properties[key].required;
    }
  }
  return { properties, required };
}

/** 兜底 defineTool：接收 author spec（含 execute），返回宿主 register() 认得的结构。 */
export function defineToolCompat(spec) {
  const { parameters, output, ...rest } = spec;
  const compiledParameters = compile({ type: 'object', properties: parameters || {} }, true);

  const tool = { ...rest, parameters: compiledParameters };

  if (output) {
    tool.output = {
      ...output,
      schema: compile(output.schema || {}, true),
      render: typeof output.render === 'function' ? output.render : () => [],
    };
  }
  return tool;
}

/** harness 常见安装位置里 @deepseek-ai/dsh-tools 的候选绝对路径。 */
function absoluteCandidates() {
  const home = os.homedir();
  const roots = [
    path.join(home, '.local', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'),
    path.join(home, '.local', 'share', 'deepseek-harness-desktop', 'node_modules'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules',
    '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules',
    path.join(home, 'projects', 'dsh', 'node_modules'),
    path.join(home, 'projects', 'deepseek-harness', 'node_modules'),
  ];
  return roots.map((root) => path.join(root, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'));
}

/** 优先用宿主真实的 defineTool，解析不到再兜底。 */
export async function loadDefineTool() {
  const sources = ['@deepseek-ai/dsh-tools'];
  if (process.env.DSH_TOOLS_PATH) sources.push(process.env.DSH_TOOLS_PATH);
  for (const abs of absoluteCandidates()) {
    if (existsSync(abs)) sources.push(pathToFileURL(abs).href);
  }

  for (const spec of sources) {
    try {
      const mod = await import(spec);
      if (typeof mod?.defineTool === 'function') return mod.defineTool;
    } catch { /* 继续尝试下一个 */ }
  }
  return defineToolCompat;
}
