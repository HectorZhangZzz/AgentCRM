#!/usr/bin/env node
// Synthetic example only. Generates JSON without reading credentials or connecting to a service.
const materialId = process.argv[2];
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(materialId || '')) {
  process.stderr.write('Usage: node examples/make-proposal.mjs MATERIAL_UUID\n');
  process.exit(2);
}
const evidence = quote => [{ materialId, quote, locator: { kind: 'text' } }];
const ops = [
  { op: 'create_entity', ref: 'customer', type: 'customer', name: '星河实验室', evidence: evidence('客户：星河实验室。') },
  { op: 'create_entity', ref: 'other', type: 'customer', name: '星禾实验室', evidence: evidence('另有一家星禾实验室，两家没有已知关联，不是别名。') },
  { op: 'create_entity', ref: 'samples', type: 'project', name: '南区机房AI Box样品测试', evidence: evidence('星河实验室项目一是南区机房 AI Box 样品测试，先测2台，报价还没有发出。我需要推进报价，具体经办人和期限未定。') },
  { op: 'create_entity', ref: 'display', type: 'project', name: '北区展示屏升级', evidence: evidence('星河实验室项目二是北区展示屏升级，需要8套显示设备，与AI Box样品项目分开推进。') },
  { op: 'create_entity', ref: 'contact', type: 'contact', name: '林某', evidence: evidence('星河实验室的林某负责技术沟通，职务未说明。') },
  { op: 'add_relation', fromId: '$customer', toId: '$samples', kind: 'has_project', evidence: evidence('星河实验室项目一是南区机房 AI Box 样品测试，先测2台，报价还没有发出。我需要推进报价，具体经办人和期限未定。') },
  { op: 'add_relation', fromId: '$customer', toId: '$display', kind: 'has_project', evidence: evidence('星河实验室项目二是北区展示屏升级，需要8套显示设备，与AI Box样品项目分开推进。') },
  { op: 'add_relation', fromId: '$customer', toId: '$contact', kind: 'has_contact', evidence: evidence('星河实验室的林某负责技术沟通，职务未说明。') },
  { op: 'set_fact', entityId: '$samples', key: 'annual_forecast_devices', value: { quantity: 1000, unit: '台', commitment: false }, classification: 'customer_claim', evidence: evidence('客户自述该AI Box项目年度预测可能有1000台，目前没有采购承诺和订单证据。') },
  { op: 'set_fact', entityId: '$samples', key: 'agent_count', value: { min: 40, max: 50, unit: '个智能体' }, classification: 'user_provided', evidence: evidence('讨论的40～50个是智能体数量，不是设备数量。') },
  { op: 'set_fact', entityId: '$display', key: 'requested_quantity', value: { quantity: 8, unit: '套' }, classification: 'user_provided', evidence: evidence('星河实验室项目二是北区展示屏升级，需要8套显示设备，与AI Box样品项目分开推进。') },
  { op: 'upsert_task', taskKey: 'synthetic:star-river:sample-quotation', entityId: '$customer', projectId: '$samples', title: '提供AI Box样品报价', party: 'self', owner: null, dueAt: null, status: 'todo', evidence: evidence('星河实验室项目一是南区机房 AI Box 样品测试，先测2台，报价还没有发出。我需要推进报价，具体经办人和期限未定。') },
  { op: 'upsert_task', taskKey: 'synthetic:star-river:ddr-spec-check', entityId: '$customer', projectId: '$samples', title: 'DDR规格核对', party: 'self', owner: null, dueAt: null, status: 'completed', evidence: evidence('我已完成DDR规格核对事项；这不代表已采购DDR，也没有库存落实依据。') },
  { op: 'upsert_task', taskKey: 'synthetic:star-river:visit', entityId: '$customer', title: '等待确认下次拜访', party: 'waiting', owner: null, dueAt: '2026-10-30T10:00:00+08:00', waitingFor: '客户确认', status: 'awaiting_feedback', evidence: evidence('下次拜访暂定2026-10-30T10:00:00+08:00，等待客户确认。') }
];
process.stdout.write(`${JSON.stringify({ idempotencyKey: `synthetic:star-river:first-visit:${materialId}`, materialIds: [materialId], operations: ops }, null, 2)}\n`);
