// 斗破苍穹关卡推进骨架（1-2 / 1-3 实测路径）
//
// 只固化流程顺序，不含任何硬编码坐标。所有点位由调用方先解析坐标契约，
// 再通过 scriptParams.points 传入：
//
//   {
//     "points": {
//       "challenge": { "x": 911, "y": 1054 },
//       "hero":      { "x": 347, "y": 1525 },   // 可选
//       "sortie":    { "x": 715, "y": 1675 },
//       "confirm":   { "x": 540, "y": 1735 },
//       "dismiss":   { "x": 540, "y": 1690 }
//     },
//     "waits": { "battleMs": 26000 }
//   }
//
// 运行前确认：当前停在关卡列表页，目标关卡可挑战。

var p = typeof scriptParams === 'object' && scriptParams ? scriptParams : {};
var points = p.points || {};
var waits = p.waits || {};
var waitBattleMs = typeof waits.battleMs === 'number' ? waits.battleMs : 26000;

function tapNamed(name, x, y, wait) {
  var result = __toolboxTap(x, y);
  console.log('PROG_' + name + '=' + JSON.stringify(result));
  if (wait) sleep(wait);
}

if (!points.challenge || typeof points.challenge.x !== 'number') {
  console.log('PROG_ABORT=缺少已解析的 challenge 坐标');
  'abort';
} else {
  tapNamed('challenge', points.challenge.x, points.challenge.y, 4000);

  if (points.hero && typeof points.hero.x === 'number') {
    tapNamed('pick_hero', points.hero.x, points.hero.y, 1500);
  }

  if (!points.sortie || !points.confirm || !points.dismiss) {
    console.log('PROG_ABORT=缺少 sortie/confirm/dismiss 坐标');
  } else {
    // 出战可能需要复点一次：实测首次点击可能返回 true 但未推进状态。
    tapNamed('sortie_1', points.sortie.x, points.sortie.y, 6000);
    tapNamed('sortie_2', points.sortie.x, points.sortie.y, waitBattleMs);

    tapNamed('confirm', points.confirm.x, points.confirm.y, 3000);
    tapNamed('reward_1', points.dismiss.x, points.dismiss.y, 1500);
    tapNamed('reward_2', points.dismiss.x, points.dismiss.y, 1500);
    tapNamed('reward_3', points.dismiss.x, points.dismiss.y, 1500);

    console.log('PROG_DONE');
  }
}

'ok';
