/** 把散落的核对事项整理成疑点清单：必须处理的在前，相同提示合并计数。 */
export function groupIssues(
  issues: { path: string; message: string; severity?: string }[],
  warnings: string[],
) {
  const groups = new Map<string, { message: string; error: boolean; count: number }>();
  const add = (message: string, error: boolean) => {
    const group = groups.get(message);
    if (group) {
      group.count++;
      group.error ||= error;
    } else groups.set(message, { message, error, count: 1 });
  };
  for (const issue of issues)
    if (issue.path !== 'products.optional') add(issue.message, issue.severity === 'error');
  for (const warning of warnings) if (!groups.has(warning)) add(warning, false);
  return [...groups.values()].sort((a, b) => Number(b.error) - Number(a.error));
}

export default function ReviewIssues({
  issues,
  warnings,
  changes,
}: {
  issues: { path: string; message: string; severity?: string }[];
  warnings: string[];
  changes: { label: string; before?: unknown; after?: unknown }[];
}) {
  const groups = groupIssues(issues, warnings),
    errors = groups.filter((g) => g.error).length;
  if (!groups.length && !changes.length) return null;
  return (
    <details className="oi-issues">
      <summary className={errors ? 'has-errors' : ''}>
        {errors ? '待处理 ' + errors + ' 项' : '疑点 ' + groups.length + ' 项'}
        {changes.length ? ' · 已改 ' + changes.length + ' 处' : ''}
      </summary>
      <div className="oi-review-popover">
        {groups.map((g) => (
          <p key={g.message} className={g.error ? 'oi-bad' : ''}>
            {g.message}
            {g.count > 1 && <small> ×{g.count}</small>}
          </p>
        ))}
        {changes.map((c, i) => (
          <p key={i}>
            <b>{c.label}</b>：{String(c.before || '空')} → {String(c.after || '空')}
          </p>
        ))}
      </div>
    </details>
  );
}
