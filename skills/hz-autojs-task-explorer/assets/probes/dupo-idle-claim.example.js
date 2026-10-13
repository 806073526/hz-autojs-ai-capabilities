// 斗破苍穹挂机收益领取骨架（修炼石台 / 心火淬炼）
//
// 前置假设：当前停在冒险章节地图，左下角可见「修炼石台」图标。
// 关卡地图上的石台图标会随时间累积；本脚本只做一轮「进入 → 领取 → 清弹层」。
//
// 参数示例（scriptParams）——所有点位都必须由坐标契约解析后传入，本脚本不含裸像素：
//   {
//     "points": {
//       "platform": { "x": 170, "y": 1340 },
//       "claim":    { "x": 850, "y": 1645 },
//       "dismiss":  { "x": 540, "y": 1650 },
//       "closePanel": { "x": 995, "y": 185 }
//     }
//   }
//
// 安全边界：
//   - 只点「领取收益」，不点「购买心火淬炼特权」「快速修炼」等付费/消耗入口。
//   - 入口或按钮缺失时直接退出，不盲点。

var p = typeof scriptParams === 'object' && scriptParams ? scriptParams : {};
var points = p.points || {};

function tapNamed(name, x, y, wait) {
  var result = __toolboxTap(x, y);
  console.log('IDLE_' + name + '=' + JSON.stringify(result));
  if (wait) sleep(wait);
  return result;
}

var need = ['platform', 'claim', 'dismiss', 'closePanel'];
var missing = [];
for (var i = 0; i < need.length; i++) {
  var pt = points[need[i]];
  if (!pt || typeof pt.x !== 'number' || typeof pt.y !== 'number') {
    missing.push(need[i]);
  }
}

if (missing.length > 0) {
  console.log('IDLE_ABORT=缺少已解析坐标: ' + missing.join(','));
} else {
  // 1. 进入挂机面板
  tapNamed('open_platform', points.platform.x, points.platform.y, 4000);

  // 2. 领取累积收益（若无可领，宿主应先通过 OCR/图色确认再调用本脚本）
  tapNamed('claim', points.claim.x, points.claim.y, 5000);

  // 3. 关闭「恭喜获得」奖励弹层
  tapNamed('close_reward', points.dismiss.x, points.dismiss.y, 3000);

  // 4. 领取可能触发升级，继续清掉后续弹层
  tapNamed('close_popup_1', points.dismiss.x, points.dismiss.y, 2500);
  tapNamed('close_popup_2', points.dismiss.x, points.dismiss.y, 2500);

  // 5. 关闭挂机面板（右上 X）
  tapNamed('close_panel', points.closePanel.x, points.closePanel.y, 2500);

  console.log('IDLE_DONE');
}

'ok';
