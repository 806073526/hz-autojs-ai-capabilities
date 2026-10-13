/** tasks/detect-state.js —— 只读状态判定（框架任务，勿手改） */
var task = {
  name: "detect-state.js",
  states: [],
  readOnly: true,
  run: function (io) {
    var st = io.ctx.machine.detect(io.ctx);
    log('STATE_DETECTED:' + JSON.stringify(st));
    return { ok: st.id !== 'UNKNOWN', markers: ['STATE_DETECTED'], detail: st, skipVerify: true };
  }
};
module.exports = task;
