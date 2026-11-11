# 第三方依赖与来源

分享包包含Agent CRM的领域代码、Skill、需求、安装与维护说明、合成示例和测试，不含原使用者的数据库、附件、凭据或 `vendor/twenty` 源码树。

## Twenty 独立取得

当前运维与完整备份格式仍依赖Twenty API、worker和独立数据库。省略其源码分发不表示已经实现无Twenty的轻量运行模式；不能只跳过这项依赖就宣称完整安装成功。

接收者从[官方Twenty仓库](https://github.com/twentyhq/twenty)独立取得固定版本。来源与完整性参数记录于[来源清单](../deploy/twenty/source.json)，准备命令及其本地差异说明见[安装说明](INSTALL.md)。准备器只写新目标，不覆盖现有上游目录、运行时或业务数据。网络下载不会提交客户资料。

当前固定官方提交为 `fb8b9cb86c72dd3b1f2da802fec18969fb817a60`，关键依赖及21,152份源码与历史本机基线一致；不携带原有少量AI/provider/Docker改造。固定来源能避免任意追随main漂移，但不能代替从空环境重建验收。当前本机历史构建成功不代表分享版清洁上游已在另一台电脑完整编译运行；准确验证边界见[测试记录](TEST_RESULTS.md)。

## 许可分开处理

Twenty的上游LICENSE包含一般开源部分和另行商业条款，部分文件标有 `@license Enterprise`。本次分享不重分发整棵上游源码，也不携带原朋友项目的AI provider、Docker配置或原凭据修改；接收者自行取得后按实际文件及版本条款判断可用范围。[上游许可证](https://github.com/twentyhq/twenty/blob/main/LICENSE)仅作阅读入口，实际以固定版本取得的文件为准。

本包没有授予企业组件的生产使用、再许可或再分发权，也不宣称整个Twenty免费或统一AGPL/MIT。若要重新打包上游代码，应先逐项核实相应许可及版权通知。

Node依赖通过根 `package-lock.json` 取得，各组件遵守自身许可；Twenty依赖按其固定源中的Yarn锁文件准备。PostgreSQL、Redis、系统库按[运行时说明](../deploy/runtime/README.md)及公开包清单独立准备，并保留其随包版权文件。Docker Desktop若后续使用，应在实际部署时核对适用条件，不从本项目分享授权推定免费。

项目自有代码许可状态见根目录[NOTICE](../NOTICE.md)。外部查询数据的保存/导出权与软件许可证分开核对；SeekingPerson研究方案不等于已取得天眼查账号、数据权益或第三方数据再分发授权。
