# dupo-cangqiong（生成物）

由 `hz-autojs-automation-builder` 的 `generate-project.mjs` 从任务卡契约编译，来源运行目录：`data/exploration/dupo-cangqiong-20261001`。
生成时间：2026-10-04T14:16:32.563Z。任务模块由任务卡编译，**禁止手改 `tasks/`**；契约变化后重新生成。

## 运行

- 同步：`project_sync_plan` → `project_sync_push`（显式清单，一次一批）。
- 只读任务：`bootstrap.js`、`detect-state.js`（`project_run` 默认 dryRun）。
- 写入任务：必须同时传 `{ "task": "<name>", "dryRun": false, "allowWrite": true }`；缺一项会被拒绝并判失败。
- 运行记录：`<项目目录>/runs/*.jsonl`（追加写）+ `runs/shots/`。

## 任务清单（任务卡状态）

- `bootstrap.js`：读设备模式与分辨率、加载坐标契约与状态模型、做锚点残差校验，失败则停手 —— framework-generated（只读，readiness=ready）
- `detect-state.js`：设备侧截图 + OCR 判当前状态，输出状态 ID 与命中锚点；未识别时留帧并升级 —— framework-generated（只读，readiness=ready）
- `clear-popups.js`：关闭活动弹窗与奖励队列，避开付费入口和中间道具图标 —— compiled-needs-verification（写入，readiness=ready）
- `adventure-challenge.js`：一关一条龙：章节地图/关卡列表 -> 挑战 -> 布阵 -> 出战（preSteps 只跑一次）-> 战斗 HUD 出来后每 6s 自动点一次右下快进(965,1560)，最多 8 次；命中「全场最佳」用命中帧复核并停，战败(变强途径)立即停手上报不盲点 —— compiled-needs-verification（写入，readiness=ready）
- `auto-challenge.js`：连战推进：战斗页每轮「等 8s → 点右下快进(965,1560)」最多 10 轮，把当前战斗直接推到结算页；抓到「全场最佳」即用命中帧复核并停（marker STAGE_CLEARED）。快进键 OCR 读不到，只能几何定位；单脚本必须短于 3 分钟看门狗 —— compiled-needs-verification（写入，readiness=ready）
- `milestone-claim.js`：章节地图右上宝箱进入里程碑面板，只处理可领取行并复核已领取状态 —— compiled-needs-verification（写入，readiness=ready）
- `idle-claim.js`：进入修炼石台，读取累积量，领取一次并用资源增量或倒计时验证 —— compiled-needs-verification（写入，readiness=ready）
- `realm-panel-claim.js`：扫描任务卡三态，只处理领取，前往目标走白名单 —— compiled-needs-verification（写入，readiness=ready）
- `hero-upgrade.js`：角色升级与进阶，资源不足时停止并记录 —— compiled-needs-verification（写入，readiness=ready）
- `training-hub-fight.js`：历练·日常修行：进关卡战斗（首通按钮 战斗）；免费扫荡需先读今日免费次数（readingKey=freeSweepLeft），收费档跳过 —— compiled-needs-verification（写入，readiness=ready）
- `faction-donate.js`：势力捐献：先读剩余免费次数与贡献数值，只走 0 消耗档，单次执行并复核剩余次数 —— compiled-needs-verification（写入，readiness=ready）
- `xuejing-refine.js`：血精凝练：先读势力贡献，≥1700 才点一次凝练，不连续点击，复核等级与剩余次数 —— compiled-needs-verification（写入，readiness=ready）
- `quick-train-free.js`：快速修炼：进入面板核对今日剩余与首次免费，仅走每日首次免费（出现 50 紫晶卡消耗即停） —— compiled-needs-verification（写入，readiness=ready）

## 守卫

- 禁止文本（元素文本 + 点击落点 OCR 双层）：购买 / 充值 / 战令 / 礼包 / 超值返利 / 限购 / 扫码支付 / 微信支付 / 支付宝支付
- 快速修炼：仅每日首次免费可用；出现 50 紫晶卡消耗时必须停止并记录
- 捐献：只使用每日免费次数（档位消耗为 0）；超出后消耗紫晶卡，一律跳过
- 凝练：先读势力贡献，≥1700 才执行一次，不连续点击
- 扫荡：只走每日免费次数；收费档（20 紫晶卡/次）跳过

## 未完成 / 未验证

- 第 6、7 章已全部通关；第 8 章 8-1 实测战败（2026-10-02 16:26，战败页 BATTLE_DEFEAT）——斗气 53246 / 27 级低于该关推荐战力，需先变强（心火淬炼 / 斗者培养 / 招募 / 装备）再继续
- 关卡列表随通关累积滚动，靠后关卡的「挑战」需要先滚动再 OCR（滚动步骤尚未进任务卡）
- 等级提升后的「等级礼包」付费弹窗会插进流程并吞点击；已用 forbiddenTexts 挡住付费入口，但自动关掉该弹窗的动作尚未进任务卡
- 已实测：自动连战的终止条件包含「战败即停」（2026-10-02 16:02 连战停止；16:26 adventure-challenge 命中 BATTLE_DEFEAT 后按 stopWhenState 立即停手，不再空转到次数上限）；次数上限/弹层中断仍未单独验证
- 战败后的处置只做到如实上报 + 立即停手（BATTLE_DEFEAT + 不点付费变强入口），自动"变强"路径未实现
- 历练·日常修行的「扫荡」入口不在关卡列表页（列表页只有「战斗」与播放按钮）：training-hub-fight 已能读到「今日免费扫荡：N次」（regex 需容忍繁体 免費）并走到训练页，但扫荡按钮定位仍缺证据，该任务当前判失败
- 领奖弹窗是美术字、OCR 不稳定（恭喜获得→「義喜获得 / 2蠡喜获釋」，点击任意位置关闭→「关美闭」）：已建模 REWARD_POPUP（子串锚点 喜获 / 点击任意位置关）并允许 UNKNOWN 时先归位一次，但单帧判断仍可能漏检（16:21 / 16:25 实测首帧命中、复帧漏检）
- 快速修炼每日首次免费已用完：quick-train-free 被守卫正确拒绝（GUARD_RULE_TEXT_ONLY，出现 50 紫晶卡消耗即停），未发生付费
- 18:9 与 19.5:9+ 分辨率分组未实测，坐标契约只声明 16:9@1080x1920 已验证
- 纳戒的装备 / 专属 / 斗技 / 异火四祭坛，以及势力的道场 / 双盟竞逐 / 势力试炼 / 界域争锋未进入
- 结算奖励队列的完整层数与顺序未完全枚举，关层仍依赖「底部空白区」经验规则

## 注意

- marker 只在任务判据（verify）通过后发出；`RESULT.ok=false` 或判据未通过都代表业务未完成。
- partial / blocked 任务只生成占位模块，运行返回 NOT_READY 并带 missingEvidence，不会执行任何动作。
