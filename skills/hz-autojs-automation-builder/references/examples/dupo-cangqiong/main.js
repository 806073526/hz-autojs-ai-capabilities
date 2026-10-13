/** main.js —— 入口：解析参数 → 选任务 → 校验可写性 → 执行 → 输出 marker（生成物，勿手改） */
var params = (typeof __toolboxParams === 'object' && __toolboxParams) ? __toolboxParams : {};
var taskName = String(params.task || 'detect-state');
if (taskName.slice(-3) !== '.js') { taskName = taskName + '.js'; }
if (!/^[A-Za-z0-9._-]+\.js$/.test(taskName)) { throw new Error('TASK_NAME_INVALID:' + taskName); }
function stamp() { return String(new Date().getTime()); }
var workDir = String(params.workDir || (files.cwd() + '/runs'));
var ctx = {
  taskName: taskName,
  dryRun: params.dryRun !== false,
  workDir: workDir,
  recordPath: workDir + '/run-' + stamp() + '.jsonl',
  stamp: stamp,
  readings: {},
  render: { left: 0, top: 0, width: device.width, height: device.height },
  lastShot: null,
  lastOcr: null
};
ctx.recorder = require('./core/recorder.js');
var baseDir = String((typeof __toolboxProjectDir === 'string' && __toolboxProjectDir) ? __toolboxProjectDir : (files.cwd() || ''));
if (!baseDir) { throw new Error('CWD_UNAVAILABLE'); }
function loadJson(rel) { return JSON.parse(files.read(baseDir + '/' + rel)); }
ctx.spec = loadJson('config/coordinates.json');
ctx.statesConfig = loadJson('config/states.json');
ctx.request = loadJson('config/request.json');
ctx.numericGuards = ctx.spec.numericGuards || [];
ctx.observe = require('./core/observe.js');
ctx.coordinates = require('./core/coordinates.js');
ctx.guards = require('./core/guards.js');
ctx.actions = require('./core/actions.js');
ctx.states = require('./core/states.js');
ctx.bootstrap = require('./core/bootstrap.js');
ctx.machine = require('./core/machine.js');
// 只读来源只有一个：任务模块自己的 readOnly 标记（不再维护第二份白名单）
try {
  var task = require('./tasks/' + taskName);
  var writeAllowed = (params.dryRun === false && params.allowWrite === true);
  if (task.readOnly !== true && !writeAllowed) {
    ctx.recorder.result(ctx, { ok: false, task: taskName, reason: 'WRITE_TASK_BLOCKED_IN_DRY_RUN', required: '{ task, dryRun: false, allowWrite: true }' });
    throw new Error('WRITE_TASK_BLOCKED_IN_DRY_RUN');
  }
  var payload = ctx.machine.runTask(ctx, task);
  ctx.recorder.result(ctx, payload);
} catch (e) {
  var failure = { ok: false, task: taskName, error: String(e), code: String((e && e.code) || '') };
  ctx.recorder.result(ctx, failure);
  throw e;
}
