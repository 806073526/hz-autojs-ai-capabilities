/** core/recorder.js —— 运行记录（JSONL 追加，不覆盖历史）（生成物，勿手改） */
var R = (function () {
  function event(ctx, entry) {
    var rec = entry || {};
    rec.at = new Date().getTime();
    rec.task = ctx.taskName;
    try {
      files.createWithDirs(ctx.recordPath);
      files.append(ctx.recordPath, JSON.stringify(rec) + '\n');
    } catch (e) { log('RECORDER_WRITE_FAILED:' + String(e)); }
    return rec;
  }
  function result(ctx, payload) {
    event(ctx, { kind: 'result', payload: payload });
    log('RESULT:' + JSON.stringify(payload));
    return payload;
  }
  return { event: event, result: result };
})();
module.exports = R;
