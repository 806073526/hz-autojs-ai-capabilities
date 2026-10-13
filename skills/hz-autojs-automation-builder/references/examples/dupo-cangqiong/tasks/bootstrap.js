/** tasks/bootstrap.js —— 只读环境自检（框架任务，勿手改） */
var task = {
  name: "bootstrap.js",
  states: [],
  readOnly: true,
  run: function (io) {
    var report = io.ctx.bootstrap.run(io.ctx);
    log('BOOTSTRAP:' + JSON.stringify(report));
    return { ok: report.ok === true, markers: report.ok ? ['BOOTSTRAP_OK'] : [], detail: report, skipVerify: true };
  }
};
module.exports = task;
