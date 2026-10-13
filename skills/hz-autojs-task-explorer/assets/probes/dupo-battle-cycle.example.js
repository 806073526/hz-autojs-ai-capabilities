// 一轮完整战斗循环：章节页 → 关卡列表 → 布阵 → 出战 → 结算 → 清弹层
//
// 本脚本不含任何硬编码坐标。调用方必须先用坐标契约解析出实际像素，
// 再通过 scriptParams.points 传入：
//
//   {
//     "points": {
//       "open_stage_list": { "x": 855, "y": 1570 },
//       "challenge":       { "x": 910, "y": 1172 },
//       "sortie":          { "x": 715, "y": 1675 },
//       "confirm":         { "x": 540, "y": 1735 },
//       "dismiss":         { "x": 540, "y": 1690 }
//     },
//     "waits": { "battleMs": 24000 }
//   }
//
// 解析方式见 assets/probes/coordinate-resolver.example.js 与 assets/coordinate-spec.example.json。

var p = typeof __toolboxParams === 'object' && __toolboxParams ? __toolboxParams : {};
var points = p.points || {};
var waits = p.waits || {};
var battleMs = typeof waits.battleMs === 'number' ? waits.battleMs : 24000;

var required = ['open_stage_list', 'challenge', 'sortie', 'confirm', 'dismiss'];
var missing = [];
for (var i = 0; i < required.length; i++) {
  var key = required[i];
  var pt = points[key];
  if (!pt || typeof pt.x !== 'number' || typeof pt.y !== 'number') {
    missing.push(key);
  }
}

if (missing.length > 0) {
  console.log('CYCLE_ABORT=缺少已解析坐标: ' + missing.join(','));
} else {
  function tapPoint(name, key, wait) {
    var pt = points[key];
    var result = __toolboxTap(pt.x, pt.y);
    console.log('CYCLE_' + name + '=' + JSON.stringify(result));
    if (wait) sleep(wait);
  }

  tapPoint('open_stage_list', 'open_stage_list', 3500);
  tapPoint('challenge', 'challenge', 3500);
  tapPoint('sortie', 'sortie', battleMs);
  tapPoint('confirm', 'confirm', 3000);
  tapPoint('close_reward_1', 'dismiss', 1500);
  tapPoint('close_reward_2', 'dismiss', 1500);
  tapPoint('close_reward_3', 'dismiss', 1500);

  console.log('CYCLE_DONE');
}

'ok';
