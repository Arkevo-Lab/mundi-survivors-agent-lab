export const LINK_REPORT_SCHEMA = 'mundi-link-calibration-v1';

function fromNetworkControl(report, rows, {lineId, endpoint, collector, connectionKey, route}) {
  if (!Array.isArray(rows) || rows.length > 100) throw Error('链路报告的样本列表无效');
  return {
    schema: LINK_REPORT_SCHEMA, line_id: lineId, endpoint, measured_at: report.recorded_at,
    method: 'GET', metric: 'warm-https-total-ms', expected_http_status: 401, collector, route,
    samples: rows.map(row => ({ms: row?.total_ms, http_status: row?.status,
      connection: row?.[connectionKey] === 0 ? 'reused' : row?.[connectionKey] > 0 ? 'new' : 'unknown'})),
  };
}

export function importLinkReports(report) {
  if (report?.schema === LINK_REPORT_SCHEMA) return [report];
  if (report?.authenticated !== false) throw Error('请导入无凭证 HTTPS 对照采样报告');
  if (typeof report.endpoint === 'string' && Array.isArray(report.rows)) {
    return [fromNetworkControl(report, report.rows, {lineId: 'OpenAI · Node 代理线路', endpoint: report.endpoint,
      collector: 'node-connection-diagnostics', connectionKey: 'connections', route: 'proxy'})];
  }
  if (report.records && report.proxy === false) {
    return ['dashscope', 'ark'].flatMap(name => {
      const record = report.records[name];
      return record ? [fromNetworkControl(report, record.rows, {lineId: name + ' · 本机直连', endpoint: record.url,
        collector: 'node-connection-diagnostics', connectionKey: 'new_connections', route: 'direct'})] : [];
    });
  }
  throw Error('无法识别链路采样报告');
}
