# 产品资料库第一轮

这是0.1.4的最小领域实现；通用配置默认关闭，各实例须自行验证后显式启用。产品/型号/版本是本轮设计选择，分类、SKU、完整报价模型仍待确认。工具契约见 [CONTRACT](CONTRACT.md)，已执行验证见 [TEST_RESULTS](TEST_RESULTS.md)。

## 最小使用链路

1. 先 crm_health 与工具发现，确认 features.productLibrary 为 true；reader 用 crm_entities 按三类身份查重。同名版本应结合型号和来源核实，不自动合并。相同材料/引文/定位可以支持不同父型号的独立版本，或不同产品的同名型号；提交中必须有明确有效的父归属，同父或缺失父归属时不放宽重复保护。判重会计入同批后续关系，矛盾或错误父类型使事务回滚。
2. crm_ingest 保存原字节，crm_material 复读；材料、来源和哈希复用既有机制。
3. crm_propose/commit 创建 product、product_model、product_version，依次添加 product_has_model、model_has_version，证据均引用材料。可通过 uses_product 将客户/项目指向明确产品对象；这不代表已成交、采用或完成适配。
4. set_product_assertion 区分客户要求 requirement/requested、未知评估 assessment/unknown 或 pending、有复核文字证据的 capability/supported 或 unsupported；后者 reviewed:true 是提交者复核声明，不是自动技术认证。条件、上下文、证据缺失就保留未知/待验证。
5. reader crm_product 回读当前对象、三类断言、历史、原件/证据及关联身份。父子对象只列身份，不继承事实。客户/项目全景可查看直接关联产品。原件更正触及断言时保留 pending，须重新审查。

HTTP POST /api/v1/tools/crm_product、MCP stdio 工具 crm_product、CLI `node src/cli.mjs call crm_product '{"entityId":"<稳定ID>"}'` 调用同一领域。新增产品专属页面有隔离合成预览的历史浏览器验收记录，本次分享整理未重新执行浏览器验收；Twenty 产品投影尚无实现。

## 显式启用门槛与恢复

`createDomain` 和服务配置的 `productLibraryEnabled` 默认 false，必须是布尔值。默认不注册产品查询工具，拒绝产品创建/关系/断言写入，且不应用可选 002。源文件存于 migrations/optional/002_product_entities.sql，仍在已知 checksum 目录中；001 原文件不改。不可把它复制回顶层绕过门槛。

正式进程直接使用工作区源码，监督器可能自动重新启动；默认关闭可以避免这条可选迁移随工作区重启生效。各实例须在隔离恢复验证后按自身授权启用，本文不携带原实例的上线记录。即使库已应用 002，关闭功能也不会删除产品或撤销迁移，仍核验已应用 checksum。

正式启用标准流程：

1. 为正式数据及全部原件创建完整私有备份，验证清单/哈希，在全新目录及独立数据库恢复核验 ID、关系和历史；不要覆盖现有目录或正式库。
2. 在隔离恢复目标显式 productLibraryEnabled:true，启动会在事务中应用 002 并核验 checksum；检查旧数据未变、产品工具和恢复能力。
3. 获准短停及正式迁移后，才在正式配置显式开启、切换服务并读回版本、迁移、原件与关键关系。现有权限不足时停止，不新建或扩展凭据。
4. 回退保留原库及备份，优先恢复到新目标再切换。旧代码不认识 002 应拒绝自动降级；不要删除迁移记录或产品来伪造回退。关闭开关只是隐藏功能，不是撤销数据库升级。

隔离测试运行器为产品及恢复分别创建全新合成库，仅通过现有数据库身份访问；从未使用正式客户数据作为测试材料。`CRM_TEST_REUSE_AUTH=1 npm test` 可复用现有角色令牌于私有本机测试端口，不生成新凭据，结束清理合成库和原件。保留 test/results 小型结果，失败保留现场。

## 可选产品管理页面（2026-11-05，隔离实现）

服务配置的 `productUiEnabled` 必须为显式布尔值，默认关闭。关闭时 `/` 仍返回旧 index.html 原字节，新页面及其导航脚本返回404；旧 public/index.html、app.js、style.css 未改。开启时新进程选择独立 workspace.js 导航包装，提供 `/products` 及独立脚本/样式，不改变旧页面文件。该门槛也防止正式监督器意外重启时自动出现未发布页面。UI 开关与产品库开关独立：可开页面、保持领域关闭并显示“尚未启用”；不会因此执行002。通用默认关闭，不能从源码包推断任何目标实例已经开启。

中文页面可按产品、型号、版本查找与分页，从层级导航到独立详情；查看三类记录、准确引文、材料哈希、原件下载及直接关联。可粘贴原始文字或复用已保存的可读取文字材料，通过有证据的流程新建层级、记录要求/评估/能力、关联已有客户/项目。来源选择每次打开刷新；切换方式、取消关闭与前进后退保留当前标签页草稿及固定对象。能力录入要求明确复核和适用条件，仍不等于服务独立验证真实性。二进制原件继续使用旧材料收件箱/宿主复核入口，本页不假装提取。

保存前校验原文子串及必填项，服务仍复核权限、证据、父关系和重复。双击共享同一提交，失败不清空输入；内容、来源、归属和幂等上下文一经提交即固定。曾有不确定结果时，后续401等失败不能解锁编辑/丢弃，须在另一标签页重新登录，回原页重试核对同一 proposal；不刷新或另建一批。冲突留在原工作台审阅，不从此页自动 owner 覆盖。草稿只在当前标签页内存，无前端长期凭据或客户资料 localStorage。

本页支持新增与回读。名称纠正、已有结论修改及复杂父归属调整仍经现有领域工具审阅，未做无依据的通用 CRUD。只读身份隐藏新增入口，服务继续拒绝伪造写入；会话失效提供真实错误状态。所有数据文本转义，同源请求、CSP、HttpOnly 和 SameSite 继续生效。

### 独立合成预览与停止

```bash
# 新环境使用独立的合成登记目录；全部预览命令使用同一个值：
export CRM_PRODUCT_PREVIEW_ROOT=/ABS/PATH/TO/PRIVATE-SYNTHETIC-PREVIEW
node ops/product-preview.mjs status
# 未运行时才创建新的合成预览，已有预览不会被覆盖：
node ops/product-preview.mjs start
node ops/product-preview.mjs login
# 打开上一命令返回的60秒一次性链接（不要把正式令牌粘到预览中）
node ops/product-preview.mjs stop
```

入口：4325 为 UI+产品库，4326 为 UI开启/产品库关闭，4327 为默认旧入口。三者仅绑定127.0.0.1，各自新建合成数据库/原件目录，只有4325启用002。预览使用私有临时合成认证夹具，无正式HTTP凭据；不创建系统服务、账户、权限或持久访问凭据。预览 Cookie 固定为 `crm_preview_<端口>`，与默认 `crm_session` 及其他预览互不覆盖；读取/设置/退出使用同一实例名称。

本轮实际预览资料为合成产品与客户。`stop` 只核对并终止本轮登记的预览 PID，不操作正式进程，合成资料保留；重新 start 使用全新目标，不覆盖旧库。预览位于 `/tmp`，不是持久运行或正式备份。若当前执行环境不能读取预览 PID 身份，命令明确报错，禁止把未知当已停止。

### 复验与分享边界

全项目 `npm test` 包含产品工作流、领域、HTTP/MCP/CLI 和原件回归，使用独立合成库。当前实测结果及历史 UI 验收范围见 [TEST_RESULTS](TEST_RESULTS.md)。运行结果留在本机 `test/results/`，不随源码包分发，不链接原实例的私有截图或上线证据。

浏览器流程需明确指定新建的空合成预览夹具和本机 Chromium，不允许使用正式库或清空已有资料。具体参数以 `test/product-ui.browser.mjs` 的用法和 [测试说明](TEST_RESULTS.md) 为准；该流程不是生产资料的测试入口，也不证明目标 Windows 或宿主已验收。

```bash
npm run test:ui -- \
  --fixture-root /ABS/PATH/TO/PRIVATE-SYNTHETIC-PREVIEW \
  --browser-executable /ABS/PATH/TO/CHROMIUM
```

也可用 `--playwright-entry /ABS/PATH/TO/playwright/index.mjs` 替代浏览器路径；脚本不自动安装浏览器。登记目录与输出目录必须在源码树外，三个已运行实例需声明 `previewOnly:true`、使用约定合成库与4325/4326/4327端口，产品实例为空且已由预览器植入合成客户/项目。测试不会替你启动、重置或清空实例；截图、profile和报告只写入独立 `ui-results-*` 目录。

### 关闭功能与回退

由实例所有者在获得所需维护授权后，在自己的私有配置中将 `productLibraryEnabled` / `productUiEnabled` 设为 false，并按安装说明重启。关闭开关不会撤销002或删除已保存的产品；保持能识别现有 schema 的兼容代码。

需要恢复历史数据库时，先保留当前完整备份和升级后的增量，向全新目录/库恢复并验证后再切换。不要复制原使用者的备份、配置、令牌或机器专用回滚脚本，也不要通过删除迁移记录来模拟降级。
